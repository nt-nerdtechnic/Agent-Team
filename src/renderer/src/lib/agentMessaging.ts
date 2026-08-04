// Inter-CLI messaging protocol: marker constants, turn-text parser, delivery
// envelope, and content sanitizing. Pure functions — no DOM, no side effects.
//
// Wire format (bare lines, never inside a fenced code block):
//   ---MSG-START--- to: <target messagingName>
//   <content, any number of lines>
//   ---MSG-END---
//
// Parsing runs on structured turn text (ActivityEvent.text), never on the
// terminal buffer.

export const MSG_START = '---MSG-START---'
export const MSG_END = '---MSG-END---'
export const MSG_ENVELOPE_PREFIX = '[Navide MSG] from:'

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
}

const START_RE = /^---MSG-START---\s*to\s*:\s*(.*?)\s*$/
const END_RE = /^---MSG-END---\s*$/
const FENCE_RE = /^\s*(```|~~~)/
// Any ---UPPER-CASE--- control-marker token, wherever it appears in a line.
const MARKER_TOKEN_RE = /-{3}([A-Z][A-Z0-9-]*)-{3}/g

/**
 * Extract messaging blocks from one turn's assistant text.
 * - Markers must sit on bare lines (no leading whitespace).
 * - Content inside fenced code blocks (``` / ~~~) is ignored.
 * - Tolerant of a missing MSG-END: the block closes at the next MSG-START or
 *   at end of text.
 * - Blocks with an empty target or empty content are dropped.
 */
export function parseMessages(turnText: string): ParsedAgentMessage[] {
  const out: ParsedAgentMessage[] = []
  if (!turnText) return out

  let inFence = false
  let current: { target: string; lines: string[] } | null = null

  const close = (): void => {
    if (!current) return
    const content = current.lines.join('\n').trim()
    if (current.target && content) out.push({ target: current.target, content })
    current = null
  }

  for (const line of turnText.split('\n')) {
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
      current = { target: start[1], lines: [] }
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
 * on a single line so it can never parse as a bare marker.
 */
export function renderSpawnKickoff(task: string, parentName: string): string {
  return (
    `${task}\n\n` +
    `（任務完成後回報方式：輸出裸行區塊 ${MSG_START} to: ${parentName}，下一行起為結果回報，` +
    `最後一行 ${MSG_END}；marker 必須獨立整行且不可放在 code block 內）`
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
 * a single line so it can never parse as a bare marker.
 */
export function renderEnvelope(
  sender: string,
  content: string,
  opts: { includeReplyHint?: boolean } = {},
): string {
  const lines = [`${MSG_ENVELOPE_PREFIX} ${sender}`, sanitizeMessageContent(content)]
  if (opts.includeReplyHint !== false) {
    lines.push(
      `（回覆方式：輸出裸行區塊 ${MSG_START} to: ${sender}，下一行起為訊息內容，` +
        `最後一行 ${MSG_END}；marker 必須獨立整行且不可放在 code block 內）`,
    )
  }
  return lines.join('\n')
}

/** Smallest free `<agentKey>-<n>` name not present in `taken`. */
export function defaultMessagingName(agentKey: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) {
    const name = `${agentKey}-${n}`
    if (!used.has(name)) return name
  }
}

/** How long after the last activity a turn is still believed to be running.
 *  See {@link isTurnInFlight}. */
export const TURN_IN_FLIGHT_MAX_MS = 20_000

/**
 * Whether a pane's CLI is still mid-turn, from its activity timestamps.
 *
 * The direct signal is "activity newer than the last reported turn end". But
 * some vendors' logs carry no end-of-turn record at all (qwen, pi, cursor), so
 * their `lastTurnCompleteAt` never advances and that test alone would latch
 * forever — those panes would stop accepting inter-CLI messages the moment they
 * did any work. Activity is reported per log line while a CLI produces output,
 * so a long enough silence means the turn ended whether or not anyone said so.
 *
 * Vendors that do report turn ends are unaffected: their report moves
 * `lastTurnCompleteAt` past `lastActiveAt` immediately, which settles this
 * before the timeout matters.
 */
export function isTurnInFlight(
  lastActiveAt: number,
  lastTurnCompleteAt: number,
  now: number,
  maxMs: number = TURN_IN_FLIGHT_MAX_MS,
): boolean {
  if (lastActiveAt <= lastTurnCompleteAt) return false
  return now - lastActiveAt < maxMs
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
