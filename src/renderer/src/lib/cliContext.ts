// Reply builder for the main window's cli:get-pane-buffer responder (see the
// onCliPaneBufferRequest registration in App.vue). Pure so the lookup → reply
// mapping is unit-testable without mounting App.vue.

import { bufferTail } from './buffer'

/** MIME type set by TerminalPane's header dragstart (drag source). */
export const CLI_CONTEXT_MIME = 'application/x-cli-context'
/** MIME type carrying a bare pane id. Set (as an inline literal) by pane
 *  reorder drag sources: TerminalPane's header and ControlPane's agent list. */
export const PANE_ID_MIME = 'application/x-pane-id'
/** MIME type carrying every pane id a multi-select drag moves, newline-separated
 *  in pane order. Only set when the drag carries more than one pane, so its mere
 *  presence marks a batch drag — and since TYPES are readable during dragover,
 *  drop targets can style themselves for a batch before the payload is legible.
 *  Travels with the drag, so a drop in ANOTHER window sees the same batch. */
export const PANE_BATCH_MIME = 'application/x-pane-batch'
/** Tail cap applied to the pane buffer before pasting it into another pane's
 *  input prompt. Much smaller than the chip cap: a 128KB blob is unusable as
 *  CLI prompt input. */
export const CLI_PASTE_BUFFER_CAP = 8000
/** Line caps applied when reading a pane's RENDERED scrollback (the source for
 *  both shares — see TerminalPane's readRenderedText). Applied first; the char
 *  caps above then bound the result. */
export const CLI_PASTE_LINE_CAP = 300
export const CLI_CHIP_LINE_CAP = 1000

/** True when the text left of the cursor ends with a bare "@" — the user already
 *  typed the mention sigil, so the pane drop completes it instead of adding a
 *  second one. Strict: the "@" must sit immediately before the cursor, so "@ "
 *  (space typed after) is treated as ordinary text.
 *  Accepts the full-width "＠" (U+FF20) a CJK IME emits, not just ASCII "@". */
export function endsWithMentionTrigger(lineBeforeCursor: string): boolean {
  return lineBeforeCursor.endsWith('@') || lineBeforeCursor.endsWith('＠')
}

/** Which gesture a pane drop belongs to: true means "insert the source pane's
 *  address", false means "share the source pane's scrollback".
 *
 *  A typed "@" is what selects mention mode, and that is the whole rule. Both
 *  gestures land on the same drop target, so without this precondition the
 *  mention path answers every drop and the context share becomes unreachable —
 *  exactly the regression this function exists to make visible. An unreadable
 *  prompt (undefined) is not a mention: never splice an address into a prompt
 *  whose contents are unknown. */
export function shouldMentionOnDrop(lineBeforeCursor: string | undefined): boolean {
  return lineBeforeCursor !== undefined && endsWithMentionTrigger(lineBeforeCursor)
}

/** Text a pane drop inserts at the target's cursor: always just the source
 *  pane's mention, e.g. "傳給 " + drop → "傳給 @codex-1 ". An "@" the user
 *  already typed is completed rather than doubled, and a separating space is
 *  added only when the prompt does not already end in whitespace.
 *  `lineBeforeCursor` is undefined when the prompt could not be read. */
export function buildMentionInsert(
  lineBeforeCursor: string | undefined,
  address: string
): string {
  const line = lineBeforeCursor ?? ''
  if (endsWithMentionTrigger(line)) return `${address} `
  const gap = line === '' || /\s$/.test(line) ? '' : ' '
  return `${gap}@${address} `
}

/** True when typing `ch` (the just-typed char) at end of `lineBeforeCursor`
 *  should open the mention menu: ch is '@' or '＠', and the text before it is
 *  empty or ends with whitespace (so "a@b" mid-word does NOT trigger). */
export function shouldOpenMentionMenu(ch: string, lineBeforeCursor: string): boolean {
  return (ch === '@' || ch === '＠') && (lineBeforeCursor === '' || /\s$/.test(lineBeforeCursor))
}

/** Drag payload carried under CLI_CONTEXT_MIME (set in TerminalPane.vue). */
export interface CliContextPayload {
  paneId: string
  agentKey?: string
  label?: string
  sessionId?: string | null
  sessionHomeId?: string
  workspacePath?: string
  conversationLogPath?: string
}

