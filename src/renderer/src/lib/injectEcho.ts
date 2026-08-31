/**
 * injectEcho.ts
 *
 * Deciding whether injected text actually reached a CLI's input box. We watch
 * the pane's own echo: either the tail of what we sent shows up, or the buffer
 * grows enough that something clearly landed. Getting this wrong is expensive
 * in both directions — a false negative resends the whole prompt (the user
 * sees their instruction twice), a false positive presses Enter on an empty
 * box.
 */

/** Chars of the payload's tail to look for in the echo. Long enough to be
 *  unique, short enough to survive minor TUI re-rendering. */
export const TAIL_MATCH_LEN = 40

/** Buffer growth that counts as "something echoed" when the tail itself cannot
 *  be matched — e.g. a TUI that collapses a big paste into a placeholder. */
export const READY_GROWTH_MIN = 40

/** Strip whitespace *and* box-drawing characters before comparing.
 *
 *  A TUI that wraps our text draws its frame at every line break. Once
 *  whitespace is gone those frame characters sit in the middle of the payload
 *  and break an otherwise exact match — observed with a wrapped Chinese prompt
 *  in Claude Code, which resent the whole instruction because of it. */
export function normalizeForMatch(s: string): string {
  return s.replace(/[\s│┃┆┇┊┋╎╏|─━┄┅┈┉╌╍]+/g, '')
}

/** How we concluded our text landed. `tail` and `placeholder` observe the
 *  payload; `growth` only observes that the buffer changed size, which a
 *  booting TUI does regardless. */
export type EchoEvidence = 'tail' | 'placeholder' | 'growth'

/** How we concluded Enter took. `tail-left` watched our text leave the
 *  composer; `growth` only saw the terminal react. */
export type SubmitEvidence = 'tail-left' | 'growth'

/** Whether a pair of evidences is strong enough to call the injection verified.
 *  Growth-only on either half means we wrote bytes and cannot say where they
 *  went — an honest "unverified", not a success and not a failure. */
export function injectionVerified(
  echo: EchoEvidence | null,
  submit: SubmitEvidence | null,
): boolean {
  return echo !== null && echo !== 'growth' && submit !== null && submit !== 'growth'
}

/** Growth that counts as "echoed" for a payload of this size.
 *
 *  A flat 40 chars is unreachable for a short prompt: a one-line instruction
 *  can normalize to fewer than 40 characters, so the buffer can never grow
 *  that much and the only remaining signal is the tail match. Scale it down
 *  for short payloads, keeping a floor that noise cannot reach. */
export function growthNeededFor(normalizedLength: number): number {
  return Math.min(READY_GROWTH_MIN, Math.max(8, Math.floor(normalizedLength / 2)))
}

/** A TUI that decides a paste is too big to show collapses it to a summary —
 *  "[Pasted text #1 +40 lines]" and its variants — and the payload itself is
 *  never drawn. Recognising that summary is how we tell "the paste landed"
 *  apart from "nothing happened" in the one case where neither of the other
 *  two signals can fire. */
export const PASTE_PLACEHOLDER_RE = /\[pasted?\s+text\b[^\]]*\]/i

/** Chars either side of the grown region to search for the placeholder. The
 *  summary can straddle the boundary when the TUI redraws the composer rather
 *  than appending to it. */
const PLACEHOLDER_MARGIN = 120

/** Has our text landed in the input box? `tail` is the normalized tail of the
 *  payload; `buffer` the pane's current clean scrollback. */
export function echoLanded(
  buffer: string,
  tail: string,
  grownBy: number,
  normalizedLength: number,
): boolean {
  return echoEvidence(buffer, tail, grownBy, normalizedLength) !== null
}

/** What kind of evidence says our text landed — or null when none does.
 *
 *  Same decision as echoLanded, same order, but it does not flatten *how* it
 *  decided. That distinction is load-bearing: `tail` and `placeholder` both
 *  observe the payload itself, while `growth` only observes that the buffer got
 *  bigger. A CLI painting its first screen grows the buffer no matter what
 *  happened to our bytes, so on a freshly spawned pane `growth` is not evidence
 *  at all — it is the absence of evidence, reported as success. Callers that
 *  care (a spawn kickoff) can tell the two apart; callers that just need a
 *  yes/no keep using echoLanded and are unaffected. */
