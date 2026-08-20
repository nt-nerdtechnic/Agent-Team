/** Roll a run-group's per-pane statuses up into the single dot shown on its
 *  StageTabBar tab.
 *
 *  Deliberately two colours plus "nothing to report": the dot answers one
 *  question — is anything in this tab moving? Every finer distinction
 *  (awaiting, error, disconnected) already has a home in the pane badge and
 *  the agent overview, and folding them in here would trade a glanceable
 *  signal for a legend nobody reads.
 *
 *  'starting' counts as active: it means the CLI is booting and about to move,
 *  so the seconds right after a spawn should not read as "nothing happening".
 */
export type TabRunState = 'active' | 'idle' | 'empty'

/** Statuses that mean the pane is doing something on its own. Everything else
 *  — idle, awaiting, stopped, exited, error, disconnected — means it will not
 *  move until someone acts. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['running', 'starting'])

/** Panes that exist in the list but have no terminal yet (cold-restore
 *  placeholders). A tab holding only these has nothing to report. */
const UNREALIZED = 'waiting'

export function rollupTabStatus(statuses: readonly string[]): TabRunState {
  let realized = false
  for (const status of statuses) {
    if (status === UNREALIZED) continue
    realized = true
    if (ACTIVE_STATUSES.has(status)) return 'active'
  }
  return realized ? 'idle' : 'empty'
}

/** The fields a rendered tab is made of. Structural typing keeps this file free
 *  of a Vue import — StageTabBar's TabItem satisfies it. */
interface RenderedTab {
  key: string
  label: string
  count: number
  status: TabRunState
}

/** True when two tab lists would render identically.
 *
 *  The status dot is recomputed every 400 ms with the pane-status snapshot, and
 *  nearly every one of those ticks reports the same thing. Returning the
 *  previous array when nothing changed keeps the tab bar — which is always on
 *  screen — from re-rendering 2.5 times a second for no visible difference. */
export function sameRenderedTabs(a: readonly RenderedTab[], b: readonly RenderedTab[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].key !== b[i].key ||
      a[i].label !== b[i].label ||
      a[i].count !== b[i].count ||
      a[i].status !== b[i].status
    ) {
      return false
    }
  }
  return true
}
