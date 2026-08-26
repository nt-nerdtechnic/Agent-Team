// Inter-CLI messaging protocol: marker constants, turn-text parser, delivery
// envelope, and content sanitizing. Pure functions — no DOM, no side effects.
//
// Wire format (bare lines, never inside a fenced code block):
//   ---MSG-START--- to: <target messagingName> [re: <correlationId>]
//   <content, any number of lines>
//   ---MSG-END---
//
// The `to:` field is also accepted on the line directly below a marker that
// sits alone on its own line. Both hints tell agents to keep the two together,
// but "the marker must be a whole line" reads just as easily as "the marker
// gets a line to itself", and a block split that way used to parse as nothing
// at all — see parseMessages().
//
// `re:` is optional and carries back the correlation id the envelope handed
// out, which is what links a reply to the request it answers. Agents that never
// echo it (and every message written before it existed) still parse.
//
// Parsing runs on structured turn text (ActivityEvent.text), never on the
// terminal buffer.

import { AGENT_SPECS } from '@navide/plugin-shell'
import { enUSMessages } from '@navide/ui-foundation'

export const MSG_START = '---MSG-START---'
export const MSG_END = '---MSG-END---'
/** Opening token of everything Navide injects into a pane, whichever form it
 *  takes. See isInjectedMessageText(). */
const MSG_INJECTED_PREFIX = '[Navide MSG]'
export const MSG_ENVELOPE_PREFIX = `${MSG_INJECTED_PREFIX} from:`
/** First line of a delivery-failure notice. Deliberately distinct from
 *  MSG_ENVELOPE_PREFIX: an agent must be able to tell "someone messaged me"
 *  from "my message bounced" by the first line alone. */
export const MSG_NOTICE_PREFIX = `${MSG_INJECTED_PREFIX} delivery failed`
/** First line of a still-held notice. Distinct from the failure prefix because
 *  it reports the opposite state: the message has not gone in and has not been
 *  given up on either. */
export const MSG_STALE_PREFIX = `${MSG_INJECTED_PREFIX} still held`
/** A spawn request that produced no pane. */
export const MSG_SPAWN_FAILED_PREFIX = `${MSG_INJECTED_PREFIX} spawn failed`
/** A spawn request whose pane exists but never received its task. Kept separate
 *  from "failed" because the two call for opposite responses: retrying a failed
 *  spawn is right, retrying this one collides with the pane already open. */
export const MSG_SPAWN_PARTIAL_PREFIX = `${MSG_INJECTED_PREFIX} spawn partial`
/** A turn that opened a message block Navide could not read. Its own prefix
 *  because it reports a failure with no message attached to it: nothing was
 *  queued, so there is nothing to retry or cancel — only a turn to rewrite. */
export const MSG_FORMAT_PREFIX = `${MSG_INJECTED_PREFIX} message not recognized`
/** A spawned pane's turn that ended without the report it was asked for,
 *  forwarded by Navide in its place. Its own prefix because the parent must be
 *  able to tell a stand-in from the child's own words before acting on it. */
export const MSG_FALLBACK_PREFIX = `${MSG_INJECTED_PREFIX} fallback report`

/** True when a turn's text is something Navide injected rather than something
 *  the agent wrote — a CLI reader echoes an injection back as a user record,
 *  and it must never be mistaken for the pane's own content. */
export function isInjectedMessageText(text: string): boolean {
  return text.startsWith(MSG_INJECTED_PREFIX)
}

// Agent-initiated pane spawning (same bare-line wire format):
//   ---SPAWN-START---
//   agent: <agentSpecs key>
//   name: <messagingName for the new pane>
//   task: <task text; everything after `task:` down to SPAWN-END is the task>
//   ---SPAWN-END---
export const SPAWN_START = '---SPAWN-START---'
export const SPAWN_END = '---SPAWN-END---'

