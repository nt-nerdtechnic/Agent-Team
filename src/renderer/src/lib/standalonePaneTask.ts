/**
 * standalonePaneTask.ts
 *
 * Settle a freshly spawned standalone pane's CLI startup and inject its task
 * prompt, rolling the pane back on failure. Extracted for App.vue's two
 * external-spawn paths (`ui.pane.create`, `createStandaloneRequestedPane`):
 * both create roleless manual panes, and scheduleInjection early-returns for
 * a roleless pane before its kickoff step, so a kickoffPrompt handed to
 * spawnPane is never injected. The caller must inject the task explicitly
 * instead — mirrors App.vue's dispatchPlanToPane create path. Kept free of
 * App.vue state so it is unit-testable.
 */

export interface StandaloneTaskInjectionDeps {
  selectPane: (paneId: string, opts: { userInitiated: boolean }) => void
  sendSessionMarkerBootstrap: (paneId: string, tag: string) => Promise<boolean>
  dismissStartupDialog: (paneId: string) => Promise<boolean>
  waitForStartupActivity: (paneId: string) => Promise<boolean>
  waitForQuiet: (paneId: string, requiredQuietMs: number, timeoutMs: number) => Promise<void>
  paneAlive: (paneId: string) => boolean
  injectPane: (paneId: string, text: string, logLabel: string, preserveNewlines: boolean) => Promise<boolean>
  onKill: (paneId: string) => Promise<void>
}

/**
 * Settle the pane's CLI startup then inject `task`. An empty task is not an
 * error — it means "open an empty pane", so nothing is injected and the pane
 * is left untouched. On injection failure the pane is killed (rollback) so
 * the caller never leaves behind a CLI with nothing to do.
 */
export async function injectStandaloneTask(
  paneId: string,
  task: string,
  logLabel: string,
  deps: StandaloneTaskInjectionDeps,
): Promise<boolean> {
  if (!task) return true

  deps.selectPane(paneId, { userInitiated: false })
  const bootstrapped = await deps.sendSessionMarkerBootstrap(paneId, `[pane ${paneId.slice(0, 8)}]`)
  if (!bootstrapped) {
    await deps.dismissStartupDialog(paneId)
    await deps.waitForStartupActivity(paneId)
  }
  await deps.waitForQuiet(paneId, 1000, 8000)
  if (!deps.paneAlive(paneId)) {
    await deps.onKill(paneId)
    return false
  }
  const injected = await deps.injectPane(paneId, task, logLabel, true)
  if (!injected) {
    await deps.onKill(paneId)
    return false
  }
  return true
}
