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

export { shellEscape } from '@navide/plugin-shell'

/**
 * Escapes a dropped path the way Terminal.app does — backslashes before shell
 * metacharacters, no surrounding quotes.
 *
 * Quoting the whole path (shellEscape) is equally correct for the shell, but a
 * CLI agent scanning the line for a file to read does not recognise a quoted
 * path: dropping a screenshot then leaves a literal `'…/Screenshot.png'`
 * string instead of an image attachment. Terminal.app's unquoted form is
 * understood by both, so drops use this and command construction (which builds
 * a real argv) keeps shellEscape.
 *
 * Non-ASCII is left alone, matching Terminal.app: CJK filenames and the narrow
 * no-break space macOS puts in screenshot names are not shell metacharacters.
 */
export function escapeDraggedPath(p: string): string {
  return p.replace(/[^A-Za-z0-9/._\-+,:@%=\u0080-\uFFFF]/g, '\\$&')
}
