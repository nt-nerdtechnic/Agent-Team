import { join, resolve, sep } from 'node:path'
import type { UpdateStatus } from '../shared/updater'

/**
 * Clearing Electron-owned caches. Kept electron-free so it runs under Vitest;
 * `index.ts` supplies the electron-backed deps (userData path, OS cache dir,
 * session cache clearing, updater download state).
 *
 * Safety model: nothing here deletes a path it has not first resolved and
 * proven to live *strictly inside* an allowed root. User state (Local Storage,
 * Session Storage, Cookies, blob_storage, ...) is never a target — on macOS
 * userData is also the Python backend's data dir, so only the explicitly
 * named cache subdirectories below are ever removed.
 */

export interface ClearElectronCachesOptions {
  chromium: boolean
  updater: boolean
}

export interface ClearElectronCachesResult {
  ok: boolean
  freedBytes: number
  error: string | null
}

/**
 * GPU/shader caches under userData that `session.clearCache()` does not cover.
 * Chromium regenerates these, and it does not hold them open the way it holds
 * `Cache/`, so removing the directories outright is safe.
 */
export const REMOVABLE_CACHE_DIRS = ['GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']

/**
 * Measured but never removed: Chromium keeps open fds on these. They are
 * emptied through `clearCache()` / `clearCodeCaches()` instead.
 */
export const SESSION_MANAGED_CACHE_DIRS = ['Cache', 'Code Cache']

/**
 * Platform-appropriate OS cache root, where electron-updater keeps its
 * download cache. `app.getPath('cache')` is not in this Electron version's
 * typings, so derive it the same way electron-updater does.
 */
export function resolveOsCacheRoot(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Caches')
  if (platform === 'win32') return env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  return env.XDG_CACHE_HOME || join(home, '.cache')
}

export interface StorageCleanupDeps {
  /** `app.getPath('userData')`. */
  userData: string
  /** Platform-appropriate OS cache root (see `resolveOsCacheRoot`). */
  cacheRoot: string
  /** App name candidates used by electron-updater for `<name>-updater`. */
  appNames: string[]
  /** Recursive size in bytes; 0 when the path is missing. */
  dirSize(path: string): number
  /** Recursive delete; no-op when the path is missing. */
  removeDir(path: string): void
  /** Entry names in a directory; empty when the path is missing. */
  listDir(path: string): string[]
  /** `session.defaultSession.clearCache()` + `clearCodeCaches({})`. */
  clearSessionCaches(): Promise<void>
  /** Updater status owning the download cache, or null when it is free. */
  updaterCacheBusyStatus(): UpdateStatus | null
}

/** Session-side cache clearing, narrowed to what this module calls. */
export interface SessionCacheClearer {
  clearCache(): Promise<void>
  clearCodeCaches?(options: { urls?: string[] }): Promise<void>
}

/**
 * Empty the caches Chromium holds open fds on. Both calls are awaited: the
 * `Code Cache/` bytes are part of the before/after measurement, and an
 * unawaited rejection would escape as an unhandled rejection in the main
 * process.
 */
export async function clearSessionCaches(current: SessionCacheClearer): Promise<void> {
  await current.clearCache()
  // Present since Electron 22 but guarded so an older runtime still clears the
  // HTTP cache instead of failing the whole operation.
  if (typeof current.clearCodeCaches === 'function') await current.clearCodeCaches({})
}

/**
 * Resolve `target` and prove it is strictly inside one of `roots`. Equality
 * with a root is refused too — that would delete userData or the whole OS
 * cache directory.
 */
export function assertInsideRoot(target: string, roots: string[]): string {
  const resolved = resolve(target)
  const allowed = roots.some((root) => {
    const base = resolve(root)
    return resolved !== base && resolved.startsWith(base + sep)
  })
  if (!allowed) {
    throw new Error(`Refusing to remove a path outside the allowed roots: ${resolved}`)
  }
  return resolved
}

