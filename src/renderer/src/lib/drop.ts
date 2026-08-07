/**
 * Extracts native file-system paths from a DragEvent.
 *
 * Uses window.agentTeam.getPathForFile (bridged via Electron preload with
 * webUtils.getPathForFile) because File.path is only available in Electron's
 * main world; the renderer runs in the isolated world with contextIsolation:true.
 *
 * Prefers dt.items over dt.files because folders are reliably surfaced via
 * items.getAsFile() in Electron even when dt.files is empty.
 */
export function extractDropPaths(e: DragEvent): string[] {
  const dt = e.dataTransfer
  if (!dt) return []
  const getPath = window.agentTeam?.getPathForFile
  if (!getPath) return []

  const sources: File[] = dt.items?.length
    ? Array.from(dt.items)
        .filter(i => i.kind === 'file')
        .map(i => i.getAsFile())
        .filter((f): f is File => f !== null)
    : Array.from(dt.files)

  if (sources.length) return sources.map(f => getPath(f)).filter(Boolean)

  // Fallback: paths set via dataTransfer.setData('text/plain', ...) by in-app drags
  const text = dt.getData('text/plain')
  return text ? text.split('\n').map(p => p.trim()).filter(Boolean) : []
}

/**
 * Replaces paths that macOS is about to reclaim with copies Navide owns.
 *
 * A screenshot dragged from the floating thumbnail resolves to a path under
 * the system temp root, and macOS moves that file to its real home once the
 * thumbnail fades — so a CLI reading the pasted path seconds later reports the
 * file as missing. Main copies those into userData; everything else passes
 * through. Falls back to the raw paths whenever the bridge is unavailable or
 * returns an unusable answer, since a stale path beats dropping the paste.
 *
 * Call this with the result of a synchronous extractDropPaths() — the
 * DragEvent's dataTransfer is unreadable once the handler awaits.
 */
export async function stabilizeDroppedPaths(paths: string[]): Promise<string[]> {
  if (!paths.length) return paths
  const stabilize = window.agentTeam?.stabilizeDroppedPaths
  if (!stabilize) return paths
  try {
    const res = await stabilize(paths)
    return res?.ok && res.paths?.length === paths.length ? res.paths : paths
  } catch {
    return paths
  }
}

/** Shell-escape a path so it can be safely pasted into a PTY command line. */
export function shellEscape(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`
}
