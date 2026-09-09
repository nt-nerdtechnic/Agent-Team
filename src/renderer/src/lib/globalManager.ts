// The pipeline's cross-stage ("global") Manager reference.
//
// Extracted from App.vue so start and resume derive it the SAME way: only
// onPipelineStart used to run this loop, so a resumed run kept
// pipeline.globalManager = null. globalManagerPaneId() then returned null and
// globalManagerRouterScan() bailed on its first line, so every worker's
// ASK/REPORT went unrouted for the whole run — silently, with no log line.
import type { Stage } from '../data/stages'

export interface GlobalManagerRef {
  /** stage id (e.g. "02") that contains the Manager slot. */
  stageId: string
  /** slot label within that stage (e.g. "Planning"). */
  slotLabel: string
}

/** The first stage that declares a commander slot, or null when the pipeline
 *  has no global Manager. First-match wins: a run has one global Manager, and
 *  the earliest stage that names one owns it for the rest of the run. */
export function deriveGlobalManager(stages: Stage[]): GlobalManagerRef | null {
  for (const s of stages) {
    const cmdSlot = s.slots.find((sl) => sl.isCommander)
    if (cmdSlot) return { stageId: s.id, slotLabel: cmdSlot.label }
  }
  return null
}
