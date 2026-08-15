/** Pure path policy shared by manifest references and archive extraction. */

export type ArchivePathKind = 'regular' | 'directory'

const PACKAGE_PATH_RE = /^[A-Za-z0-9._/-]+$/

function canonicalRelativePath(path: string): string | null {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.includes('\\') ||
    /^[a-zA-Z]:/.test(path)
  ) {
    return null
  }

  const segments = path.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return null
  }
  return path
}

/** Return a safe Manifest v2 package-relative file path, or null. */
export function canonicalPackagePath(path: string): string | null {
  const canonical = canonicalRelativePath(path)
  return canonical !== null && PACKAGE_PATH_RE.test(canonical) ? canonical : null
}

/** Return a safe Manifest v2 package-relative HTML path, or null. */
export function canonicalHtmlPath(path: string): string | null {
  const canonical = canonicalPackagePath(path)
  return canonical !== null && canonical.endsWith('.html') ? canonical : null
}

/**
 * Return the canonical archive key, or null when the entry is unsafe.
 * Directory entries may use the ZIP-conventional single trailing slash; the
 * slash is removed from the comparison and extraction key.
 */
export function canonicalArchivePath(path: string, kind: ArchivePathKind): string | null {
  let candidate = path
  if (kind === 'directory' && candidate.endsWith('/')) {
    candidate = candidate.slice(0, -1)
  }
  return canonicalRelativePath(candidate)
}

/**
 * Return the archive key used to detect aliases on case-insensitive filesystems.
 * The original canonical path remains the extraction key; this is only a
 * preflight collision index.
 */
export function portableArchiveCollisionKey(path: string): string | null {
  const segments = path.split('/').map((segment) =>
    segment.normalize('NFC').toLowerCase().replace(/[. ]+$/g, '')
  )
  if (segments.some((segment) => segment.length === 0)) return null
  return segments.join('/')
}
