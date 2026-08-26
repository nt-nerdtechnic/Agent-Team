// Reliable stage-completion judgement for multi-slot stages.
//
// A slot is "finished" only on a *factual* signal — never an LLM guess:
//   • sentinel — the agent printed the stage's done-marker, or
//   • turn_complete — the CLI reported its turn ended (Claude Stop hook = 100%,
//     or a conversation-log turn-end parsed for
//     codex/copilot/aider/kimi/qwen/pi/grok),
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

/** How long a non-zero pending-subagent count may hold the loop back before it
 *  is ignored. The count is maintained by hook events (Task PreToolUse up,
 *  SubagentStop down) and can drift: a subagent killed with its CLI never
 *  reports its stop, leaving the count stuck above zero forever. Failing OPEN
 *  after this window means the worst a drifted count can do is delay the loop,
 *  never silently park it for the rest of the run. */
export const LOOP_SUBAGENT_WAIT_MAX_MS = 20 * 60_000

/** The pane's latest hook-reported background-subagent count, and when it was
 *  reported. `observedAt` is wall-clock ms of the event that carried `pending`
 *  (0 = the pane has never reported one). */
export interface SubagentWaitState {
  pending: number
  observedAt: number
  now: number
}

/** True when the loop must hold its continue: the CLI has background subagents
 *  still running, so its turn ended to WAIT, not because the work is done.
 *
 *  This is the structural half of the spin fix. Such a turn satisfies every
 *  condition loopContinueReady tests — post-arm, latest, settled, and woken —
 *  because the CLI really did end a turn after really being woken. Only the
 *  subagent count reveals that continuing is pointless: the pane is parked on
 *  work the loop cannot see, and injecting "continue" just makes it say "still
 *  waiting" again.
 *
 *  Bounded by LOOP_SUBAGENT_WAIT_MAX_MS so a stale count fails open. */
export function loopWaitingOnSubagents(s: SubagentWaitState): boolean {
  if (s.pending <= 0 || s.observedAt <= 0) return false
  return s.now - s.observedAt < LOOP_SUBAGENT_WAIT_MAX_MS
}

/** True when an `agent_active` event means THIS PANE'S agent is working, and
 *  so should advance the loop's activity clock.
 *
 *  Every hook signal arrives as one of two event types, so `subagent_stop`
 *  rides in as `agent_active` — a subagent finishing usually does mean the main
 *  agent is about to pick its work back up. But it is the SUBAGENT that acted,
 *  and if the main agent stays idle that borrowed timestamp is permanent:
 *  loopContinueReady requires the turn end to be the LATEST signal, so an
 *  activity stamp landing after it can never be overtaken by anything except a
 *  NEW turn — which an idle agent never produces. The loop then stops
 *  continuing forever, silently, and fails CLOSED. loopWaitingOnSubagents
 *  cannot rescue it: what jams is the continue verdict, not the gate.
 *
 *  Only the loop's clock is narrowed by this. The shared activity clock keeps
 *  stamping every event, so delivery gating, the done notification and the
 *  pipeline's stage verdict are untouched. Skipping the stamp is safe in the
 *  other direction too: a main agent that really did resume work announces it
 *  with its own PreToolUse moments later. */