export interface ParsedAgentMessage {
  /** Raw target messagingName from the `to:` field (trimmed). */
  target: string
  /** Message body, trimmed. */
  content: string
  /** Correlation id from the optional `re:` field, identifying the message this
   *  one answers. Absent when the sender wrote no `re:` — the original format,
   *  which stays a plain unrelated message. */
  replyTo?: string
}

// `re:` is split off the target lazily, and only when whitespace precedes it, so
// a handle that merely contains "re" keeps its whole name as the target.
const START_RE = /^---MSG-START---\s*to\s*:\s*(.*?)(?:\s+re\s*:\s*(\S+))?\s*$/
/** The marker alone on its line — the `to:` field is then read from the line
 *  directly below it. */
const START_BARE_RE = /^---MSG-START---\s*$/
/** A `to:` field standing on its own line. Only ever applied to the line
 *  directly after a bare marker, so a message body that happens to open with
 *  "to: someone" keeps that line as content. */
const TO_LINE_RE = /^\s*to\s*:\s*(.*?)(?:\s+re\s*:\s*(\S+))?\s*$/
/** Any line that opens a message block, in either accepted form. Used to tell
 *  "wrote nothing" apart from "wrote something unreadable". */
const START_ANY_RE = /^---MSG-START---/
const END_RE = /^---MSG-END---\s*$/
const FENCE_RE = /^\s*(```|~~~)/
// Any ---UPPER-CASE--- control-marker token, wherever it appears in a line.
const MARKER_TOKEN_RE = /-{3}([A-Z][A-Z0-9-]*)-{3}/g

/**
 * Extract messaging blocks from one turn's assistant text.
 * - Markers must sit on bare lines (no leading whitespace).
 * - `to:` may share the marker's line or stand on the line directly below it.
 * - Content inside fenced code blocks (``` / ~~~) is ignored.
 * - Tolerant of a missing MSG-END: the block closes at the next MSG-START or
 *   at end of text.
 * - Blocks with an empty target or empty content are dropped.
 */
export function parseMessages(turnText: string): ParsedAgentMessage[] {
  const out: ParsedAgentMessage[] = []
  if (!turnText) return out

  let inFence = false
  let current: {
    target: string
    replyTo?: string
    lines: string[]
    /** Set on a bare marker: the next line is read as the `to:` field rather
     *  than as content, whatever it turns out to be. */
    awaitingTo?: boolean
  } | null = null

  const close = (): void => {
    if (!current) return
    const content = current.lines.join('\n').trim()
    if (current.target && content) {
      const parsed: ParsedAgentMessage = { target: current.target, content }
      if (current.replyTo) parsed.replyTo = current.replyTo
      out.push(parsed)
    }
    current = null
  }

  for (const line of turnText.split('\n')) {
    // Ahead of the fence check: this line is the bare marker's `to:` field, and
    // it is claimed on position alone. A block that opens and never names a
    // target keeps target '' and close() drops it, exactly as a malformed
    // same-line marker always has.
    if (current?.awaitingTo) {
      current.awaitingTo = false
      const to = TO_LINE_RE.exec(line)
      if (to) {
        current.target = to[1].trim()
        if (to[2]) current.replyTo = to[2]
        continue
      }
      // Not a `to:` line — fall through so it is still read as content, or as
      // whatever marker it turns out to be.
    }
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      if (current) current.lines.push(line)
      continue
    }
    if (inFence) {
      if (current) current.lines.push(line)
      continue
    }
    const start = START_RE.exec(line)
    if (start) {
      close()
      current = { target: start[1], replyTo: start[2], lines: [] }
      continue
    }
    if (START_BARE_RE.test(line)) {
      close()
      current = { target: '', lines: [], awaitingTo: true }
      continue
    }
    if (current) {
      if (END_RE.test(line)) close()
      else current.lines.push(line)
    }
  }
  close()
  return out
}

