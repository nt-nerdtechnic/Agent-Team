// Pane-level detection of a CLI announcing it has run out of quota, and of
// when that quota is expected back.
//
// One answer, two readers: the always-on pane health watcher lights the pane's
// badge from it, and the loop schedules its auto-resume from the same verdict
// instead of matching the text a second time. Before this the loop was the
// ONLY reader, so a pane nobody was looping hit the limit invisibly.

import {
  LIMIT_RESET_BUFFER_MS,
  LOOP_ESTIMATE_WINDOW_MS,
  matchSessionLimit,
  parseLimitReset
} from './loopPrompt'
import { exhaustedWindow, usageFor } from '../composables/useUsage'

/** The limit announcement stripped of its reset clock, e.g. a wrapped or
 *  reworded "You've hit your usage limit" with no time attached.
 *
 *  Matching this alone is NOT enough: the same phrase occurs in a CLI's own
 *  assistant text (this very feature was written in a pane that printed it),
 *  and lighting a badge off someone's prose is the failure the login-expired
 *  spec avoids by requiring two co-occurring parts. There is no second part
 *  here, so the second signal comes from outside the buffer — the account's
 *  own `/usage` reading must independently say the quota is spent. The clocked
 *  form (matchSessionLimit) carries its own proof and needs no confirmation. */
export const BARE_LIMIT_RE = /hit your .{0,40}limit/i

/** How long a hit whose reset nothing could resolve stands before the flag is
 *  dropped. Claude's rolling session window is the only figure available to
 *  guess with — the alternative is a badge that sticks for the life of the
 *  pane, which is worse than an estimate the UI already labels as one. */
export const USAGE_LIMIT_UNKNOWN_TTL_MS = LOOP_ESTIMATE_WINDOW_MS

/** True when a standing quota flag should be dropped: its resolved reset has
 *  arrived, or — with no resolved reset — the fallback window has elapsed. */
export function usageLimitDue(at: number, until: number | null, now: number): boolean {
  return now >= (until ?? at + USAGE_LIMIT_UNKNOWN_TTL_MS)
}

export interface UsageLimitHit {
  /** The matched message, whitespace-collapsed. */
  message: string
  /** Epoch ms to resume at (reset + safety buffer), or null when neither
   *  source could resolve a reset time — callers fail open. */
  resumeAt: number | null
}

/** Resume time taken from the account's own `/usage` reading: the spent
 *  window's reset, else the session window's.
 *
 *  This is the FALLBACK, not the preferred source. The panel reading can be a
 *  quarter of an hour old (it costs a whole Claude Code start, so it is read
 *  on a long cooldown), while the message in the pane was printed just now and
 *  states the exact reset. Null when the reading is absent or already past — a
 *  reset in the past would resume straight back into an exhausted quota. */
export function usageResumeAt(
  agentKey: string | undefined | null,
  now: number = Date.now()
): number | null {
  const snap = usageFor(agentKey)
  const window = exhaustedWindow(snap) ?? snap?.windows.find((w) => w.kind === 'session' && !w.expired)
  const at = window?.resetsAt ? Date.parse(window.resetsAt) : NaN
  if (!Number.isFinite(at) || at <= now) return null
  return at + LIMIT_RESET_BUFFER_MS
}

/** Detect a quota-limit announcement in a pane's buffer tail.
 *
 *  Returns null when there is none, or when a clockless phrase was not
 *  corroborated by the account's quota reading. `tail` is matched
 *  whitespace-collapsed, tolerating the TUI hard-wrap a narrow pane inserts
 *  mid-phrase (same normalization as matchSessionLimit / matchLoginExpired). */
export function detectUsageLimit(
  agentKey: string | undefined | null,
  tail: string,
  now: number = Date.now()
): UsageLimitHit | null {
  const clocked = matchSessionLimit(tail)
  if (clocked !== null) {
    return {
      message: clocked,
      resumeAt: parseLimitReset(clocked, now) ?? usageResumeAt(agentKey, now)
    }
  }
  const bare = BARE_LIMIT_RE.exec(tail.replace(/\s+/g, ' '))
  if (!bare || exhaustedWindow(usageFor(agentKey)) === undefined) return null
  return { message: bare[0], resumeAt: usageResumeAt(agentKey, now) }
}
