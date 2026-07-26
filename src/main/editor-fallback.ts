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

/** Resolve a workspace-relative filepath to an absolute path suitable for
 *  `shell.openPath`. Returns null when the inputs are empty, the resolved path
 *  escapes the workspace (`../` traversal), or the file does not exist on disk
 *  (stale reference) — callers fall back to the unavailable dialog then. */
export function resolveExternalOpenTarget(
  workspacePath: string,
  filepath: string,
  exists: (path: string) => boolean = existsSync
): string | null {
  if (!workspacePath || !filepath) return null
  const root = resolve(workspacePath)
  const candidate = resolve(join(root, filepath))
  if (!candidate.startsWith(root + sep)) return null
  if (!exists(candidate)) return null
  return candidate
}