/**
 * Whether a turn opened a message block on a bare line outside any fence.
 *
 * Paired with an empty parseMessages() result it identifies the one failure
 * this protocol cannot otherwise report: the agent wrote a block, no block came
 * out, and because nothing was ever queued there is no log row, no failure
 * notice, and no symptom on either side — the sender believes it replied and
 * the recipient simply never hears back. Callers turn the pair into a notice
 * aimed at the only party that can fix it.
 *
 * Deliberately looser than the parser (a leading marker token is enough): the
 * point is to catch shapes the parser rejects, including ones not yet known.
 */
export function hasUnparsedMessageAttempt(turnText: string): boolean {
  if (!turnText) return false
  let inFence = false
  for (const line of turnText.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence && START_ANY_RE.test(line)) return true
  }
  return false
}

/** Notice text for {@link hasUnparsedMessageAttempt}: what was wrong and the
 *  one shape that always works. No excerpt of the attempt — it would carry the
 *  broken markers back into a pane that is about to write markers again. */
export function renderFormatNotice(): string {
  return (
    `${MSG_FORMAT_PREFIX} — 這個 turn 出現了 ${MSG_START}，但沒有解析出任何訊息，` +
    `因此沒有送出、也沒有排進佇列。正確格式：第一行 ${MSG_START} to: <對方名稱>，` +
    `下一行起為內容，最後一行 ${MSG_END}；三行都要頂格，不可縮排，也不可放進 code block。`
  )
}

export interface ParsedSpawnRequest {
  /** Raw `agent:` field (trimmed); '' when the field is missing. */
  agent: string
  /** Raw `name:` field (trimmed); '' when the field is missing. */
  name: string
  /** Task text from `task:` down to the block end (trimmed); '' when missing. */
  task: string
}

const SPAWN_START_RE = /^---SPAWN-START---\s*$/
const SPAWN_END_RE = /^---SPAWN-END---\s*$/
const SPAWN_FIELD_RE = /^(agent|name|task)\s*:\s*(.*)$/

/**
 * Extract spawn-request blocks from one turn's assistant text. Same line
 * discipline as parseMessages: bare-line markers, fenced code ignored,
 * tolerant of a missing SPAWN-END. Blocks keep whatever fields they carry
 * ('' when absent) so the caller can report the specific validation failure
 * back to the requesting agent instead of dropping the block silently.
 */
export function parseSpawns(turnText: string): ParsedSpawnRequest[] {
  const out: ParsedSpawnRequest[] = []
  if (!turnText) return out

  let inFence = false
  let current: { agent: string; name: string; taskLines: string[] | null } | null = null

  const close = (): void => {
    if (!current) return
    out.push({
      agent: current.agent.trim(),
      name: current.name.trim(),
      task: (current.taskLines ?? []).join('\n').trim(),
    })
    current = null
  }

  for (const line of turnText.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      if (current?.taskLines) current.taskLines.push(line)
      continue
    }
    if (inFence) {
      if (current?.taskLines) current.taskLines.push(line)
      continue
    }
    if (SPAWN_START_RE.test(line)) {
      close()
      current = { agent: '', name: '', taskLines: null }
      continue
    }
    if (!current) continue
    if (SPAWN_END_RE.test(line)) {
      close()
      continue
    }
    if (current.taskLines) {
      current.taskLines.push(line)
      continue
    }
    const field = SPAWN_FIELD_RE.exec(line)
    if (field) {
      if (field[1] === 'agent') current.agent = field[2]
      else if (field[1] === 'name') current.name = field[2]
      else current.taskLines = [field[2]]
    }
  }
  close()
  return out
}

/**
 * Kickoff prompt for a SPAWN-created pane: the task followed by a report-back
 * instruction pointing at the parent's messaging name. The instruction stays
 * on a single line so it can never parse as a bare marker, and it spells out
 * that `to:` shares the marker's line — writing it on the next line is the one
 * mistake that makes the whole block vanish without a trace.
 */
