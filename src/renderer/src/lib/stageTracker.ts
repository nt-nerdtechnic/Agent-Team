/** Per-stage slot accounting for the pipeline orchestrator.
 *
 *  A stage advances only when every slot it expects has produced a completion
 *  signal. The counter therefore has to shrink when a slot can no longer
 *  produce one at all — its pane was closed, its run-group tab was closed, or
 *  it never spawned because the configured agent no longer exists. Without a
 *  release path `expected` stays at the configured slot count and the stage
 *  waits for a signal that can never arrive (the "waiting for 1 more slot(s)"
 *  silent hang).
 *
 *  Kept as plain functions over a caller-owned Map so the arithmetic is
 *  testable outside App.vue's <script setup> closure.
 */

export interface StageSlotTracker {
  /** How many slots still have to report. Shrinks as slots are released. */
  expected: number
  /** Slot keys that reported completion. */
  done: Set<string>
  /** Slot keys that can never report — released. Kept so a repeated release
   *  cannot decrement `expected` twice, and so a late completion signal from a
   *  released slot is ignored instead of over-counting. */
  released: Set<string>
}

export type StageTrackers = Map<number, StageSlotTracker>

/** A slot key is a pane id when the slot has a pane, or a synthetic
 *  `slot:<label>` when the slot never got one. */
export type SlotKey = string

export type CompleteOutcome =
  | { kind: 'unknown-stage' }
  /** Already counted, or released — nothing changed. */
  | { kind: 'duplicate' }
  | { kind: 'counted'; done: number; expected: number; remaining: number }

export type ReleaseOutcome =
  | { kind: 'unknown-stage' }
  /** The slot already reported completion; its count stands. */
  | { kind: 'already-done' }
  | { kind: 'already-released' }
  | { kind: 'released'; done: number; expected: number; remaining: number }

function remainingOf(tracker: StageSlotTracker): number {
  return Math.max(0, tracker.expected - tracker.done.size)
}

/** (Re)start accounting for a stage. Replaces any previous tracker. */
export function registerStage(
  trackers: StageTrackers,
  stageIndex: number,
  expected: number,
): StageSlotTracker {
  const tracker: StageSlotTracker = {
    expected: Math.max(0, expected),
    done: new Set(),
    released: new Set(),
  }
  trackers.set(stageIndex, tracker)
  return tracker
}

/** Count one slot as finished. */
export function completeSlot(
  trackers: StageTrackers,
  stageIndex: number,
  slotKey: SlotKey,
): CompleteOutcome {
  const tracker = trackers.get(stageIndex)
  if (!tracker) return { kind: 'unknown-stage' }
  // A released slot is no longer part of `expected`; counting a late signal
  // from it would push done.size past expected.
  if (tracker.done.has(slotKey) || tracker.released.has(slotKey)) {
    return { kind: 'duplicate' }
  }
  tracker.done.add(slotKey)
  return {
    kind: 'counted',
    done: tracker.done.size,
    expected: tracker.expected,
    remaining: remainingOf(tracker),
  }
}

/** Drop one slot from `expected` because it can no longer report.
 *  Never drops below the number of slots already counted as done, and never
 *  below zero. */
export function releaseSlot(
  trackers: StageTrackers,
  stageIndex: number,
  slotKey: SlotKey,
): ReleaseOutcome {
  const tracker = trackers.get(stageIndex)
  if (!tracker) return { kind: 'unknown-stage' }
  if (tracker.done.has(slotKey)) return { kind: 'already-done' }
  if (tracker.released.has(slotKey)) return { kind: 'already-released' }
  tracker.released.add(slotKey)
  tracker.expected = Math.max(tracker.done.size, tracker.expected - 1)
  return {
    kind: 'released',
    done: tracker.done.size,
    expected: tracker.expected,
    remaining: remainingOf(tracker),
  }
}

/** How many slots the stage is still waiting for (0 when untracked). */
export function stageRemaining(trackers: StageTrackers, stageIndex: number): number {
  const tracker = trackers.get(stageIndex)
  return tracker ? remainingOf(tracker) : 0
}

/** True when no slot is still expected to report. Note this is also true for a
 *  stage whose every slot was released (expected 0, done 0) — the caller tells
 *  the two apart by looking at `expected`. */
export function isStageDone(trackers: StageTrackers, stageIndex: number): boolean {
  const tracker = trackers.get(stageIndex)
  if (!tracker) return false
  return remainingOf(tracker) === 0
}
