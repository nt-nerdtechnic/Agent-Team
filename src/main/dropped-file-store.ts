/**
 * Keeps dropped files readable after the drag ends.
 *
 * macOS hands screenshots over from a directory it owns and then reclaims it:
 * screencaptureui writes the capture under
 * `$TMPDIR/TemporaryItems/NSIRD_screencaptureui_*` and MOVES it to its final
 * home when the floating thumbnail fades. Chromium's
 * `webUtils.getPathForFile` reports that source path verbatim, so a path
 * pasted into a CLI pane points at a file that is gone by the time the agent
 * reads it. Terminal.app never shows this because AppKit materializes promised
 * files into a location the receiving app owns.
 *
 * So do what AppKit does: copy anything living under the system temp root into
 * a directory we own, and hand back that path instead. Paths outside temp are
 * already stable and pass through untouched.
 */
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { tmpdir } from 'node:os'

/** Copies older than this are removed on startup. */
export const DROPPED_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Resolves symlinks so `/var/...` and `/private/var/...` compare equal. */
function resolved(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return target
  }
}

/**
 * True when `target` sits inside the system temp root — the files macOS may
 * delete or move out from under us.
 *
 * Compares both the raw and symlink-resolved spelling of each side: on macOS
 * the temp root is `/var/...`, a symlink to `/private/var/...`, and realpath
 * cannot normalize a path that no longer exists. Matching any combination
 * keeps the two spellings equivalent either way.
 */
export function isSystemTempPath(target: string, tempRoot = tmpdir()): boolean {
  const roots = [...new Set([tempRoot, resolved(tempRoot)])]
  const targets = [...new Set([target, resolved(target)])]
  return roots.some((root) => {
    const withSep = root.endsWith('/') ? root : `${root}/`
    return targets.some((t) => t.startsWith(withSep))
  })
}

/** `name.png` → `name-2.png`, `name-2.png` → `name-3.png`. */
function nextCandidate(name: string, attempt: number): string {
  const ext = extname(name)
  return `${name.slice(0, name.length - ext.length)}-${attempt}${ext}`
}

/**
 * Copies `source` into `destDir` under its original basename, suffixing on
 * collision so a second screenshot never overwrites the first.
 */
async function copyIntoStore(source: string, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true })
  const name = basename(source)
  // COPYFILE_EXCL: fail rather than clobber an existing copy, so the retry
  // loop is race-free against a concurrent drop of the same filename.
  for (let attempt = 1; attempt <= 50; attempt++) {
    const dest = join(destDir, attempt === 1 ? name : nextCandidate(name, attempt))
    try {
      await copyFile(source, dest, 1 /* COPYFILE_EXCL */)
      return dest
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error(`could not find a free name for ${name}`)
}

/**
 * Returns `paths` with every system-temp FILE replaced by a copy we own.
 *
 * Directories and paths outside temp pass through unchanged, as does anything
 * we fail to copy — a stale path is no worse than today's behaviour, and
 * losing the drop entirely would be.
 */
export async function stabilizeDroppedPaths(paths: string[], destDir: string): Promise<string[]> {
  return await Promise.all(
    paths.map(async (path) => {
      if (!isSystemTempPath(path)) return path
      try {
        if (!(await stat(path)).isFile()) return path
        return await copyIntoStore(path, destDir)
      } catch {
        return path
      }
    })
  )
}

/** Clipboard image types we will write, mapped to the extension we give them. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/tiff': 'tiff'
}

/**
 * `2026-08-07-20.18.33`. Hyphenated rather than spaced like macOS's own
 * screenshot names: the path gets pasted straight into a CLI prompt, and a
 * name with no spaces needs no quoting for the shell and stays a single
 * recognisable token for an agent scanning the line for a file to read.
 */
function timestampName(now: number): string {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`
}

/**
 * Writes clipboard image bytes to a file an agent can read, returning its path.
 *
 * A screenshot taken with ⌘⇧4 (no file) lives only on the clipboard as pixels,
 * so pasting into a CLI pane has nothing to send — the agent cannot read the
 * clipboard. Landing it in the same store the drag path uses gives the paste
 * something to reference and gets it pruned on the same schedule.
 *
 * Returns null for a media type we do not write, rather than guessing an
 * extension the agent would then fail to decode.
 */
export async function saveClipboardImage(
  bytes: Uint8Array,
  mediaType: string,
  destDir: string,
  now = Date.now()
): Promise<string | null> {
  const ext = IMAGE_EXTENSIONS[mediaType]
  if (!ext || !bytes.length) return null
  await mkdir(destDir, { recursive: true })
  const name = `Pasted-Image-${timestampName(now)}.${ext}`
  for (let attempt = 1; attempt <= 50; attempt++) {
    const dest = join(destDir, attempt === 1 ? name : nextCandidate(name, attempt))
    try {
      // wx: never overwrite, so a second paste in the same second gets its own file.
      await writeFile(dest, bytes, { flag: 'wx' })
      return dest
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  return null
}

/** Drops copies older than `maxAgeMs`; the store is a cache, not a library. */
export async function pruneDroppedFiles(
  destDir: string,
  maxAgeMs = DROPPED_FILE_MAX_AGE_MS,
  now = Date.now()
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(destDir)
  } catch {
    return // never created — nothing to prune
  }
  await Promise.all(
    entries.map(async (name) => {
      const path = join(destDir, name)
      try {
        if (now - (await stat(path)).mtimeMs > maxAgeMs) await rm(path, { force: true })
      } catch {
        // A file that vanished or resists deletion is not worth failing over.
      }
    })
  )
}
