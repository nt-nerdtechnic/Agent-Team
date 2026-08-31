import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

/**
 * Resolve existing symlinks while preserving a non-existent trailing path.
 * A dangling link, symlink loop, or an unreadable ancestor is never treated as
 * a lexical path because a later filesystem operation could escape the grant.
 */
export function resolvePathForContainment(path: string): string | null {
  if (path.includes('\0')) return null
  let current = resolve(path)
  const missingSegments: string[] = []

  while (true) {
    try {
      lstatSync(current)
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') return null
      const parent = dirname(current)
      if (parent === current) return null
      missingSegments.unshift(basename(current))
      current = parent
      continue
    }

    try {
      return missingSegments.length > 0
        ? resolve(realpathSync(current), ...missingSegments)
        : realpathSync(current)
    } catch {
      return null
    }
  }
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/')
}

function isContained(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
}

/** Return whether an absolute or relative candidate remains inside the root. */
export function isWorkspaceContainedPath(workspacePath: string, candidatePath: string): boolean {
  if (candidatePath.includes('\0')) return false
  const root = resolvePathForContainment(workspacePath)
  if (!root) return false
  const candidate = resolvePathForContainment(
    resolve(workspacePath, normalizeSeparators(candidatePath)),
  )
  return candidate !== null && isContained(root, candidate)
}

/**
 * Return the Host-side policy error for a filesystem mutation target. The
 * caller decides which public error code to expose; this helper is shared by
 * the Git contribution bridge and the Host-private Plans bridge.
 */
export function workspaceMutationPathError(
  workspacePath: string,
  candidatePath: unknown,
): string | null {
  if (
    typeof candidatePath !== 'string' ||
    !candidatePath ||
    !isWorkspaceContainedPath(workspacePath, candidatePath)
  ) return 'path escapes the Host workspace binding'

  const root = resolvePathForContainment(workspacePath)
  const candidate = root
    ? resolvePathForContainment(resolve(workspacePath, normalizeSeparators(candidatePath)))
    : null
  if (!root || !candidate) return 'path cannot be safely resolved'

  const relativePath = relative(root, candidate)
  const rootIsGitDirectory = basename(root) === '.git'
  if (rootIsGitDirectory || relativePath.split(sep).some((segment) => segment === '.git')) {
    return 'Git metadata paths are protected'
  }
  return null
}

/** Resolve a root-relative path after canonical containment and symlink checks. */
export function resolveWorkspaceRelativePath(
  rootPath: string,
  relativePath: string,
  allowRoot = true,
): string | null {
  if (relativePath.includes('\0')) return null
  const normalized = normalizeSeparators(relativePath)
  if (isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) return null

  const root = resolvePathForContainment(rootPath)
  if (!root) return null
  const candidate = resolvePathForContainment(resolve(rootPath, normalized))
  if (!candidate || !isContained(root, candidate)) return null

  if (!allowRoot && candidate === root) return null
  return candidate
}

/** Return the canonical existing directory represented by a Host path. */
export function canonicalExistingDirectory(path: string): string | null {
  const canonical = resolvePathForContainment(path)
  if (!canonical) return null
  try {
    const entry = lstatSync(canonical)
    return entry.isDirectory() && !entry.isSymbolicLink() ? canonical : null
  } catch {
    return null
  }
}