/** Write the canonical payload shared by every CLI-pane drag source. Keeping
 *  this in one place prevents auxiliary layout cards from silently losing the
 *  rich context carried by TerminalPane headers. */
export function writeCliPaneDragPayload(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  payload: CliContextPayload,
  batchIds?: readonly string[]
): void {
  dataTransfer.setData(PANE_ID_MIME, payload.paneId)
  dataTransfer.setData(CLI_CONTEXT_MIME, JSON.stringify(payload))
  // A one-pane "batch" is just a normal drag — writing the MIME anyway would
  // make every drop target announce a batch it isn't handling.
  if (batchIds && batchIds.length > 1) {
    dataTransfer.setData(PANE_BATCH_MIME, batchIds.join('\n'))
  }
}

/** Parse the batch MIME written by `writeCliPaneDragPayload`. Empty for an
 *  absent or blank payload — i.e. a single-pane drag. */
export function parsePaneDragBatch(raw: string): string[] {
  return raw
    .split('\n')
    .map((id) => id.trim())
    .filter(Boolean)
}

/** Vendor-neutral reference to a live CLI conversation. The append-only
 *  `.agent-team` log is the cross-vendor transcript contract; session fields
 *  additionally identify the vendor-native record when one is available. */
export interface CliSessionContext extends CliContextPayload {}

/** Parse the CLI-context drag payload. Returns null for malformed JSON or a
 *  payload without a usable paneId. */
export function parseCliContextPayload(raw: string): CliContextPayload | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  if (typeof rec.paneId !== 'string' || !rec.paneId) return null
  return {
    paneId: rec.paneId,
    agentKey: typeof rec.agentKey === 'string' && rec.agentKey ? rec.agentKey : undefined,
    label: typeof rec.label === 'string' && rec.label ? rec.label : undefined,
    sessionId: typeof rec.sessionId === 'string' && rec.sessionId ? rec.sessionId : null,
    sessionHomeId: typeof rec.sessionHomeId === 'string' && rec.sessionHomeId ? rec.sessionHomeId : undefined,
    workspacePath: typeof rec.workspacePath === 'string' && rec.workspacePath ? rec.workspacePath : undefined,
    conversationLogPath: typeof rec.conversationLogPath === 'string' && rec.conversationLogPath
      ? rec.conversationLogPath
      : undefined
  }
}

/** Decide the CLI drop payload from the two drag-MIME strings.
 *  - cliRaw present → parse it; malformed → 'malformed' (caller surfaces it)
 *  - cliRaw absent but paneIdRaw present → minimal synthesized payload (the
 *    pane-buffer IPC reply fills in label/sessionId)
 *  - neither → null (not a CLI-pane drop) */
function resolveCliDropPayload(
  cliRaw: string,
  paneIdRaw: string
): CliContextPayload | 'malformed' | null {
  if (cliRaw) return parseCliContextPayload(cliRaw) ?? 'malformed'
  if (paneIdRaw) return { paneId: paneIdRaw, agentKey: '', label: '', sessionId: null }
  return null
}

/** Resolve the SOURCE pane id of a CLI-pane drag dropped on a terminal area.
 *  Returns null for a self-drop (silent no-op), a malformed payload, or a drag
 *  that carries no pane identity at all. */
export function resolveCliDropSource(
  cliRaw: string,
  paneIdRaw: string,
  targetPaneId: string
): string | null {
  const payload = resolveCliDropPayload(cliRaw, paneIdRaw)
  if (!payload || payload === 'malformed') return null
  return payload.paneId === targetPaneId ? null : payload.paneId
}

/** Every SOURCE pane a CLI-pane drag should share, in the order the batch was
 *  dragged in. A batch drag shares all of its panes (minus the drop target
 *  itself, which cannot share with itself); a plain drag keeps the single-source
 *  behaviour of `resolveCliDropSource`. Works for cross-window drops too — the
 *  batch rides in the drag payload rather than in the source window's state. */
export function resolveCliDropSources(
  cliRaw: string,
  paneIdRaw: string,
  batchRaw: string,
  targetPaneId: string
): string[] {
  const batch = parsePaneDragBatch(batchRaw)
  if (batch.length > 1) return batch.filter((id) => id !== targetPaneId)
  const single = resolveCliDropSource(cliRaw, paneIdRaw, targetPaneId)
  return single ? [single] : []
}