export function renderSpawnKickoff(task: string, parentName: string): string {
  return (
    `${task}\n\n` +
    `（任務完成後回報方式：第一行完整寫成 ${MSG_START} to: ${parentName}，下一行起為結果回報，` +
    `最後一行寫 ${MSG_END}；to: 必須與 ${MSG_START} 同一行，不可換行；` +
    `三行都要頂格，不可縮排，也不可放進 code block）`
  )
}

/**
 * Break every ---MARKER--- token in forwarded content with zero-width spaces
 * so the delivered text can never re-trigger message/sentinel/router parsers
 * (theirs are not all line-anchored).
 */
export function sanitizeMessageContent(content: string): string {
  return content.replace(MARKER_TOKEN_RE, '-\u200B--$1-\u200B--')
}

/**
 * Wrap a message for injection into the target pane. The reply hint stays on
 * a single line so it can never parse as a bare marker, and it states outright
 * that `to:` belongs on the marker's own line: START_RE only matches the two
 * together, so a reply that breaks them apart is dropped silently — no queue
 * entry, no failure notice, nothing for either side to see.
 *
 * `correlationId` is asked back verbatim in the reply's `re:` field, which is
 * what lets the reply be matched to this message instead of arriving as an
 * unrelated one. Omitting it renders exactly the pre-correlation hint.
 */
export function renderEnvelope(
  sender: string,
  content: string,
  opts: { includeReplyHint?: boolean; correlationId?: string } = {},
): string {
  const lines = [`${MSG_ENVELOPE_PREFIX} ${sender}`, sanitizeMessageContent(content)]
  if (opts.includeReplyHint !== false) {
    const head = opts.correlationId
      ? `to: ${sender} re: ${opts.correlationId}`
      : `to: ${sender}`
    const echo = opts.correlationId ? 're 欄位請原樣帶回，' : ''
    lines.push(
      `（回覆方式：第一行完整寫成 ${MSG_START} ${head}，下一行起為訊息內容，` +
        `最後一行寫 ${MSG_END}；to: 必須與 ${MSG_START} 同一行，不可換行；` +
        `${echo}三行都要頂格，不可縮排，也不可放進 code block）`,
    )
  }
  return lines.join('\n')
}

/** How much of the bounced message a failure notice quotes back, counted in
 *  code points so the cut cannot split a surrogate pair (an emoji, or anything
 *  outside the BMP) into an unpaired half. */
const NOTICE_EXCERPT_CHARS = 80

/**
 * English sentence for a `msg.reason-*` key, read from the en-US locale so what
 * an agent is told cannot drift from what the Messages panel shows. Agents are
 * always told in English — the panel localizes for the user separately. An
 * unknown key degrades to the key itself rather than to nothing.
 */
export function reasonToEnglish(key: string, params?: Record<string, string | number>): string {
  return enUsSentence(`reason-${key}`, key, params)
}

/** English sentence for a `msg.hold-*` key — why a message has not gone out
 *  yet — read from the same locale, for the same reason. */
export function holdToEnglish(key: string, params?: Record<string, string | number>): string {
  return enUsSentence(`hold-${key}`, key, params)
}

