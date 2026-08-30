// capabilityShell — the plugin-side implementation of `hostShell`.
//
// A plugin view has no `window.agentTeam`; its only host surface is
// `window.nav`. The `ui` namespace the mini-IDE manifest already requires
// carries the shell actions, so each call here is one broker round-trip
// (`frontendPluginManager` maps `ui.reveal_path` to shell.showItemInFolder).
//
// The mini-IDE build aliases `composables/hostShell` to this module, so the
// shared components (ExplorerPane, EditorWindowApp) work unchanged in both
// hosts. Keep the exported signatures identical to hostShell's.

/** Show a path in the OS file manager, via the host capability broker. */
export async function revealPath(target: string): Promise<void> {
  await window.nav?.callCapability?.('ui', 'reveal_path', { path: target })
}