export function activityMeansWorking(detail: string): boolean {
  return detail !== 'hook:subagent_stop'
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

/** How many previous turns a new turn is compared against. Verbatim comparison
 *  only ever looked at the immediately previous turn, so a CLI alternating
 *  between two phrasings (A→B→A→B) read as progress on every single turn. */
export const LOOP_RECENT_TURNS = 4

/** Characters that never take a space beside them in running text: CJK
 *  punctuation, Han, and fullwidth forms. */
const CJK_CLASS = '\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF'
const CJK_WRAP_SPACE = new RegExp(`([${CJK_CLASS}])\\s+(?=[${CJK_CLASS}])`, 'g')

/** Whitespace-collapsed turn text, so a TUI re-wrap of the same sentence
 *  compares equal to its previous rendering.
 *
 *  Collapsing runs to a single space is enough for English, where the wrap
 *  replaced a space that was already there. Chinese has no such space, so a
 *  wrap INSERTS one — "還在等。瀏覽器" wrapped becomes "還在等。 瀏覽器" — and
 *  every repeat judgement built on this text would read the same sentence as a
 *  new one. Whitespace between two CJK characters is therefore dropped
 *  entirely. English spacing is untouched: the rule needs CJK on both sides. */
export function normalizeTurnText(text: string): string {
  return text.replace(/\s+/g, ' ').replace(CJK_WRAP_SPACE, '$1').trim()
}

/** The pane's tool-use signals for the turn just ended.
 *
 *  `toolSignalsSeen` is the self-calibration that makes this judgement safe
 *  across vendors: only claude/qwen/copilot install hooks, so for every other
 *  CLI `toolUsesThisTurn` is permanently 0 and treating that as a stall would
 *  stop healthy loops. A pane only opts in once it has actually produced a
 *  tool signal at least once. */
export interface ToolActivityState {
  /** PreToolUse signals attributed to this pane since the watcher armed. */
  toolUsesThisTurn: number
  /** This pane has produced a tool signal at least once in its lifetime. */
  toolSignalsSeen: boolean
}

/** True when a turn ended without the agent touching a single tool — no file
 *  read, no command run, no edit. On a CLI that reports tool use this is the
 *  sharpest available "the agent only talked" signal, and talking is exactly
 *  what a CLI parked on a background agent does: it restates that it is still
 *  waiting, in fresh words each time, which is why comparing the TEXT could
 *  never catch this spin. */
export function turnUsedNoTools(s: ToolActivityState): boolean {
  return s.toolSignalsSeen && s.toolUsesThisTurn === 0
}

/** True when a completed turn shows real forward motion. False — a "stalled
 *  run" — when the turn was too short to be work, or repeated one of the last
 *  LOOP_RECENT_TURNS answers verbatim.
 *
 *  Comparison stays EXACT on purpose. A fuzzy judgement was tried and dropped:
 *  restating "still waiting" in fresh words and reporting "step 1 done" after
 *  "step 0 done" are indistinguishable by text similarity — the second differs
 *  by one character — so any threshold that caught the spin also stopped
 *  healthy loops. What the spin actually reveals is caught by turnUsedNoTools
 *  and loopWaitingOnSubagents instead, which read facts rather than phrasing.
 *
 *  `prev` accepts a single previous turn (the original signature) or the recent
 *  history; comparing against several is what catches a CLI alternating
 *  between two ways of saying "still waiting". */
export function turnMadeProgress(text: string, prev: string | string[]): boolean {
  const now = normalizeTurnText(text)
  if (now.length < LOOP_MIN_PROGRESS_CHARS) return false
  const history = (Array.isArray(prev) ? prev : [prev]).filter((t) => t !== '')
  return !history.some((old) => now === normalizeTurnText(old))
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
  /** Normalized text of the last LOOP_RECENT_TURNS turns, newest first.
   *  Optional so a caller holding only the original two fields still works. */
  recentTurns?: string[]
}

/** Fold a completed turn into the stall state, judging it on its text and —
 *  when the vendor reports tool use — on whether it touched a tool at all.
 *
 *  Empty text is UNKNOWN to the text judgement, never a stall on its own: only
 *  claude/codex/copilot readers attach the turn's text, so for every other
 *  vendor each turn would otherwise look stalled and stop a perfectly healthy
 *  loop. `tools` is optional for the same reason — a caller that has no tool
 *  signals for this pane simply omits it and nothing changes. */
export function applyTurnProgress(
  state: LoopStallState,
  text: string,
  tools?: ToolActivityState
): LoopStallState {
  const normalized = normalizeTurnText(text)
  // A turn with no text is UNKNOWN to the text judgement, but the tool
  // judgement can still speak: an empty-text turn_complete from a hook vendor
  // that touched no tool is the same do-nothing turn, just unreported.
  const noTools = tools !== undefined && turnUsedNoTools(tools)
  if (!normalized) {
    if (!noTools) return state
    return { ...state, stalledRuns: state.stalledRuns + 1 }
  }
  const history = state.recentTurns ?? (state.lastTurnText ? [state.lastTurnText] : [])
  const progressed = turnMadeProgress(text, history) && !noTools
  return {
    stalledRuns: progressed ? 0 : state.stalledRuns + 1,
    lastTurnText: normalized,
    recentTurns: [normalized, ...history].slice(0, LOOP_RECENT_TURNS),
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