export function echoEvidence(
  buffer: string,
  tail: string,
  grownBy: number,
  normalizedLength: number,
): EchoEvidence | null {
  if (tail && normalizeForMatch(buffer).includes(tail)) return 'tail'
  if (grownBy >= growthNeededFor(normalizedLength)) return 'growth'
  // The collapsed-paste case. Both signals above measure the payload: one
  // looks for it verbatim, the other for enough bytes to account for it — and
  // a collapsed paste produces neither, because the summary is short and
  // fixed-size no matter how long the payload was. So a long message read as
  // "never arrived", was sent again, and again: three copies of one message
  // sat in antigravity's composer while the send reported failure, Enter never
  // pressed. Short messages were unaffected, which is why this looked like a
  // length limit rather than a verification fault.
  //
  // Only a summary inside the region that just grew counts. One left over from
  // an earlier paste would otherwise say "landed" while nothing of ours had,
  // and the Enter that follows would submit whatever the composer was holding.
  if (grownBy <= 0) return null
  return PASTE_PLACEHOLDER_RE.test(buffer.slice(-(grownBy + PLACEHOLDER_MARGIN)))
    ? 'placeholder'
    : null
}

/** Lines at the bottom of the visible screen that hold the input box. Small
 *  on purpose: a TUI redraws the submitted message just ABOVE the composer, so
 *  a generous window keeps matching our tail after a successful submit. */
export const SUBMIT_SCREEN_LINES = 8

/** How long to watch the input box after each Enter before resending it. */
export const SUBMIT_CONFIRM_MS = 2_500

/** Did Enter actually submit? Buffer growth cannot answer this: a TUI with a
 *  spinner or a status footer repaints constantly, so the buffer grows whether
 *  or not the composer was ever emptied — antigravity reported every injected
 *  message as delivered while the text sat unsent in its input box.
 *
 *  When our tail echoed into the composer we have a far better signal: it
 *  LEAVES the composer once submitted. Only when the tail never echoed
 *  verbatim (a TUI that collapses a big paste into a placeholder) do we fall
 *  back to "the terminal reacted at all".
 *
 *  `screen` is the rendered bottom of the visible screen
 *  (useTerminal.readScreenTail), not the raw scrollback. */
export function submitLanded(opts: {
  tailWasOnScreen: boolean
  tail: string
  screen: string
  grownBy: number
}): boolean {
  return submitEvidence(opts) !== null
}

/** What kind of evidence says Enter took — or null when none does.
 *
 *  Same split as echoEvidence: `tail-left` watched our own text leave the
 *  composer, `growth` only saw the terminal react at all. The second is the
 *  documented fallback for TUIs that collapse a paste, and it is exactly as
 *  weak on a booting pane as growth is for the echo. */
export function submitEvidence(opts: {
  tailWasOnScreen: boolean
  tail: string
  screen: string
  grownBy: number
}): SubmitEvidence | null {
  if (opts.tailWasOnScreen && opts.tail) {
    return normalizeForMatch(opts.screen).includes(opts.tail) ? null : 'tail-left'
  }
  return opts.grownBy > 0 ? 'growth' : null
}

/** How long to wait for the echo before concluding the bytes never landed.
 *
 *  Scales with payload size, but the floor is what matters: a CLI that has
 *  just booted needs several seconds to paint its first echo. At a 2.5s floor
 *  a freshly spawned pane resent a short prompt three times before the first
 *  one appeared, so the user saw their instruction three times over. A higher
 *  floor costs nothing in the normal case — the poll breaks out as soon as the
 *  echo shows up. */
export function echoTimeoutFor(textLength: number): number {
  return Math.min(8_000, Math.max(6_000, Math.floor(textLength / 6)))
}
