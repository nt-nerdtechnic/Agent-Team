import { readdirSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { resolvePathForContainment, resolveWorkspaceRelativePath } from './workspacePathPolicy'

export const PLAN_DOC_DIRS = [
  '.agent-team/plans',
  '.agent-team/reports',
  '.claude/loop-reports',
  '.claude/plans',
  '.cursor/plans',
  'docs/plans',
  'docs/reports',
] as const

export const DOC_SUFFIXES = ['.html', '.plan.md', '.md'] as const

export const MAX_NESTED_ROOT_DEPTH = 2
export const MAX_NESTED_ROOTS = 50
export const MAX_DIRECTORY_ENTRIES = 2000
export const MAX_NESTED_CANDIDATES = 2000
export const TRAVERSAL_SORT_ORDER = 'utf8_bytes_ascending' as const

export const NOISE_SEGMENTS = [
  '.cache',
  '.gradle',
  '.idea',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.pytest_cache',
  '.ruff_cache',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'out',
  'target',
  'venv',
] as const

export function isPlanDocName(name: string): boolean {
  if (typeof name !== 'string' || !name || name.startsWith('_') || name.startsWith('.')) {
    return false
  }
  const lower = name.toLowerCase()
  return DOC_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

/**
 * Traverses the workspace breadth-first to find nested git repositories,
 * bounded by depth, found roots, per-directory entries, and total candidates.
 *
 * Deterministic 4-step sequence per level:
 * 1. Directory candidates only (real directories or valid symlinked directories)
 * 2. Filter hidden entries and noise segments
 * 3. Sort in UTF-8 bytes ascending order
 * 4. Cap at MAX_DIRECTORY_ENTRIES (2000)
 *
 * A genuine `.git` directory marks a repository leaf (no further descent).
 * A candidate directory with a `.git` file is not a root, but descent continues.
 */
function findNestedPlanRoots(workspaceRoot: string): string[] {
  const found: string[] = []
  const frontier: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }]
  let visited = 0
  while (frontier.length > 0 && found.length < MAX_NESTED_ROOTS && visited < MAX_NESTED_CANDIDATES) {
    const { rel: currentRel, depth } = frontier.shift()!
    if (depth >= MAX_NESTED_ROOT_DEPTH) continue
    const currentAbs = currentRel
      ? resolveWorkspaceRelativePath(workspaceRoot, currentRel, false)
      : resolvePathForContainment(workspaceRoot)
    if (!currentAbs) continue

    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(currentAbs, { withFileTypes: true })
    } catch {
      continue
    }

    // 1. Directory candidates only & 2. Filter hidden and noise segments
    const dirCandidates: string[] = []
    for (const entry of entries) {
      const name = entry.name
      if (name.startsWith('.') || (NOISE_SEGMENTS as readonly string[]).includes(name)) {
        continue
      }
      if (entry.isDirectory()) {
        dirCandidates.push(name)
      } else if (entry.isSymbolicLink()) {
        const childRel = currentRel ? `${currentRel}/${name}` : name
        const childAbs = resolveWorkspaceRelativePath(workspaceRoot, childRel, false)
        if (childAbs) {
          try {
            if (statSync(childAbs).isDirectory()) {
              dirCandidates.push(name)
            }
          } catch {}
        }
      }
    }

    // 3. Sort in UTF-8 bytes ascending
    dirCandidates.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))

    // 4. Apply entry cap
    const candidates = dirCandidates.slice(0, MAX_DIRECTORY_ENTRIES)

    for (const name of candidates) {
      if (found.length >= MAX_NESTED_ROOTS || visited >= MAX_NESTED_CANDIDATES) break
      visited++
      const childRel = currentRel ? `${currentRel}/${name}` : name
      const childAbs = resolveWorkspaceRelativePath(workspaceRoot, childRel, false)
      if (!childAbs) continue
      const gitAbs = resolveWorkspaceRelativePath(workspaceRoot, `${childRel}/.git`, false)
      if (gitAbs) {
        try {
          const gitStat = statSync(gitAbs)
          if (gitStat.isDirectory()) {
            found.push(childRel)
            continue // genuine .git directory is a leaf: do not descend
          }
        } catch {}
      }
      frontier.push({ rel: childRel, depth: depth + 1 })
    }
  }
  return found
}

/**
 * Validates whether a relative path represents an allowed plan document within
 * the given workspace root (or bounded nested Git repository root).
 *
 * Requirements:
 * 1. relPath must be relative, non-empty, and free of null bytes.
 *    Raw absolute paths, POSIX root paths, and Windows drive letters are directly rejected.
 * 2. Documents must reside in one of the canonical PLAN_DOC_DIRS, either at top-level
 *    or within a discovered nested Git repository root.
 * 3. Top-level plans in canonical directories return true immediately without nested BFS.
 * 4. Nested repositories are only recognized if present in the bounded BFS discovery allowset.
 * 5. Symlink escapes are strictly prevented using resolveWorkspaceRelativePath().
 */
export function isAllowedPlanDocumentPath(relPath: string, workspaceRoot: string): boolean {
  if (
    typeof relPath !== 'string' ||
    !relPath.trim() ||
    typeof workspaceRoot !== 'string' ||
    !workspaceRoot.trim() ||
    relPath.includes('\0') ||
    workspaceRoot.includes('\0')
  ) {
    return false
  }

  const rawClean = relPath.trim()
  // Directly reject raw absolute paths, POSIX root paths, and Windows drive letters
  if (
    isAbsolute(rawClean) ||
    rawClean.startsWith('/') ||
    rawClean.startsWith('\\') ||
    /^[A-Za-z]:[/\\]/u.test(rawClean)
  ) {
    return false
  }

  // Canonical workspace containment check
  const normalized = rawClean.replace(/\\/g, '/')
  const canonicalDoc = resolveWorkspaceRelativePath(workspaceRoot, normalized, false)
  if (!canonicalDoc) {
    return false
  }

  const segments = normalized.split('/')
  if (segments.length < 2 || segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return false
  }

  const filename = segments[segments.length - 1]
  if (!isPlanDocName(filename)) {
    return false
  }

  const parent = segments.slice(0, -1).join('/')

  // Fast path: top-level canonical Plans directory returns true immediately without triggering nested BFS
  for (const planDir of PLAN_DOC_DIRS) {
    if (parent === planDir) {
      return true
    }
  }

  // Nested repository check: candidate root must be within the bounded BFS allowset
  for (const planDir of PLAN_DOC_DIRS) {
    if (parent.endsWith(`/${planDir}`)) {
      const nestedRoot = parent.slice(0, -(planDir.length + 1))
      if (!nestedRoot) return false
      const nestedSegments = nestedRoot.split('/')
      if (nestedSegments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
        return false
      }

      const allowedRoots = findNestedPlanRoots(workspaceRoot)
      return allowedRoots.includes(nestedRoot)
    }
  }

  return false
}
