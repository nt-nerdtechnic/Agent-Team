// Reliable stage-completion judgement for multi-slot stages.
//
// A slot is "finished" only on a *factual* signal — never an LLM guess:
//   • sentinel — the agent printed the stage's done-marker, or
//   • turn_complete — the CLI reported its turn ended (Claude Stop hook = 100%,
//     or JSONL turn-end for Codex/Gemini), captured AFTER the watcher armed so
//     a stale signal from a prior stage/turn is never reused.
//
// These are pure so they can be unit-tested without the App.vue watcher.

export interface SlotSignal {
  /** The stage sentinel was detected in this slot's buffer. */
  sentinelSeen: boolean
  /** Wall-clock ms of the latest turn_complete for this slot's pane (0 = none). */
  turnCompleteAt: number
  /** Wall-clock ms when this slot's watcher armed (start of the current stage). */
  armedAt: number
}

/** True when this slot has produced a reliable finish signal for the current
 *  stage. turn_complete only counts if it landed after the watcher armed. */
export function slotFinished(s: SlotSignal): boolean {
  return s.sentinelSeen || (s.turnCompleteAt > 0 && s.turnCompleteAt > s.armedAt)
}

/** True when every slot in the stage has finished. Empty input is never "done"
 *  (a stage always has ≥1 slot; an empty list means we have no signals yet). */
export function allSlotsFinished(signals: SlotSignal[]): boolean {
  return signals.length > 0 && signals.every(slotFinished)
}

export interface TurnCompleteState {
  /** Wall-clock ms of the latest turn_complete for this pane (0 = none). */
  turnCompleteAt: number
  /** Wall-clock ms of the latest agent_active for this pane (0 = none). */
  lastActiveAt: number
  /** Wall-clock ms when this pane's watcher armed (current stage start). */
  armedAt: number
  /** Now, ms. */
  now: number
  /** How long turn_complete must stay the LATEST signal before it counts, so
   *  the buffer's question text (which can lag the event) has time to render
   *  and be caught by question detection first. */
  settleMs: number
}

/** The CLI-state completion verdict: the turn ended and the CLI is sitting at
 *  the prompt. True only when ALL hold:
 *   • turn_complete landed after the watcher armed (not a stale prior signal),
 *   • it is the LATEST signal — no agent_active came after it (else the CLI is
 *     working again, e.g. revived by an injected handoff/answer),
 *   • it has been the latest signal for at least settleMs (so a turn that ended
 *     to ask a QUESTION is caught as a question first, never as completion). */
export function turnCompleteDone(s: TurnCompleteState): boolean {
  return (
    s.turnCompleteAt > s.armedAt &&
    s.turnCompleteAt >= s.lastActiveAt &&
    s.now - s.turnCompleteAt >= s.settleMs
  )
}

/** The loop auto-continue verdict — STRICTER than turnCompleteDone. On top of a
 *  settled, post-arm, latest turn_complete it also requires that the injected
 *  "continue" prompt actually WOKE the CLI: an agent_active must have landed
 *  after the watcher (re-)armed (lastActiveAt > armedAt). Without this, an
 *  empty-text turn_complete that arrives with NO intervening agent_active —
 *  Claude's Stop hook, a thinking-only record, a vendor's weak turn signal —
 *  re-satisfies turnCompleteDone on every 5s poll, so the loop resends the
 *  continue prompt forever. This guard is loop-only; the done-notification and
 *  pipeline paths keep using turnCompleteDone unchanged. */
export function loopContinueReady(s: TurnCompleteState): boolean {
  return turnCompleteDone(s) && s.lastActiveAt > s.armedAt
}

/** Parse a CLI event timestamp into epoch ms. Accepts ISO-8601 (Claude/Codex
 *  emit their log's ISO timestamp) and a bare epoch-ms string (Kimi emits the
 *  wire.jsonl `time` field). Returns NaN when unparseable. */
export function parseEventMs(timestamp: string): number {
  if (!timestamp) return NaN
  if (/^\d+$/.test(timestamp)) return Number(timestamp)
  return Date.parse(timestamp)
}

/** True when a turn_complete is a stale REPLAY rather than a live turn end: its
 *  own CLI timestamp is far older than now — e.g. the backend re-parsed the
 *  whole log on restart and re-emitted historical turns, or a vendor emits a
 *  weak per-step signal. Guards the notification path so such events never
 *  bubble to a desktop notification. An unparseable/missing timestamp is
 *  treated as live (never suppressed) so a missing field can't mute real ones. */
export function isReplayedTurnComplete(
  timestamp: string,
  now: number,
  toleranceMs: number,
): boolean {
  const eventMs = parseEventMs(timestamp)
  return !Number.isNaN(eventMs) && now - eventMs > toleranceMs
}

/** True when the turn's final non-empty line is exactly the sentinel.
 *  Judged on clean assistant text from the CLI's own conversation log (role-
 *  separated at the source: kickoff echo is a user message and can never
 *  appear here). Mid-text mentions or quoted protocol examples never match —
 *  only a deliberate bare-line sentinel ending the turn counts. */
export function turnEndsWithSentinel(text: string, sentinel: string): boolean {
  if (!text || !sentinel) return false
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    return line === sentinel
  }
  return false
}
