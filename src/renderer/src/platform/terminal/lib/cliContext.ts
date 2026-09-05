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

/** The workspace-local broadcast keyword the mention menu offers. Shared so
 *  the menu can tell a broadcast apart from a named pane — ticking "everyone"
 *  alongside two names would deliver to those two twice. */
export const MENTION_BROADCAST_ADDRESS = 'all'

/** One address the @-mention menu can offer.
 *
 *  `group` and `statusLabel` arrive PRE-TRANSLATED. useTerminal owns no i18n
 *  scope by design (the same split onClear and onUserResume follow), so the
 *  host resolves every word and the menu only lays them out — which also keeps
 *  the menu's own logic (filtering, keys) free of locale concerns.
 */
export interface MentionCandidate {
  /** What gets typed into the prompt, e.g. "codex-1", "myproj/claude-2", "all". */
  address: string
  /** Pre-translated section heading. Candidates carrying the same one are drawn
   *  under a single header, in list order. Absent means "no section". */
  group?: string
  /** The pane's DisplayStatus, when this window can read it. Absent for `all`
   *  and for panes living in another workspace window — those have no local
   *  TerminalPane ref to ask, and the menu draws a hollow dot rather than
   *  inventing a status. */
  status?: string
  /** Pre-translated word shown beside the dot, e.g. "執行中". */
  statusLabel?: string
}

/** The comparison form of mention text: case-folded and NFKC-normalised, so a
 *  full-width "ＣＯＤ" left behind by a CJK input method still finds "codex". */
