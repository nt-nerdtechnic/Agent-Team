// How long ago something was, as a unit and a count — never as a sentence.
//
// The device list printed `Last seen 2026-09-05T02:39:47.539Z`, which is a
// machine's answer to a person's question. The obvious fix is a helper that
// returns "8 minutes ago", and that is how the recent-workspace list does it —
// with the words in the code, so a Chinese window reads "8m ago" in English.
//
// So this returns the two things a translation needs and no words at all. The
// caller looks up `time.ago-<unit>` with `count`, which is the only arrangement
// where the phrasing can differ per language (and it does: "8 分鐘前" puts the
// "ago" at the end).

export type RelativeUnit = 'just-now' | 'minutes' | 'hours' | 'days' | 'months'

export interface RelativeTime {
  unit: RelativeUnit
  /** Whole units elapsed. Always 0 for `just-now`, which takes no number. */
  count: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Calendar months vary; this is the unit people mean by "months ago", and the
 *  error is invisible at the scale it is used. */
const MONTH = 30 * DAY

/**
 * `at` and `now` as epoch milliseconds.
 *
 * A timestamp in the future is reported as `just-now` rather than as a negative
 * count: two machines' clocks disagree by seconds routinely, and "last seen in
 * 3 minutes" is a bug report waiting to happen for something that is simply
 * here now.
 */
export function relativeTime(at: number, now: number): RelativeTime {
  const elapsed = now - at
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return { unit: 'just-now', count: 0 }
  if (elapsed < HOUR) return { unit: 'minutes', count: Math.floor(elapsed / MINUTE) }
  if (elapsed < DAY) return { unit: 'hours', count: Math.floor(elapsed / HOUR) }
  if (elapsed < MONTH) return { unit: 'days', count: Math.floor(elapsed / DAY) }
  return { unit: 'months', count: Math.floor(elapsed / MONTH) }
}
