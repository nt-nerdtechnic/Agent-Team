import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

// Decision logic for what to do when the mini-IDE plugin view is unavailable
// (bundled assets missing/invalid). Kept pure so it is testable without
// Electron: index.ts classifies the open params here, then either hands plain
// file opens to the OS default application or shows the unavailable dialog.

/** How an editor-open request should fall back when the mini-IDE is missing. */
export type EditorOpenKind = 'file' | 'diff' | 'bare'

/** Classify editor-open params: diff/branch-diff opens have no external
 *  equivalent, plain file opens can go to the OS default app, and bare opens
 *  (no filepath, e.g. sidebar-only) have nothing sensible to open. */
export function classifyEditorOpen(params: Record<string, string>): EditorOpenKind {
  if (params.diff_filepath || params.branch_diff_base) return 'diff'
  if (params.filepath) return 'file'
  return 'bare'
}

/** Resolve a root-relative filepath to an absolute path suitable for
 *  `shell.openPath`. The root is the workspace, or `file_ws` (the file's own
 *  root) for an out-of-workspace open — the containment rule is the same
 *  either way. Returns null when the inputs are empty, the resolved path
 *  escapes the root (`../` traversal), or the file does not exist on disk
 *  (stale reference) — callers fall back to the unavailable dialog then. */
export function resolveExternalOpenTarget(
  workspacePath: string,
  filepath: string,
  exists: (path: string) => boolean = existsSync
): string | null {
  if (!workspacePath || !filepath) return null
  const root = resolve(workspacePath)
  // The filesystem root already ends in a separator; appending another would
  // demand a '//' prefix no path ever has, rejecting every file under '/'.
  const prefix = root.endsWith(sep) ? root : root + sep
  const candidate = resolve(join(root, filepath))
  if (!candidate.startsWith(prefix)) return null
  if (!exists(candidate)) return null
  return candidate
}
