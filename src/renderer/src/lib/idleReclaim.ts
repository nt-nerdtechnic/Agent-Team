/**
 * Whether a CLI pane may have its process reclaimed for memory.
 *
 * An idle CLI never gives back what it allocated — a claude process holds
 * 200-300MB of GPU slabs for as long as it lives, whether or not anyone is
 * talking to it. Reclaiming ends the process and leaves the pane as the same
 * click-to-resume placeholder a restart shows, so the cost is one resume and
 * the saving is the whole process.
 *
 * That trade is only acceptable while the user loses nothing they did not
 * choose to lose, which is what this file decides. It is a pure function over a
 * snapshot so every "no" is testable on its own: the reasons are the interesting
 * part, not the yes.
 */

/** Everything the decision reads, flattened out of App.vue's pane state. */
export interface ReclaimCandidate {
  /** False for a pane that is already a placeholder — nothing to reclaim. */
  realized: boolean
  /** A restore in flight; its process is on the way in, not idle. */
  restoring: boolean
  /** The pane the user is looking at. Reading a long answer is using it. */
  focused: boolean
  /** Empty when the conversation cannot be resumed — then this would be a
   *  permanent close nobody asked for. */
  resumeSessionId: string
  rebuilding: boolean
  loopActive: boolean
  /** Anything other than 'ready' means work the user started is still running. */
  preparationStatus: string
  injectionStatus: string
  spawnReportPending: boolean
  /** False when the pane has no live TerminalPane ref to ask. */
  hasRef: boolean
  /** 'idle' | 'running' | 'awaiting' | … — the pane's own badge state. */
  displayStatus: string
  /** Typed but unsent text. It lives only in the CLI's input line. */
  hasDraft: boolean
  /** Newest of (agent output, user keystroke). 0 when neither ever happened. */
  lastTouchedAt: number
}

/** Why this pane is not reclaimable, or null when it is. */
export type ReclaimBlock =
  | 'not-realized'
  | 'restoring'
  | 'focused'
  | 'no-resume-id'
  | 'rebuilding'
  | 'loop-active'
  | 'preparing'
  | 'injecting'
  | 'spawn-report-pending'
  | 'no-ref'
  | 'not-idle'
  | 'has-draft'
  | 'never-touched'
  | 'too-recent'

export function reclaimBlockedBy(
  pane: ReclaimCandidate,
  thresholdMs: number,
  now: number
): ReclaimBlock | null {
  if (!pane.realized) return 'not-realized'
  if (pane.restoring) return 'restoring'
  if (pane.focused) return 'focused'
  if (!pane.resumeSessionId) return 'no-resume-id'
  if (pane.rebuilding) return 'rebuilding'
  if (pane.loopActive) return 'loop-active'
  if (pane.preparationStatus !== 'ready') return 'preparing'
  if (pane.injectionStatus === 'pending') return 'injecting'
  if (pane.spawnReportPending) return 'spawn-report-pending'
  if (!pane.hasRef) return 'no-ref'
  // 'awaiting' is the CLI holding a question open. That pane is idle by every
  // timing measure and is the single worst one to take away.
  if (pane.displayStatus !== 'idle') return 'not-idle'
  if (pane.hasDraft) return 'has-draft'
  // No signal at all is not evidence of age — leave it alone rather than treat
  // it as infinitely old.
  if (!pane.lastTouchedAt) return 'never-touched'
  if (now - pane.lastTouchedAt < thresholdMs) return 'too-recent'
  return null
}

/** Threshold for a reclaim the user asked for by name.
 *
 *  Every other guard still applies — the focused pane, one awaiting an answer,
 *  one with unsent text and one that cannot be resumed are all still refused.
 *  Only the waiting is skipped, because a person pressing "reclaim now" has
 *  already answered the question the timer exists to answer. */
export const RECLAIM_NOW_THRESHOLD_MS = 0

/** Lower bound on the configured threshold, so a bad stored value cannot turn
 *  the sweep into "reclaim as soon as it stops typing". */
export const IDLE_RECLAIM_MIN_MINUTES = 15
export const IDLE_RECLAIM_DEFAULT_MINUTES = 180

export function idleReclaimThresholdMs(stored: string): number {
  const parsed = Number.parseInt(stored, 10)
  const minutes = Number.isFinite(parsed)
    ? Math.max(parsed, IDLE_RECLAIM_MIN_MINUTES)
    : IDLE_RECLAIM_DEFAULT_MINUTES
  return minutes * 60_000
}
