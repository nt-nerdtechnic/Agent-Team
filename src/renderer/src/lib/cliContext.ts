// Reply builder for the main window's cli:get-pane-buffer responder (see the
// onCliPaneBufferRequest registration in App.vue). Pure so the lookup → reply
// mapping is unit-testable without mounting App.vue.

import { bufferTail } from './buffer'

/** MIME type set by TerminalPane's header dragstart (drag source). */
export const CLI_CONTEXT_MIME = 'application/x-cli-context'
/** MIME type carrying a bare pane id. Set (as an inline literal) by pane
 *  reorder drag sources: TerminalPane's header and ControlPane's agent list. */
export const PANE_ID_MIME = 'application/x-pane-id'
/** sourceId prefix marking a chip as a CLI-pane snapshot (enables refresh). */
export const CLI_SOURCE_PREFIX = 'cli-pane:'
/** Tail cap applied to the pane buffer before wrapping it into a chip. */
export const CLI_CHIP_BUFFER_CAP = 32 * 1024
/** Tail cap applied to the pane buffer before pasting it into another pane's
 *  input prompt. Much smaller than the chip cap: a 128KB blob is unusable as
 *  CLI prompt input. */
export const CLI_PASTE_BUFFER_CAP = 8000
/** Line caps applied when reading a pane's RENDERED scrollback (the source for
 *  both shares — see TerminalPane's readRenderedText). Applied first; the char
 *  caps above then bound the result. */
export const CLI_PASTE_LINE_CAP = 300
export const CLI_CHIP_LINE_CAP = 1000

/** True when the text left of the cursor ends with a bare "@" — the user is
 *  asking the pane drop to insert just the pane's messaging name (mention
 *  mode) instead of the full scrollback excerpt. Strict: the "@" must sit
 *  immediately before the cursor, so "@ " (space typed after) opts back out.
 *  Accepts the full-width "＠" (U+FF20) a CJK IME emits, not just ASCII "@". */
export function endsWithMentionTrigger(lineBeforeCursor: string): boolean {
  return lineBeforeCursor.endsWith('@') || lineBeforeCursor.endsWith('＠')
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
  payload: CliContextPayload
): void {
  dataTransfer.setData(PANE_ID_MIME, payload.paneId)
  dataTransfer.setData(CLI_CONTEXT_MIME, JSON.stringify(payload))
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
export function resolveCliDropPayload(
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

export type CliContextChipResult =
  | { kind: 'chip'; label: string; content: string; sourceId: string }
  | { kind: 'empty' }
  | { kind: 'error'; error: string }

/** Build the context-chip fields from the drag payload and the pane-buffer
 *  reply. Pure (timestamp injected) so it is unit-testable without AIChatPane.
 *  - reply carries an error → passthrough (caller surfaces it, no chip)
 *  - empty/whitespace buffer → 'empty' (no chip)
 *  - otherwise → chip with a header line + tail-truncated fenced buffer */
export function buildCliContextChip(
  payload: CliContextPayload,
  reply: {
    label?: string
    agentKey?: string
    sessionId?: string | null
    sessionHomeId?: string
    workspacePath?: string
    conversationLogPath?: string
    buffer?: string
    error?: string
  },
  capturedAt: number = Date.now()
): CliContextChipResult {
  if (reply.error) return { kind: 'error', error: reply.error }
  const buffer = reply.buffer ?? ''
  const context: CliSessionContext = {
    paneId: payload.paneId,
    agentKey: reply.agentKey || payload.agentKey,
    label: reply.label || payload.label,
    sessionId: reply.sessionId || payload.sessionId || null,
    sessionHomeId: reply.sessionHomeId || payload.sessionHomeId,
    workspacePath: reply.workspacePath || payload.workspacePath,
    conversationLogPath: reply.conversationLogPath || payload.conversationLogPath
  }
  if (!buffer.trim() && !context.conversationLogPath && !context.sessionId) return { kind: 'empty' }
  const name = reply.label || payload.label || payload.agentKey || 'pane'
  const reference = buildCliSessionReference(context)
  const header = `// CLI session context — captured: ${new Date(capturedAt).toISOString()}`
  const tail = bufferTail(buffer, CLI_CHIP_BUFFER_CAP)
  const excerpt = tail ? `\n// Recent terminal excerpt\n\`\`\`\n${tail}\n\`\`\`` : ''
  return {
    kind: 'chip',
    label: `@cli:${name}`,
    content: `${header}\n${reference}${excerpt}`,
    sourceId: `${CLI_SOURCE_PREFIX}${payload.paneId}`
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
