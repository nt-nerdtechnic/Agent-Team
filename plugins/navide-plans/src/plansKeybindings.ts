/**
 * Host keybinding participation for the packaged Plans window.
 *
 * v1's PlanWindowApp called `useKeybindings()` and registered its window-level
 * commands against the Host's shared rule table. The packaged plugin lost that
 * in the migration and hardcoded two keys in a local listener instead, so every
 * other shortcut the rule table routes to this window (⌘⇧W close, ⇧⌘R reload,
 * ⌘W / ESC close-modal) did nothing.
 *
 * `@navide/plugin-ui/shared` is the public plugin subpath that owns the rule
 * table; navide.git composes exactly the same way (GitWindowApp +
 * pluginSurfacePorts). Keeping the composition here rather than in PlansApp.vue
 * matches that layering — the view registers intent, this module owns the wire
 * to the Host surface.
 */
import {
  initKeybindingsPort,
  registerCommand,
  setContext,
  useKeybindings,
  type KeybindingsPort,
} from '@navide/plugin-ui/shared'

/**
 * Persistence port for the resolver.
 *
 * A packaged plugin has no capability that reads the user's keybindings.json —
 * the catalog exposes fs (workspace-scoped), ui, aiCli, shell and storage, none
 * of which reach userData. So the window resolves against the shipped defaults,
 * the same as navide.git's window does.
 */
export function createPlansKeybindingsPort(): KeybindingsPort {
  return {}
}

export interface PlansCommandHandlers {
  /** ⌘P — open the plan quick-open palette. */
  quickOpen(): void
  /**
   * ESC / ⌘W — peel one layer of window state, or close the window.
   *
   * Returning `false` declines the key: the dispatcher then leaves the event
   * alone instead of consuming it, which is how a surface that owns Escape
   * itself (the application dialog) still receives it.
   */
  closeModal(): boolean | undefined
}

/**
 * Install the shared capture-phase dispatcher and register this window's
 * commands. Call from the window surface's setup() only: the left contribution
 * is a panel inside the Host shell, where `planWindow` context and a
 * closeWindow command would be wrong.
 */
export function installPlansKeybindings(handlers: PlansCommandHandlers): void {
  initKeybindingsPort(createPlansKeybindingsPort())
  useKeybindings()
  // Window identity, exactly as v1 declared it: the shipped ESC rule is bound
  // as `planWindow && !terminalFocus`, so without this the key never resolves.
  setContext('planWindow', true)

  registerCommand('workbench.action.quickOpen', () => {
    // Declining (returning false) leaves the event alone, which is how the
    // embedded CLI panel keeps ⌘P for its own PTY.
    if (document.activeElement?.closest('.navide-safe-ai-cli')) return false
    handlers.quickOpen()
    return undefined
  })
  // ⌘⇧W. Plans live on disk and an in-flight section edit is cancelled through
  // ESC, so this window has no unsaved state of its own to guard.
  registerCommand('workbench.action.closeWindow', () => {
    window.close()
  })
  // ⇧⌘R. Same reasoning — a reload costs nothing but an in-progress edit.
  registerCommand('workbench.action.reloadWindow', () => {
    window.location.reload()
  })
  // Forward the return value: a bare block body would swallow the `false` that
  // declines the key, and the dispatcher would consume every Escape.
  registerCommand('workbench.action.closeModal', () => handlers.closeModal())
}
