/** Watchdog verdict for a Manager-mode stage.
 *
 *  In Manager mode the per-pane stage watchers are deliberately skipped — the
 *  stage ends when the Manager prints ---STAGE-DONE---, which the router poll
 *  reads out of the Manager pane's buffer. That leaves two ways for the stage
 *  to hang with no signal at all:
 *    • the Manager pane goes away (closed, CLI crash, exit 127): the router
 *      keeps polling an empty buffer forever;
 *    • nothing ever prints the sentinel: the hard cap that backstops normal
 *      stages lives inside the skipped watcher, so it never fires either.
 *
 *  Both are decided here as a pure function so the rule is testable outside
 *  App.vue's <script setup> closure.
 */

export type ManagerStageVerdict = 'ok' | 'manager-gone' | 'timeout'

export interface ManagerStageProbe {
  /** Empty until the Manager pane has been spawned. */
  managerPaneId: string
  /** The Manager pane exists AND is realized (a placeholder is not alive). */
  managerPaneAlive: boolean
  /** When the stage's router poll started (0 = not armed yet). */
  armedAt: number
  now: number
  /** Stage hard cap; <= 0 disables the timeout arm. */
  maxDurationMs: number
}

/** What Full auto does when the stall prompt's grace period expires.
 *
 *  Full auto means "do not ask me", so every branch that ends in waiting has to
 *  be a wait something can still end. One cannot:
 *
 *   • A Manager-mode stage always has at least two slots (a lone slot is never
 *     a commander), so `multiSlot` is always true for one.
 *   • Manager mode skips startStageWatcher for every pane of the stage, and the
 *     early return happens before the pane's arm time is recorded — so each
 *     worker reads back an arm time of "never" and `allSlotsFinished` is
 *     structurally false for a Manager stage.
 *   • With the Manager pane gone, nothing can print the stage sentinel either.
 *
 *  So on 'manager-gone' the gate below can never pass and no signal can arrive:
 *  keeping the stall alive parks the run at state='running' with no prompt on
 *  screen and nobody watching. Force-advancing is the only branch that is still
 *  a decision rather than a hang. (Manual mode keeps waiting — a person is
 *  there, saw the prompt, and chose it.)
 */
export interface FullAutoStallProbe {
  /** Set only when the Manager-mode watchdog raised this stall. */
  managerVerdict?: ManagerStageVerdict
  /** The stage has more than one slot. */
  multiSlot: boolean
  /** Whether every slot has a reliable finish signal. Called at most once, and
   *  not at all when the answer cannot change the outcome — reading it walks
   *  every pane's buffer. */
  slotsFinished: () => boolean
}

export function fullAutoStallAction(
  probe: FullAutoStallProbe
): 'force-advance' | 'keep-waiting' {
  if (probe.managerVerdict === 'manager-gone') return 'force-advance'
  // Single-slot stages keep the original blind force-advance.
  if (!probe.multiSlot) return 'force-advance'
  return probe.slotsFinished() ? 'force-advance' : 'keep-waiting'
}

export function evaluateManagerStage(probe: ManagerStageProbe): ManagerStageVerdict {
  // Not spawned yet — activateStage is still wiring the stage up.
  if (!probe.managerPaneId) return 'ok'
  // Checked before the cap: a missing Manager is the actionable cause, and it
  // is true long before the cap would notice the silence.
  if (!probe.managerPaneAlive) return 'manager-gone'
  if (probe.armedAt > 0 && probe.maxDurationMs > 0 &&
      probe.now - probe.armedAt > probe.maxDurationMs) {
    return 'timeout'
  }
  return 'ok'
}
