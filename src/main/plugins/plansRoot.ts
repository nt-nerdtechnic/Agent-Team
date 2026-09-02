import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

/** The bounded repository-root lookup shared by the Host and Plans package. */
export const MAX_PLANS_ROOT_ASCENT = 6

/**
 * Resolve the repository root that owns a workspace path.
 *
 * Git is the project boundary understood by both Navide and its agents. A
 * workspace outside a repository remains its own root, while a path inside a
 * repository uses the nearest ancestor containing `.git`. The home directory
 * is a deliberate stopping point so a user's dotfiles repository cannot become
 * the root for every unrelated workspace.
 */
export function resolvePlansRootPath(workspacePath: string): string {
  if (!workspacePath) return workspacePath
  let current: string
  try {
    current = realpathSync(resolve(workspacePath))
    if (!statSync(current).isDirectory()) return workspacePath
  } catch {
    return workspacePath
  }

  let home: string | null = null
  try {
    home = realpathSync(homedir())
  } catch {
    // A missing/unreadable home is not a reason to reject an otherwise valid
    // repository root; the ascent bound remains the backstop.
  }

  for (let index = 0; index <= MAX_PLANS_ROOT_ASCENT; index += 1) {
    if (current === home || dirname(current) === current) break
    if (existsSync(resolve(current, '.git'))) return current
    current = dirname(current)
  }
  return workspacePath
}
