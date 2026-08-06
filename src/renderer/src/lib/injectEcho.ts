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

/** Growth that counts as "echoed" for a payload of this size.
 *
 *  A flat 40 chars is unreachable for a short prompt: a one-line instruction
 *  can normalize to fewer than 40 characters, so the buffer can never grow
 *  that much and the only remaining signal is the tail match. Scale it down
 *  for short payloads, keeping a floor that noise cannot reach. */
export function growthNeededFor(normalizedLength: number): number {
  return Math.min(READY_GROWTH_MIN, Math.max(8, Math.floor(normalizedLength / 2)))
}

/** Has our text landed in the input box? `tail` is the normalized tail of the
 *  payload; `buffer` the pane's current clean scrollback. */
export function echoLanded(
  buffer: string,
  tail: string,
  grownBy: number,
  normalizedLength: number,
): boolean {
  if (tail && normalizeForMatch(buffer).includes(tail)) return true
  return grownBy >= growthNeededFor(normalizedLength)
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
