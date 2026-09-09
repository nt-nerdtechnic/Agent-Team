/** Roll a set of pane statuses up into the ONE status a tally badge is painted
 *  with.
 *
 *  The sidebar's count pills — a workspace's total, a run group's rows — were
 *  neutral grey no matter what the panes under them were doing, so the number
 *  said how many and nothing said whether any of them needed you. The pane rows
 *  right below already answer that with a coloured dot; the heading did not,
 *  which is exactly the row you are looking at when the section is collapsed.
 *
 *  ATTENTION ORDER, not activity order. `rollupTabStatus` answers a different
 *  question — "is anything in this tab moving?" — and deliberately collapses to
 *  two colours. A tally badge is read to decide where to look next, so the
 *  status that wins is the one that most wants a human: a single errored pane
 *  among nine running ones is the thing worth surfacing, and hiding it behind
 *  green would make the colour actively misleading.
 *
 *  Returns `undefined` for an empty set so the caller can leave its badge on
 *  the neutral default rather than inventing a status for "nothing here".
 */
import type { PaneStatusValue } from './paneStatusLabel'

/** Most wants a human first. Everything below `idle` is a pane that has ended
 *  or never started, ordered so the more specific ending outranks the vaguer
 *  one.
 *
 *  'awaiting' outranks even 'error', which is not the obvious order. A pane
 *  asking a question is BLOCKED on the person reading this badge, and stays
 *  blocked — burning the run it is in the middle of — until they answer. A pane
 *  that errored has already stopped; nothing is being wasted while it waits to
 *  be looked at. Sorting by "what is stuck on me right now" rather than by
 *  severity is what makes the tally worth glancing at. */
export const PANE_STATUS_ATTENTION_ORDER: readonly PaneStatusValue[] = [
  'awaiting',
  'error',
  'running',
  'starting',
  'idle',
  'disconnected',
  'stopped',
  'exited',
  'waiting',
]

const RANK: ReadonlyMap<string, number> = new Map(
  PANE_STATUS_ATTENTION_ORDER.map((status, i) => [status, i])
)

/** The status a badge covering `statuses` should be painted with.
 *
 *  Unknown values are skipped rather than repaired: a status written by a newer
 *  build must not drag the badge to a colour this one cannot name. */
export function rollupPaneStatus(
  statuses: readonly string[]
): PaneStatusValue | undefined {
  let best = -1
  for (const status of statuses) {
    const rank = RANK.get(status)
    if (rank === undefined) continue
    if (best < 0 || rank < best) best = rank
  }
  return best < 0 ? undefined : PANE_STATUS_ATTENTION_ORDER[best]
}
