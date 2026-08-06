// Reliable stage-completion judgement for multi-slot stages.
//
// A slot is "finished" only on a *factual* signal — never an LLM guess:
//   • sentinel — the agent printed the stage's done-marker, or
//   • turn_complete — the CLI reported its turn ended (Claude Stop hook = 100%,
//     or a conversation-log turn-end parsed for codex/copilot/aider/kimi),
//     captured AFTER the watcher armed so a stale signal from a prior
//     stage/turn is never reused.
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

/** A turn shorter than this (whitespace-collapsed) is too small to be real
 *  work — "等待中。", "好的，我繼續" — and counts as a stalled run. */
export const LOOP_MIN_PROGRESS_CHARS = 40

/** Delay before the NEXT continue may fire, indexed by how many consecutive
 *  stalled runs preceded it. Index 0 (a productive turn) keeps the original
 *  poll-speed behaviour; each further stall backs off hard so a spinning loop
 *  burns minutes of quota instead of a whole night's. */
export const LOOP_STALL_BACKOFF_MS = [0, 30_000, 120_000, 600_000]

/** Consecutive stalled runs after which the loop stops itself and asks for
 *  attention rather than injecting yet another continue. */
export const LOOP_STALL_LIMIT = 4

/** Hard backstop on continues per loop run — the last line of defence for a
 *  spin the stall detector cannot see (every turn different and long enough,
 *  yet going nowhere). Sized so a genuinely long unattended run never trips it. */
export const LOOP_MAX_CONTINUES = 200

/** Whitespace-collapsed turn text, so a TUI re-wrap of the same sentence
 *  compares equal to its previous rendering. */
export function normalizeTurnText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** True when a completed turn shows real forward motion. False — a "stalled
 *  run" — when the CLI repeated its previous answer verbatim, or answered with
 *  something too short to be work. Both are what a CLI does when it is stuck
 *  waiting on something the loop cannot observe (a background agent, a poll of
 *  its own), and both re-satisfy loopContinueReady on every poll. */
export function turnMadeProgress(text: string, prevText: string): boolean {
  const now = normalizeTurnText(text)
  if (now.length < LOOP_MIN_PROGRESS_CHARS) return false
  return now !== normalizeTurnText(prevText)
}

/** How long to hold off the next continue after `stalledRuns` consecutive
 *  stalled turns (clamped to the last backoff tier). */
export function loopBackoffMs(stalledRuns: number): number {
  if (stalledRuns <= 0) return LOOP_STALL_BACKOFF_MS[0]
  return LOOP_STALL_BACKOFF_MS[Math.min(stalledRuns, LOOP_STALL_BACKOFF_MS.length - 1)]
}

/** The loop watcher's stall bookkeeping — the subset of its state the progress
 *  judgement reads and writes. */
export interface LoopStallState {
  /** Consecutive completed turns that showed no forward motion. */
  stalledRuns: number
  /** Normalized text of the last completed turn (see normalizeTurnText). */
  lastTurnText: string
}

/** Fold a completed turn's text into the stall state.
 *
 *  Empty text is UNKNOWN, never a stall: only claude/codex/copilot readers
 *  attach the turn's text, so for every other vendor each turn would otherwise
 *  look stalled and stop a perfectly healthy loop. Those vendors keep their
 *  previous behaviour and rely on the continue cap alone. */
export function applyTurnProgress(state: LoopStallState, text: string): LoopStallState {
  const normalized = normalizeTurnText(text)
  if (!normalized) return state
  return {
    stalledRuns: turnMadeProgress(text, state.lastTurnText) ? 0 : state.stalledRuns + 1,
    lastTurnText: normalized,
  }
}

/** Whether the loop may inject another continue, or must stop itself.
 *
 *  loopContinueReady cannot see a CLI that is stuck: a turn ending with
 *  "waiting for a background agent" is a genuine post-arm, woken-up turn end,
 *  so every one of its conditions holds and the loop would resend forever.
 *  These two counters are what actually terminates such a spin — the stall
 *  detector for CLIs whose turn text we can read, the continue cap as the
 *  vendor-agnostic backstop. The cap is checked first: it is the harder
 *  guarantee and its message ("hit the continue limit") is the accurate one
 *  when both trip on the same poll. */
export function loopStallVerdict(s: {
  continues: number
  stalledRuns: number
}): 'stop-capped' | 'stop-stalled' | 'ok' {
  if (s.continues >= LOOP_MAX_CONTINUES) return 'stop-capped'
  if (s.stalledRuns >= LOOP_STALL_LIMIT) return 'stop-stalled'
  return 'ok'
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