/** Build the text pasted into the TARGET pane's input prompt when a CLI pane is
 *  dropped onto it: a header line identifying the source pane, then a tail
 *  excerpt of its cleaned buffer. Returns null when there is nothing to share.
 *  Pure so it is unit-testable without mounting App.vue. */
function referenceLine(key: string, value: string | null | undefined): string | null {
  return value ? `${key}: ${JSON.stringify(value)}` : null
}

/** Machine-readable session reference shared by CLI prompts and AI Chat chips. */
export function buildCliSessionReference(context: CliSessionContext): string {
  return [
    referenceLine('source_pane_id', context.paneId),
    referenceLine('source_name', context.label),
    referenceLine('source_agent', context.agentKey),
    referenceLine('source_workspace', context.workspacePath),
    referenceLine('source_session_id', context.sessionId),
    referenceLine('source_session_home_id', context.sessionHomeId),
    referenceLine('conversation_log', context.conversationLogPath)
  ].filter((line): line is string => !!line).join('\n')
}

export function buildPaneContextPaste(context: CliSessionContext, buffer: string): string | null {
  if (!buffer.trim() && !context.conversationLogPath && !context.sessionId) return null
  // Keep the durable transcript reference AND the rendered terminal excerpt.
  // The path lets the receiving agent read the complete log, while the inline
  // excerpt gives it useful context immediately without an extra tool call.
  const tail = bufferTail(buffer, CLI_PASTE_BUFFER_CAP).trim()
  const who = context.agentKey
    ? `${context.label || 'pane'} (${context.agentKey})`
    : context.label || 'pane'
  const truncated = tail.length < buffer.trim().length
  const scope = truncated ? ` — last ${CLI_PASTE_BUFFER_CAP} chars` : ''
  const reference = buildCliSessionReference(context)
  const logHint = context.conversationLogPath
    ? 'The recent rendered context is included below. For the complete conversation, read conversation_log with a read-only file command.'
    : 'The excerpt below is the available conversation context.'
  const excerpt = tail
    ? `\n--- recent terminal excerpt${scope} ---\n${tail}\n--- end recent terminal excerpt ---`
    : ''
  return `--- CLI session context: ${who} ---\n${reference}\n${logHint}${excerpt}\n--- end CLI session context ---`
}

/** Build the paste text for an EXTERNAL (cross-window) pane drop from the
 *  pane-buffer relay reply. The reply is authoritative — the source pane lives
 *  in another window, so there is no local pane record to read. An error reply
 *  yields null (the caller surfaces the failure). */
export function buildExternalPaneContextPaste(
  paneId: string,
  reply: {
    label?: string
    agentKey?: string
    sessionId?: string | null
    sessionHomeId?: string
    workspacePath?: string
    conversationLogPath?: string
    buffer?: string
    error?: string
  }
): string | null {
  if (reply.error) return null
  return buildPaneContextPaste(
    {
      paneId,
      agentKey: reply.agentKey || undefined,
      label: reply.label || undefined,
      sessionId: reply.sessionId || null,
      sessionHomeId: reply.sessionHomeId || undefined,
      workspacePath: reply.workspacePath || undefined,
      conversationLogPath: reply.conversationLogPath || undefined
    },
    reply.buffer ?? ''
  )
}

/** Split text into chunks of at most `size` UTF-16 code units WITHOUT cutting a
 *  surrogate pair in half — a split mid-codepoint reaches the PTY as two broken
 *  halves and garbles the paste (emoji / non-BMP CJK). */
export function chunkForPty(text: string, size: number): string[] {
  const chunks: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + size, text.length)
    // A high surrogate at the last position of the chunk owns the low surrogate
    // that follows — keep the pair together by ending one code unit earlier.
    if (end < text.length) {
      const code = text.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end--
    }
    chunks.push(text.slice(i, end))
    i = end
  }
  return chunks
}