/**
 * Whether a cache-root entry is an electron-updater download cache — only
 * `<appName>-updater`, which holds nothing but re-downloadable artifacts.
 *
 * appId-namespaced siblings are deliberately excluded: on macOS
 * `<appId>/` is the live CFNetwork HTTP cache (an open SQLite database with
 * `-wal`/`-shm` sidecars — the same hazard that keeps `Cache/` off the rmSync
 * path), and `<appId>.ShipIt/` is Squirrel's install state, which a pending
 * or resumable update still needs.
 */
export function isUpdaterCacheEntry(name: string, appNames: string[]): boolean {
  return appNames.some((appName) => name === `${appName}-updater`)
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Every step is attempted even when an earlier one fails: a directory that is
 * locked (EPERM/EBUSY/EACCES) must not discard the bytes already reclaimed nor
 * skip the directories after it. Failures come back in `errors`, never silent.
 */
async function clearChromiumCaches(
  deps: StorageCleanupDeps
): Promise<{ freedBytes: number; errors: string[] }> {
  const measured = [
    ...SESSION_MANAGED_CACHE_DIRS.map((dir) => join(deps.userData, dir)),
    ...REMOVABLE_CACHE_DIRS.map((dir) => join(deps.userData, dir))
  ]
  const sizeOfAll = (): number => measured.reduce((total, dir) => total + deps.dirSize(dir), 0)

  const errors: string[] = []
  const before = sizeOfAll()
  try {
    await deps.clearSessionCaches()
  } catch (e) {
    errors.push(errorMessage(e))
  }
  for (const dir of REMOVABLE_CACHE_DIRS) {
    try {
      deps.removeDir(assertInsideRoot(join(deps.userData, dir), [deps.userData]))
    } catch (e) {
      errors.push(errorMessage(e))
    }
  }
  return { freedBytes: Math.max(0, before - sizeOfAll()), errors }
}

/** Why the updater cache must survive, per updater status. */
const UPDATER_BUSY_REASON: Record<string, string> = {
  downloading: 'An update download is in progress — the updater cache was left untouched.',
  // "Restart or quit": with install-on-quit enabled a downloaded update is
  // applied when the app closes, so telling the user to restart would name the
  // one action they were trying to avoid.
  downloaded:
    'An update is downloaded and waiting to install — the updater cache was left untouched so the pending install keeps working. Restart or quit the app to apply it, then clear again.',
  installing: 'An update is installing — the updater cache was left untouched.'
}

function clearUpdaterCache(deps: StorageCleanupDeps): number {
  const busy = deps.updaterCacheBusyStatus()
  if (busy) {
    throw new Error(
      UPDATER_BUSY_REASON[busy] ??
        `The updater is busy (${busy}) — the updater cache was left untouched.`
    )
  }
  let freed = 0
  for (const name of deps.listDir(deps.cacheRoot)) {
    if (!isUpdaterCacheEntry(name, deps.appNames)) continue
    const target = assertInsideRoot(join(deps.cacheRoot, name), [deps.cacheRoot])
    const before = deps.dirSize(target)
    deps.removeDir(target)
    freed += Math.max(0, before - deps.dirSize(target))
  }
  return freed
}

/**
 * Clear the requested Electron-owned caches. Never throws: failures land in
 * `error`. `freedBytes` is always measured (before/after), never estimated,
 * and stays accurate even for the parts that did succeed.
 */
export async function clearElectronCaches(
  options: ClearElectronCachesOptions,
  deps: StorageCleanupDeps
): Promise<ClearElectronCachesResult> {
  const errors: string[] = []
  let freedBytes = 0

  if (options.chromium) {
    try {
      const chromium = await clearChromiumCaches(deps)
      freedBytes += chromium.freedBytes
      errors.push(...chromium.errors)
    } catch (e) {
      errors.push(errorMessage(e))
    }
  }

  if (options.updater) {
    try {
      freedBytes += clearUpdaterCache(deps)
    } catch (e) {
      errors.push(errorMessage(e))
    }
  }

  return {
    ok: errors.length === 0,
    freedBytes,
    error: errors.length ? errors.join(' ') : null
  }
}
