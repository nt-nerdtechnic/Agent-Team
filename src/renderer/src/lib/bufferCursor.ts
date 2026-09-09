/**
 * Re-basing absolute positions into a pane's rolling clean buffer.
 *
 * useTerminal keeps `cleanBuffer` at a 128KB cap: once it grows past twice the
 * cap, `bufferTail()` drops the whole front and every index recorded before
 * that now points ~128KB too far into the text. A stage watcher's `scanFrom`
 * or a Manager router's cursor that is not re-based then skips everything
 * between the new buffer start and the stale index — a sentinel that landed in
 * that region is lost for good, and the slot runs to its hard cap instead of
 * completing.
 *
 * The monotonic `cleanBytesSeen` counter is what makes the trim measurable:
 * `appendClean` adds the same characters to the buffer and to that counter in
 * one step, so the difference between two observations says exactly how many
 * characters fell off the front.
 */

export interface BufferObservation {
  /** `cleanBuffer.length` at the moment of observation. */
  len: number
  /** `cleanBytesSeen` — monotonic total of clean characters ever appended. */
  bytesSeen: number
}

/**
 * Characters dropped off the FRONT of the buffer between two observations.
 *
 * Both fields of an observation must be read in the same tick: they are
 * updated together and only together, so a pair read without an `await`
 * between them is always consistent, however stale the coalescing window has
 * made it.
 *
 * A retroactive noise scrub (`recleanBuffer`) shrinks the buffer from the
 * middle rather than the front, and reads here as a front trim of the same
 * size. That direction is the safe one: the cursor moves back and text is
 * re-scanned, never skipped.
 */
export function droppedPrefix(prev: BufferObservation, next: BufferObservation): number {
  const appended = Math.max(0, next.bytesSeen - prev.bytesSeen)
  return Math.max(0, prev.len + appended - next.len)
}

/**
 * Re-base an absolute buffer index after `dropped` characters fell off the
 * front. A cursor that pointed inside the dropped region lands on 0 — the
 * start of what is left, which is the oldest text that has still never been
 * scanned.
 *
 * That clamp is only safe for a cursor whose job is "where did I read up to":
 * re-scanning costs a duplicate detection, skipping loses the signal for good.
 * It is NOT safe for the two positions that exist to say "never scan before
 * here" — a stage watcher's `minScanFrom` and a router's `armedCursors`. Both
 * are floors placed past the kickoff echo, and the echo carries the stage
 * sentinel and the Manager protocol's ---STAGE-DONE--- at line start, so a
 * floor clamped to 0 finishes the stage on the next poll. `dropped` must
 * therefore be a real measured trim: callers re-basing a floor have to refuse
 * to do so when the observation pair did not come from the same live terminal
 * as the anchor (see routerObservationIsReal in App.vue).
 */
export function remapCursor(cursor: number, dropped: number): number {
  if (dropped <= 0) return cursor
  return Math.max(0, cursor - dropped)
}