// PTY-friendly paste: these wrap injected text so a modern CLI TUI accepts it
// as one paste rather than as a stream of keypresses. Shared by App.vue's
// injectText / pastePaneContext and by injectionChunks below, so there is one
// spelling of the guards in the injection path.
export const BRACKETED_PASTE_START = '\x1b[200~'
export const BRACKETED_PASTE_END = '\x1b[201~'

/** Split an injection payload into PTY writes.
 *
 *  The bracketed-paste guards are emitted as their own chunks and never merged
 *  into the content: a CLI that receives half of `ESC[200~` prints the rest as
 *  literal text and never enters paste mode, which is exactly what a size-based
 *  split of the wrapped string would eventually do.
 *
 *  An empty body writes nothing at all. Wrapping it would send a pair of guards
 *  around no content — two writes where there used to be none, announcing a
 *  paste that never comes. */
export function injectionChunks(body: string, size: number, bracketed: boolean): string[] {
  if (body === '') return []
  const chunks = chunkForPty(body, size)
  return bracketed ? [BRACKETED_PASTE_START, ...chunks, BRACKETED_PASTE_END] : chunks
}

/** Strip what the terminal sends alongside real typing — cursor and function
 *  keys, mouse and focus reports, bracketed-paste guards — plus the remaining
 *  control characters, leaving only the text the user is composing.
 *
 *  Dropping the WHOLE escape sequence is the point: stripping the ESC byte
 *  alone leaves "[A" behind for an arrow key and "[<0;10;5M" for a mouse click,
 *  which a draft/`/clear` tracker then reads as typed text that never clears. */
export function stripInputSequences(text: string): string {
  return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|.?)/g, '').replace(/[\x00-\x1f\x7f]/g, '')
}

/** Convert a screen-space drop point (reported by the drag source window's
 *  dragend) into this window's client/viewport coordinates. `window.screenX/Y`
 *  is the VIEWPORT's top-left in screen space, so window chrome is already
 *  accounted for and the conversion is a plain offset. Pure for testability. */
export function screenToClientPoint(
  point: { screenX: number; screenY: number },
  viewportOrigin: { screenX: number; screenY: number }
): { x: number; y: number } {
  return {
    x: point.screenX - viewportOrigin.screenX,
    y: point.screenY - viewportOrigin.screenY
  }
}

export interface CliPaneBufferReply {
  label: string
  agentKey: string
  sessionId: string | null
  sessionHomeId: string
  workspacePath: string
  conversationLogPath: string
  buffer: string
}

/** Shape a responder reply from the pane record and its TerminalPane ref.
 *  A missing ref means the pane is gone (closed between drag and drop). */
export function buildCliPaneBufferReply(
  pane: {
    id: string
    customName?: string
    autoName?: string
    agentLabel: string
    agentKey: string
    pinnedSessionId?: string
    sessionHomeId?: string
    workspacePath: string
    outputLogFile?: string
  } | undefined,
  paneRef: { buffer?: string } | null | undefined
): CliPaneBufferReply | { error: 'not-found' } {
  if (!paneRef) return { error: 'not-found' }
  return {
    label: pane ? pane.customName || pane.autoName || pane.agentLabel : '',
    agentKey: pane?.agentKey ?? '',
    sessionId: pane?.pinnedSessionId || null,
    sessionHomeId: pane?.sessionHomeId ?? '',
    workspacePath: pane?.workspacePath ?? '',
    conversationLogPath: pane?.outputLogFile ?? '',
    buffer: paneRef.buffer ?? ''
  }
}

export interface PaneStatusReply {
  status: string
  buffer: string
  logPath?: string
}

/** Shape a `ui.pane.getStatus` reply (App.vue's external UI action bus).
 *  Mirrors buildCliPaneBufferReply's split: `pane` supplies static identity
 *  (outputLogFile), `live` supplies the caller-computed status/rendered
 *  buffer text — null when the pane exists but hasn't realized its
 *  TerminalPane ref yet (still shows a status, but no scrollback). */
export function buildPaneStatusReply(
  pane: { outputLogFile?: string } | undefined,
  live: { displayStatus?: string; buffer: string } | null
): PaneStatusReply {
  return {
    status: live?.displayStatus ?? 'starting',
    buffer: live ? bufferTail(live.buffer, CLI_PASTE_BUFFER_CAP) : '',
    logPath: pane?.outputLogFile || undefined
  }
}