export function foldMentionText(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

/** Candidates whose address contains `query`, case-insensitively and
 *  regardless of full-width/half-width form.
 *
 *  Substring rather than fuzzy, matching the mini-IDE's Quick Open symbol
 *  filter: with a dozen candidates fuzzy only earns the surprise of a third
 *  typed character still showing unrelated rows. The whole address is matched,
 *  so "myproj/codex-1" answers to both "cod" and "myproj". */
export function filterMentionCandidates<T extends { address: string }>(
  candidates: readonly T[],
  query: string
): T[] {
  if (!query) return [...candidates]
  const needle = foldMentionText(query)
  return candidates.filter((c) => foldMentionText(c.address).includes(needle))
}

/** Cluster candidates so every group is contiguous — the menu draws a header
 *  wherever the group changes, so interleaved groups would draw it twice.
 *  Groups keep first-seen order, except `first` (the sender's own workspace)
 *  leads; order within a group is kept. */
export function clusterMentionCandidates(
  candidates: readonly MentionCandidate[],
  first?: string
): MentionCandidate[] {
  const buckets = new Map<string, MentionCandidate[]>()
  if (first) buckets.set(first, [])
  for (const c of candidates) {
    const key = c.group ?? ''
    const bucket = buckets.get(key)
    if (bucket) bucket.push(c)
    else buckets.set(key, [c])
  }
  return [...buckets.values()].flat()
}

/** Move recently-picked addresses to the front under `recentGroup`, newest
 *  first; everything else keeps its list order and its own group.
 *
 *  Re-grouping is the point: a recent address hoisted to the top while still
 *  labelled "this window" would sit under the wrong header, and the menu draws
 *  headers straight from this order. */
export function rankMentionCandidates(
  candidates: readonly MentionCandidate[],
  recents: readonly string[],
  recentGroup: string
): MentionCandidate[] {
  const byAddress = new Map(candidates.map((c) => [c.address, c]))
  const hoisted: MentionCandidate[] = []
  const seen = new Set<string>()
  for (const address of recents) {
    const found = byAddress.get(address)
    if (found && !seen.has(address)) {
      seen.add(address)
      hoisted.push({ ...found, group: recentGroup })
    }
  }
  return [...hoisted, ...candidates.filter((c) => !seen.has(c.address))]
}

/** The recents list after `picked` was chosen: newest first, no duplicates,
 *  capped. Pure so the ordering survives a refactor of wherever it is stored. */
export function recordMentionRecents(
  recents: readonly string[],
  picked: readonly string[],
  cap: number
): string[] {
  // Insertion order, not reversed: a multi-pick writes "@a @b", and the menu
  // offering them back in that same order is what makes the list feel like a
  // memory of what was typed rather than a shuffle of it.
  const next = [...picked]
  for (const address of recents) {
    if (!next.includes(address)) next.push(address)
  }
  return next.slice(0, cap)
}

/** The single PTY write that completes a mention: erase the typed query, then
 *  insert the chosen addresses.
 *
 *  One write, not two: a separate erase would let the CLI redraw its prompt
 *  between the two halves, which is exactly when the flicker becomes visible.
 *  The DEL bytes are how the rest of this file spells backspace (see the
 *  selection-delete path in useTerminal). */
export function buildMentionPickData(query: string, addresses: readonly string[]): string {
  if (!addresses.length) return ''
  // One DEL per character the CLI sees, so count code points, not UTF-16
  // units: a query of "測試" is two backspaces, an emoji is one, and counting
  // units would send one too many and eat a character of the real prompt.
  return '\x7f'.repeat([...query].length) + addresses.join(' ') + ' '
}

/** How `pick` changes the draft-tracking input buffer: the query is erased and
 *  the addresses take its place. Kept beside buildMentionPickData because the
 *  two must agree — the menu writes to the PTY through a path that bypasses
 *  term.onData, so nothing else will correct this buffer. */
export function applyMentionPickToInput(
  inputBuffer: string,
  query: string,
  addresses: readonly string[]
): string {
  if (!addresses.length) return inputBuffer
  const trimmed = query.length ? inputBuffer.slice(0, -query.length) : inputBuffer
  return trimmed + addresses.join(' ') + ' '
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

/** Everything that must not survive into a PTY write.
 *
 *  The paste guards first, and they are the reason this exists. Wrapping a body
 *  in `ESC[200~ … ESC[201~` tells the CLI to take the content as text rather
 *  than as keys — but only until it sees the end guard, and the end guard is
 *  five printable bytes that any message can contain. A payload carrying one
 *  closes paste mode early, and everything after it arrives as *keystrokes*:
 *  CR submits, `\x03` interrupts, `\x04` can end the session. That turns "send
 *  this agent a message" into "press these keys on that machine", which is a
 *  different feature and one nobody agreed to.
 *
 *  Then the remaining C0 controls, because the guards only hold for a CLI that
 *  implements bracketed paste, and `injectionChunks` is also called with
 *  `bracketed: false`. Newline and tab stay: multi-line messages are ordinary
 *  and are what `preserveNewlines` exists to carry. CR does not — in a PTY it
 *  is Enter, and an injected message decides for itself when it is finished.
 *
 *  Deliberately not `stripInputSequences`, which lives a few lines below and
 *  looks like the same job. That one reads what a terminal *sends* and removes
 *  whole escape sequences, including the arrow keys and mouse reports a person
 *  generates while typing. Here the input is somebody else's message, and
 *  silently eating a bracket-looking run of their text would be a second
 *  surprise on top of the first. */
export function sanitizeInjectionBody(body: string): string {
  return body
    .split(BRACKETED_PASTE_START)
    .join('')
    .split(BRACKETED_PASTE_END)
    .join('')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/** Split an injection payload into PTY writes.
 *
 *  The bracketed-paste guards are emitted as their own chunks and never merged
 *  into the content: a CLI that receives half of `ESC[200~` prints the rest as
 *  literal text and never enters paste mode, which is exactly what a size-based
 *  split of the wrapped string would eventually do.
 *
 *  The body is sanitised here rather than at the callers because this is the one
 *  place every injection passes through — local `cli_send`, a cross-device
 *  message off the relay, a spawn kickoff, a pasted pane context. A caller that
 *  forgot would not fail visibly; it would just hand somebody else's control
 *  bytes to a terminal.
 *
 *  An empty body writes nothing at all. Wrapping it would send a pair of guards
 *  around no content — two writes where there used to be none, announcing a
 *  paste that never comes. A body that is empty only *after* sanitising is the
 *  same situation and takes the same answer. */
export function injectionChunks(body: string, size: number, bracketed: boolean): string[] {
  const clean = sanitizeInjectionBody(body)
  if (clean === '') return []
  const chunks = chunkForPty(clean, size)
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
  /** Which kind of wait an 'awaiting' status is reporting — 'permission' or
   *  'question'; absent for every other status. The badge merged the two, but
   *  a caller deciding whether it may send this pane work still has to tell
   *  them apart, and `status` alone no longer can. cli_wait_idle is the
   *  consumer that must not regress: a question was always something it
   *  returned from, a permission prompt never was. */
  awaitingKind?: string
  /** How the pane's spawn-time task injection ended: 'sent' (our own text was
   *  observed landing), 'unverified' (bytes written, but the only echo was the
   *  buffer growing — which a booting CLI does regardless), 'failed', or
   *  'pending' while it is still running. Absent when the pane was not spawned
   *  with a task. A caller that opened this pane and got `ok: true` cannot
   *  otherwise tell a delivered task from a pane sitting at an empty prompt. */
  kickoff?: string
  buffer: string
  logPath?: string
}

/** Shape a `ui.pane.getStatus` reply (App.vue's external UI action bus).
 *  Mirrors buildCliPaneBufferReply's split: `pane` supplies static identity
 *  (outputLogFile), `live` supplies the caller-computed status/rendered
 *  buffer text — null when the pane exists but hasn't realized its
 *  TerminalPane ref yet (still shows a status, but no scrollback). */
export function buildPaneStatusReply(
  pane: { outputLogFile?: string; kickoffStatus?: string } | undefined,
  live: { displayStatus?: string; awaitingKind?: string | null; buffer: string } | null
): PaneStatusReply {
  const reply: PaneStatusReply = {
    status: live?.displayStatus ?? 'starting',
    buffer: live ? bufferTail(live.buffer, CLI_PASTE_BUFFER_CAP) : '',
    logPath: pane?.outputLogFile || undefined
  }
  if (live?.awaitingKind) reply.awaitingKind = live.awaitingKind
  // 'none' means this pane was never given a task; saying so would be noise.
  if (pane?.kickoffStatus && pane.kickoffStatus !== 'none') reply.kickoff = pane.kickoffStatus
  return reply
}
