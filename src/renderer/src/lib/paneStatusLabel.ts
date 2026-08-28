/** The single source of the words every pane-status surface prints.
 *
 *  The status TYPE union was already shared — AgentOverviewStatus derives from
 *  DisplayStatus rather than restating it — but the LABELS were not, so one
 *  pane could read "RUNNING" in its header, "running" in the sidebar and
 *  "執行中" in the agent overview at the same moment. Each surface had grown
 *  its own rule: the pane badge translated only 'awaiting' and hard-coded
 *  'STOP', the sidebar and the meeting/spotlight strips interpolated the raw
 *  value, and only the overview translated everything.
 *
 *  Every surface now resolves its text through this key, so a new status value
 *  or a reworded label lands in all of them at once.
 */
import type { DisplayStatus } from '@navide/terminal'

/** Every status a pane badge or pane row can carry — DisplayStatus plus the
 *  two the pane itself cannot report: 'waiting' for a cold-restore placeholder
 *  that has no terminal yet, and 'disconnected' for a pane whose backend
 *  session was lost. The widest of the surfaces; narrower ones pass a subset. */
export type PaneStatusValue = DisplayStatus | 'waiting' | 'disconnected'

/** i18n key for a pane status. Kept as a key rather than a resolved string so
 *  callers stay inside their own `$t` / `useI18n` scope. */
export function paneStatusLabelKey(status: PaneStatusValue): string {
  return `paneStatus.${status}`
}