function enUsSentence(
  localeKey: string,
  fallback: string,
  params?: Record<string, string | number>,
): string {
  const template = (enUSMessages.msg as Record<string, string>)[localeKey]
  if (!template) return fallback
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params?.[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * Notice injected back into the SENDING pane when its message could not be
 * delivered, so an agent that talks over the bare-line protocol learns of a
 * failure it would otherwise only see in the user's Messages panel.
 *
 * The excerpt is collapsed to a single line and sanitized: it is the sender's
 * own text coming back, and it must not re-trigger any marker parser.
 */
export function renderFailureNotice(to: string, reasonText: string, content: string): string {
  const excerpt = Array.from(content.replace(/\s+/g, ' ').trim())
    .slice(0, NOTICE_EXCERPT_CHARS)
    .join('')
  return (
    `${MSG_NOTICE_PREFIX} — to: ${to}\n` +
    `reason: ${reasonText}\n` +
    `（原訊息開頭：${sanitizeMessageContent(excerpt)}）`
  )
}

/**
 * Notice injected back into the SENDING pane when its message has been queued
 * long enough to be worth looking at, and has still neither gone in nor failed.
 *
 * Deliberately not a failure: nothing has given up on the message, and it will
 * still be delivered when the target frees up. What it buys the sender is the
 * chance to decide — wait, ask someone else, or tell the user — instead of
 * assuming the work was handed over minutes ago.
 */
export function renderStaleNotice(
  to: string,
  holdText: string,
  minutes: number,
  content: string,
): string {
  const excerpt = Array.from(content.replace(/\s+/g, ' ').trim())
    .slice(0, NOTICE_EXCERPT_CHARS)
    .join('')
  return (
    `${MSG_STALE_PREFIX} — to: ${to}\n` +
    `reason: ${holdText} — waiting ${minutes} min so far\n` +
    `（原訊息開頭：${sanitizeMessageContent(excerpt)}）`
  )
}

/**
 * Notice injected back into the REQUESTING pane about a spawn it asked for.
 *
 * Same shape and same delivery path as a failure notice: a leading prefix that
 * says what happened, and nothing that invites a reply. `detail` is collapsed
 * onto the prefix line and sanitized, so the whole notice is one unambiguous
 * line even when it carries an exception message.
 */
export function renderSpawnNotice(outcome: 'failed' | 'partial', detail: string): string {
  const prefix = outcome === 'failed' ? MSG_SPAWN_FAILED_PREFIX : MSG_SPAWN_PARTIAL_PREFIX
  return `${prefix} — ${sanitizeMessageContent(detail.replace(/\s+/g, ' ').trim())}`
}

/** How much of a turn a fallback report carries back, counted in code points so
 *  the cut cannot split a surrogate pair. The tail is kept rather than the
 *  head: a turn that was going to be a report ends with its conclusion. */
const FALLBACK_REPORT_CHARS = 1200

/**
 * Stand-in report for a spawned pane whose turn ended without a message block.
 *
 * The parent was promised a report it can wait for, and until now the only
 * thing standing between that promise and silence was the child agent
 * remembering a wire format — miss the marker and the parent waits forever with
 * nothing to see. This degrades that into a delivered message the parent can
 * read and judge, labelled so it is never mistaken for the child's own report.
 *
 * Returns '' when the turn carried nothing worth forwarding, which is the
 * caller's signal to send nothing at all.
 */
export function renderFallbackReport(turnText: string): string {
  const body = sanitizeMessageContent(turnText.trim())
  if (!body) return ''
  const points = Array.from(body)
  const tail =
    points.length > FALLBACK_REPORT_CHARS
      ? `…${points.slice(points.length - FALLBACK_REPORT_CHARS).join('')}`
      : body
  return (
    `${MSG_FALLBACK_PREFIX} — 這個 pane 的 turn 結束時沒有輸出 ${MSG_START} 區塊，` +
    `以下是它這個 turn 的最後輸出，由 Navide 代為轉交，不是它自己寫的回報：\n\n${tail}`
  )
}

/** Smallest free `<agentKey>-<n>` name not present in `taken`. */
export function defaultMessagingName(agentKey: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) {
    const name = `${agentKey}-${n}`
    if (!used.has(name)) return name
  }
}

/** How long a silence must last before a turn is assumed over, for the vendors
 *  where silence is the only available signal. See {@link isTurnInFlight}. */
export const TURN_SILENCE_MS = 20_000

/** CLIs whose reported turn end cannot be trusted as a boundary, because their
 *  logs carry no end-of-turn record and the reader synthesizes one from its own
 *  quiet window. They do emit `turn_complete` — the question is what it is made
 *  of, not whether it arrives. Each vendor declares this itself — see
 *  `turnEndInferredFromSilence` in agents/types.ts for why the default (trust
 *  the explicit turn-end record) must never be overridden lightly. */
export const VENDORS_WITHOUT_TURN_END: ReadonlySet<string> = new Set(
  AGENT_SPECS.filter((s) => s.turnEndInferredFromSilence).map((s) => s.agentKey)
)

/**
 * Whether a pane's CLI is still mid-turn, from its activity timestamps.
 *
 * The signal is "activity newer than the last reported turn end". For the
 * vendors in {@link VENDORS_WITHOUT_TURN_END} that signal is unreliable: their
 * `lastTurnCompleteAt` only advances once their reader's own quiet window has
 * elapsed, so it can lag arbitrarily far behind the activity it should close —
 * those panes would stop accepting inter-CLI messages while they sit idle — so
 * there, and only there, a long enough silence is taken to mean the turn ended.
 */
export function isTurnInFlight(
  lastActiveAt: number,
  lastTurnCompleteAt: number,
  now: number,
  opts: { inferEndFromSilence?: boolean; silenceMs?: number } = {},
): boolean {
  if (lastActiveAt <= lastTurnCompleteAt) return false
  if (!opts.inferEndFromSilence) return true
  return now - lastActiveAt < (opts.silenceMs ?? TURN_SILENCE_MS)
}

/**
 * True when a `to:` target names another workspace (`<folder>/<pane>` or
 * `/abs/path/<pane>`). Bare names stay workspace-local, which is the original
 * single-window behaviour.
 */
export function isQualifiedTarget(to: string): boolean {
  return to.trim().includes('/')
}

/** A usable messagingName: non-empty, single line. Returns trimmed name or null. */
export function normalizeMessagingName(raw: string): string | null {
  const name = raw.trim()
  if (!name || name.includes('\n')) return null
  return name
}

/** How long a pane's push channel is left alone after a push failed to land,
 *  so a channel that is declared but broken costs one attempt per minute
 *  instead of one per pump tick. */
export const PUSH_COOLDOWN_MS = 60_000

/** The same, for a CLI whose server simply is not listening yet. That is what a
 *  pane looks like for the first seconds of its life, and it fixes itself — so
 *  it is worth a handful of quick retries rather than a minute's silence. */
export const PUSH_RETRY_COOLDOWN_MS = 5_000

/** Failures that say "not yet" rather than "not working". */
const PUSH_RETRYABLE_REASONS = new Set(['not-listening'])

/** How long to leave a pane's channel alone after a push came back `reason`.
 *  An unrecognized reason takes the long cooldown: the short one exists for the
 *  single case known to fix itself, and guessing wrong there costs a pane a
 *  retry every few seconds for as long as its channel stays broken. */
export function pushCooldownMs(reason: string): number {
  return PUSH_RETRYABLE_REASONS.has(reason) ? PUSH_RETRY_COOLDOWN_MS : PUSH_COOLDOWN_MS
}

/** `base` if free in `taken`, else the first free suffixed variant. A base
 *  already ending in `-<n>` bumps that counter (`X-2` → `X-3`, never `X-2-2`),
 *  and a run of identical counters (`X-2-2-2`, persisted by the old compounding
 *  bug) collapses to one before matching. Used to honour a requested handle
 *  (a pane's title) while keeping addresses unique. */
export function uniqueMessagingName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const collapsed = base.replace(/(-\d+)\1+$/, '$1')
  if (!used.has(collapsed)) return collapsed
  const m = /^(.*)-(\d+)$/.exec(collapsed)
  const root = m ? m[1] : collapsed
  for (let n = m ? Number(m[2]) + 1 : 2; ; n++) {
    const candidate = `${root}-${n}`
    if (!used.has(candidate)) return candidate
  }
}
