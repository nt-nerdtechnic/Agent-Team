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
import { i18n } from '@navide/plugin-ui/foundation'
import type { DisplayStatus } from '@navide/terminal'

import { statusBadgeLabelOverride } from '../composables/useStatusBadgePrefs'

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

/** The word to print for a status: the user's own, if they renamed it, else the
 *  translation.
 *
 *  Surfaces call this instead of `$t(paneStatusLabelKey(s))` so a rename lands
 *  on all of them at once — the same reason the key was centralised here in the
 *  first place. It reads `i18n.global` directly rather than a component's `t`,
 *  which is what lets a plain function serve template, computed and non-component
 *  callers alike; both the override ref and `i18n.global.locale` are reactive, so
 *  a computed that calls this still re-evaluates when either changes.
 */
export function paneStatusLabelText(status: PaneStatusValue): string {
  const override = statusBadgeLabelOverride(status, i18n.global.locale.value)
  return override || i18n.global.t(paneStatusLabelKey(status))
}
