// hostShell — privileged OS-shell actions for the mini-IDE tree.
//
// The mini-IDE runs in two hosts. In the main/editor window it is a normal
// renderer and reaches Electron's shell through `window.agentTeam` (preload).
// Inside the plugin WebContentsView there is no `window.agentTeam` at all —
// `src/preload/plugin-preload.ts` deliberately withholds it — so a direct
// `window.agentTeam?.revealPath(...)` there resolves on `undefined` and does
// nothing, silently.
//
// Call sites therefore import from this module instead of touching
// `window.agentTeam`. The plugin build aliases it to `capabilityShell` (see
// vite.mini-ide.config.ts), which routes the same calls through the host
// capability broker — exactly how `useBackend` is swapped for its shim.

/** Show a path in the OS file manager (Finder / Explorer). */
export async function revealPath(target: string): Promise<void> {
  await window.agentTeam?.revealPath(target)
}
