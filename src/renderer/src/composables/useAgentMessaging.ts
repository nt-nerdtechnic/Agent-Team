import { readonly, ref } from 'vue'
import {
  renderEnvelope,
  renderFailureNotice,
  reasonToEnglish,
  defaultMessagingName,
  isQualifiedTarget,
  normalizeMessagingName,
  uniqueMessagingName,
} from '../lib/agentMessaging'

/**
 * Inter-CLI messaging: pane name registry + per-target delivery queue.
 *
 * Singleton module-level state (same pattern as useNotify). App.vue configures
 * the runtime deps (deliver/isPaneIdle) once at mount via configureMessaging();
 * unit tests inject fakes and call _resetMessagingForTest().
 *
 * Delivery discipline: one in-flight injection per target pane, only when the
 * pane is idle, FIFO per target. Loop guards: per sender→target rate limit,
 * per-target queue cap, global pause switch. A message that has not been taken
 * off its queue yet can still be withdrawn — see cancelMessage().
 */

export type MessageStatus = 'queued' | 'delivering' | 'delivered' | 'failed' | 'cancelled'

/**
 * Why a message is still sitting in `queued`. `key` is an i18n key suffix the
 * log panel renders as `msg.hold-<key>`; `n` is its only parameter (the number
 * of messages ahead of this one). Transient by design — it describes a live
 * gate, so it is never persisted and never restored.
 */
export interface MessageHold {
  key: string
  n?: number
}

/**
 * Why a message failed. `key` is an i18n key suffix the log panel renders as
 * `msg.reason-<key>`, with `params` as its substitutions.
 *
 * `raw` is the escape hatch for text this app did not author — an exception
 * message, or an error from a backend old enough not to send a code — and
 * renders the text verbatim.
 */
export interface MessageReason {
  key: string
  params?: Record<string, string | number>
}

export function rawReason(text: string): MessageReason {
  return { key: 'raw', params: { text } }
}

/** Reasons cross a process boundary twice — the log store and the delivery
 *  report to another window — and both carry text, so they travel as JSON. */
export function encodeReason(reason: MessageReason): string {
  return JSON.stringify(reason)
}

/** The inverse, and the compatibility path: a row written before reasons were
 *  structured holds a plain English sentence, which decodes to `raw`. */
export function decodeReason(encoded: string | undefined | null): MessageReason | undefined {
  if (!encoded) return undefined
  try {
    const parsed = JSON.parse(encoded)
    if (parsed && typeof parsed === 'object' && typeof parsed.key === 'string') {
      return parsed as MessageReason
    }
  } catch {
    /* not JSON — a pre-structured reason, handled below */
  }
  return rawReason(encoded)
}

export interface AgentMessage {
  id: number
  /** Persistence key, `${bootUid}:${id}`. `id` is a module counter that restarts
   *  at 0 on every reload and is shared-by-value across windows, so only this is
   *  safe as a key in the (global) backend store. */
  uid: string
  from: string
  to: string
  /** Which CLI vendor each side is (an `agentKey`), captured when the message
   *  was sent. Snapshotted rather than looked up on render: a pane can be
   *  renamed, closed, or rebuilt onto a different CLI, and the log has to keep
   *  showing who actually took part. Absent for a sender outside any pane (an
   *  external MCP client) and for rows restored from before this was stored. */
  fromAgent?: string
  toAgent?: string
  /** Raw (unsanitized) content, for display in the log panel. */
  content: string
  status: MessageStatus
  /** 'notice' marks a message Navide wrote itself (delivery-failure feedback to
   *  a sending pane) rather than one an agent sent. It stops a bounced notice
   *  from producing another one, and it is what the log panel reads to suppress
   *  Resend — so unlike `hold` it is persisted: after a reload the panel must
   *  still know what a row is without parsing its text. */
  kind?: 'notice'
  /** Failure reason when status === 'failed'. */
  reason?: MessageReason
  /** Why this message has not been injected yet, while status === 'queued'. */
  hold?: MessageHold
  /** Set on a message that reached its pane without being typed in: `hook` for
   *  a claude Stop hook that was handed it as its next instruction, `push:<kind>`
   *  for one of the vendor push channels. Like `hold` it is in-memory only: it
   *  describes how a live row got out, and a restored log has no delivery left
   *  to explain. */
  route?: 'hook' | `push:${string}`
  /** `uid` of the message this one answers, set when the sender echoed back the
   *  correlation id carried in that message's envelope. Like `hold` it describes
   *  an in-memory relation between two live rows, so it is never persisted. */
  inReplyTo?: string
  createdAt: number
  deliveredAt?: number
  /** Set when the message crossed a workspace boundary. 'outbound' entries live
   *  in the sending window and are resolved by a delivery report; 'inbound'
   *  entries live in the receiving window and are delivered locally. */
  remote?: 'outbound' | 'inbound'
  /** The other workspace involved, for display in the log panel. */
  remoteWorkspace?: string
}

/** A log row as the backend store holds it (snake_case DB columns; `from`/`to`
 *  are reserved-ish words in SQL, hence `sender`/`recipient`). */
export interface PersistedMessageRow {
  uid: string
  created_at: number
  status: MessageStatus
  sender: string
  recipient: string
  content: string
  /** JSON-encoded MessageReason; see encodeReason(). */
  reason?: string
  delivered_at?: number
  remote?: 'outbound' | 'inbound'
  remote_workspace?: string
  sender_agent?: string
  recipient_agent?: string
  /** See AgentMessage.kind. Absent on rows written before the column existed,
   *  which is exactly right — every one of them is an ordinary message. */
  kind?: 'notice'
}

/** A status patch for an already-persisted row. */
export interface PersistedMessageUpdate {
  uid: string
  status?: MessageStatus
  /** JSON-encoded MessageReason; see encodeReason(). */
  reason?: string
  delivered_at?: number
}

/**
 * How a push attempt ended.
 *
 * The distinction that matters is the last one. Some channels write the CLI's
 * composer, and a failure after that write leaves the envelope sitting in it:
 * typing the same message in on top would submit it twice over, concatenated.
 * So an 'unclear' push is not retried in the same breath — the message goes
 * back to the head of its queue and the next pump decides again, by which time
 * the pane has either sent what it was holding or been cleared.
 *
 * - `landed`   — the CLI took it; nothing further to do.
 * - `declined` — the channel did not take it and touched nothing. Safe to type
 *                the message in right away.
 * - `unclear`  — the channel may be holding the text. Re-queue, never type.
 */
export type PushOutcome = 'landed' | 'declined' | 'unclear'

export interface RouteResult {
  ok: boolean
  /** The backend's English sentence, kept as the fallback when it sends no
   *  code (an older backend). */
  error?: string
  /** Machine code for the same failure, resolved against `msg.reason-*`. */
  errorCode?: string
  errorParams?: Record<string, string | number>
  targetDisplay?: string
  targetWorkspacePath?: string
  /** The resolved target's CLI vendor, which only the backend registry knows
   *  for a pane in another window. */
  targetAgentKey?: string
}

export interface MessagingDeps {
  now: () => number
  /** Inject text into a pane; resolves true when the injection verified OK. */
  deliver: (paneId: string, text: string) => Promise<boolean>
  /** True when the pane can accept an injection right now (idle + settled). */
  isPaneIdle: (paneId: string) => boolean
  /** Why isPaneIdle() said no, as an i18n key suffix under `msg.hold-*`. Must
   *  be derived from the same gate as isPaneIdle so the log cannot claim a
   *  reason the gate does not actually apply. Absent → a generic 'busy'. */
  idleHoldKey?: (paneId: string) => string | null
  /** The push channel that could take a message for this pane right now, or
   *  null when there is none — the vendor has no channel, it is not armed, or
   *  the gates that channel still answers to are closed. Non-null is what lets
   *  a message skip isPaneIdle(), so the caller must have applied whichever
   *  gates that channel does keep. */
  pushTarget?: (paneId: string) => { kind: string } | null
  /** Hand the envelope to that channel. See {@link PushOutcome} — anything but
   *  'landed' ends in the typed path, immediately or on a later tick. */
  pushDeliver?: (paneId: string, text: string) => Promise<PushOutcome>
  /** Ask the backend registry to route a target this window does not own.
   *  Absent (or throwing) → cross-workspace addressing degrades to the previous
   *  local-only behaviour. */
  routeRemote?: (args: {
    fromPaneId: string
    fromName: string
    to: string
    content: string
    msgKey: string
    /** Correlation id this message is answering, echoed back to the window that
     *  handed it out. Absent for a message that starts a thread. */
    replyTo?: string
  }) => Promise<RouteResult>
  /** Tell the sending window how an inbound cross-workspace message ended.
   *  The caller serializes; see encodeReason(). */
  reportDelivery?: (msgKey: string, ok: boolean, reason: MessageReason | null) => void
  /** Ask the window that owns the target's queue to drop a message this window
   *  sent. The answer comes back over the ordinary delivery-report path, so a
   *  window that is gone (or a message already on its way in) simply leaves the
   *  row as it was. Rejecting means the request never left this machine. */
  requestRemoteCancel?: (msgKey: string) => Promise<unknown> | void
  /** Tell the backend why a tracked message has not gone out yet, so an MCP
   *  caller can read the hold this panel shows. Called only when a message's
   *  hold KEY changes — never on the per-second re-annotation. */
  reportHold?: (msgKey: string, hold: MessageHold | null) => void
  /** Mirror the log into the backend store. All three are optional — without
   *  them the log stays in-memory only, exactly as it was before. The caller
   *  batches; these are called once per row/transition. */
  persistAppend?: (rows: PersistedMessageRow[]) => void
  persistUpdate?: (updates: PersistedMessageUpdate[]) => void
  persistClear?: (keepStatuses: MessageStatus[]) => void
}

export const RATE_LIMIT_MAX = 5
export const RATE_LIMIT_WINDOW_MS = 60_000
export const QUEUE_CAP = 10
const LOG_CAP = 500
/** Backstop for an outbound cross-workspace message whose target window never
 *  reports back (window killed mid-queue, machine slept). Deliberately long: the
 *  receiving pane may legitimately stay busy for a long turn before its queue
 *  drains, and every orderly outcome — delivered, injection failed, pane closed,
 *  queue full — is reported explicitly well before this fires. */
const REMOTE_ACK_TIMEOUT_MS = 30 * 60_000
/** How long a correlation id handed out in an envelope stays linkable. Same
 *  window as the remote-ack backstop: long enough for a slow turn to answer,
 *  short enough that the table cannot grow for the life of the session. */
const CORRELATION_TTL_MS = REMOTE_ACK_TIMEOUT_MS

const RATE_LIMIT_REASON: MessageReason = {
  key: 'rate-limit',
  params: { max: RATE_LIMIT_MAX, seconds: RATE_LIMIT_WINDOW_MS / 1000 },
}
const QUEUE_FULL_REASON: MessageReason = { key: 'queue-full', params: { cap: QUEUE_CAP } }

/** Handle Navide writes its own messages under — delivery-failure notices here,
 *  SPAWN feedback in App.vue. Reserved rather than merely unregistered: a pane
 *  answering to it would share the feedback rate-limit budget, and paneIdOf()
 *  would hand Navide's own notices to that pane instead of failing. */
export const NOTICE_SENDER = 'Navide'
/** Verdict for an outbound message the receiving window never answered for.
 *  See expireStaleRemotes(). */
const NO_REPORT_REASON: MessageReason = { key: 'no-report' }

/** Reserved `to:` keywords that fan a message out to every other pane instead
 *  of a single named target. `all` (case-insensitive) or `*`. */
export function isBroadcastTarget(to: string): boolean {
  const t = to.trim().toLowerCase()
  return t === 'all' || t === '*'
}

/** Reason written onto rows that were still in flight when the window died. */
const HYDRATE_LOST_REASON: MessageReason = { key: 'window-reloaded' }
/** Verdict reported back for a message the sender withdrew. Travels the same
 *  reportDelivery path as a failure, and the sending window reads the key to
 *  land its own row on `cancelled` rather than `failed`. */
const CANCELLED_REASON: MessageReason = { key: 'cancelled' }

// ── Module-level singleton state ──────────────────────────────────────────
let deps: MessagingDeps | null = null
let seq = 0

function newBootUid(): string {
  const c = globalThis.crypto
  if (c?.getRandomValues) {
    const bytes = c.getRandomValues(new Uint8Array(8))
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return Math.random().toString(16).slice(2, 18)
}

/** Per-boot prefix that makes `uid` unique across windows and reloads. */
let bootUid = newBootUid()

function nextMessageKeys(): { id: number; uid: string } {
  const id = ++seq
  return { id, uid: `${bootUid}:${id}` }
}

function toPersistedRow(m: AgentMessage): PersistedMessageRow {
  return {
    uid: m.uid,
    created_at: m.createdAt,
    status: m.status,
    sender: m.from,
    recipient: m.to,
    content: m.content,
    reason: m.reason ? encodeReason(m.reason) : undefined,
    delivered_at: m.deliveredAt,
    remote: m.remote,
    remote_workspace: m.remoteWorkspace,
    sender_agent: m.fromAgent,
    recipient_agent: m.toAgent,
    kind: m.kind,
  }
}

function fromPersistedRow(row: PersistedMessageRow): AgentMessage {
  // A restored row keeps its persisted uid but takes a fresh local id: the
  // in-memory side maps are keyed by id and must stay collision-free.
  const m: AgentMessage = {
    id: ++seq,
    uid: String(row.uid),
    from: String(row.sender ?? ''),
    to: String(row.recipient ?? ''),
    content: String(row.content ?? ''),
    status: row.status,
    createdAt: Number(row.created_at) || 0,
  }
  if (row.reason) m.reason = decodeReason(row.reason)
  if (row.delivered_at != null) m.deliveredAt = row.delivered_at
  if (row.remote) m.remote = row.remote
  if (row.remote_workspace) m.remoteWorkspace = row.remote_workspace
  if (row.sender_agent) m.fromAgent = row.sender_agent
  if (row.recipient_agent) m.toAgent = row.recipient_agent
  if (row.kind === 'notice') m.kind = row.kind
  return m
}

const messages = ref<AgentMessage[]>([])
const paused = ref(false)

const nameByPane = new Map<string, string>()
const paneByName = new Map<string, string>()
/** Each registered pane's CLI vendor (agentKey), for stamping messages. */
const agentByPane = new Map<string, string>()
/** FIFO of message ids per target paneId. */
const queues = new Map<string, number[]>()
/** Target paneIds with an injection currently in flight. */
const delivering = new Set<string>()
/** Envelope text per message id (not shown in the log panel). */
const envelopes = new Map<number, string>()
/** Enqueue timestamps per `${from}→${to}` pair, for rate limiting. */
const pairSends = new Map<string, number[]>()
/** Outbound cross-workspace messages awaiting a delivery report, by msgKey. */
const remoteOutbound = new Map<string, { id: number; sentAt: number }>()
/** Inbound cross-workspace messages to report back on, message id → msgKey. */
const remoteInbound = new Map<number, string>()
/** Message ids by the correlation id their envelope handed out, so a reply that
 *  echoes one back can be linked to the message it answers. Populated wherever
 *  an envelope is rendered; pruned by expireCorrelations(). */
const correlations = new Map<string, { id: number; sentAt: number }>()

function configureMessaging(d: MessagingDeps): void {
  deps = d
}

// ── Name registry ──────────────────────────────────────────────────────────
/** Whether a handle claims {@link NOTICE_SENDER}. Case-insensitive: the point
 *  is that no pane answers to the name Navide speaks under, and `navide` reads
 *  as that name to everyone involved. */
function isReservedName(name: string): boolean {
  return name.toLowerCase() === NOTICE_SENDER.toLowerCase()
}

/** A free handle for `base`. The reserved handle counts as taken even though no
 *  pane holds it, so claiming it takes a suffix exactly like colliding with
 *  another pane does. */
function uniqueHandle(base: string): string {
  return uniqueMessagingName(isReservedName(base) ? `${base}-2` : base, paneByName.keys())
}

function registerPane(paneId: string, agentKey: string, preferredName?: string): string {
  const existing = nameByPane.get(paneId)
  if (existing) return existing
  // A requested handle (persisted name / pane title) keeps its base and only
  // gains a -N suffix on collision; with no valid request, use <agent>-N.
  const base = preferredName ? normalizeMessagingName(preferredName) : null
  const name = base ? uniqueHandle(base) : defaultMessagingName(agentKey, paneByName.keys())
  nameByPane.set(paneId, name)
  paneByName.set(name, paneId)
  agentByPane.set(paneId, agentKey)
  return name
}

/** The CLI vendor behind a handle, or undefined when it is not a local pane. */
function agentOfName(name: string): string | undefined {
  const paneId = paneByName.get(name)
  return paneId ? agentByPane.get(paneId) : undefined
}

/** Re-derive a pane's handle from a new base (its title). Collision-suffixed;
 *  an empty/invalid base falls back to the `<agent>-N` default. Returns the new
 *  handle, or null when the pane is not in the registry (plain terminal). */
function setDerivedName(paneId: string, base: string | null, agentKey: string): string | null {
  const current = nameByPane.get(paneId)
  if (current === undefined) return null
  // Free the current name first so the base can reclaim it (or take a suffix
  // relative to OTHER panes only).
  paneByName.delete(current)
  const norm = base ? normalizeMessagingName(base) : null
  const name = norm ? uniqueHandle(norm) : defaultMessagingName(agentKey, paneByName.keys())
  nameByPane.set(paneId, name)
  paneByName.set(name, paneId)
  return name
}

function renamePane(paneId: string, rawName: string): boolean {
  const name = normalizeMessagingName(rawName)
  if (!name) return false
  const current = nameByPane.get(paneId)
  if (name === current) return true
  // Rejected rather than suffixed: a manual rename is an explicit choice, and
  // the caller already handles a refusal by asking for another name.
  if (isReservedName(name) || paneByName.has(name)) return false
  if (current) paneByName.delete(current)
  nameByPane.set(paneId, name)
  paneByName.set(name, paneId)
  return true
}

function unregisterPane(paneId: string): void {
  const q = queues.get(paneId) ?? []
  for (const id of q) {
    failMessage(id, { key: 'pane-closed' })
    // Undelivered cross-workspace messages must not leave the sending window
    // waiting for a report that will never come.
    ackInbound(id, false, { key: 'pane-closed' })
  }
  queues.delete(paneId)
  delivering.delete(paneId)
  const name = nameByPane.get(paneId)
  if (name) paneByName.delete(name)
  nameByPane.delete(paneId)
  agentByPane.delete(paneId)
}

function nameOf(paneId: string): string | null {
  return nameByPane.get(paneId) ?? null
}

function paneIdOf(name: string): string | null {
  return paneByName.get(name) ?? null
}

/** A free handle near `base` (base itself, or `base-2`, `base-3`…). Used to
 *  pre-fill the collision-resolution prompt on a manual rename. */
function suggestName(base: string): string {
  return uniqueHandle(base)
}

// ── Queue ──────────────────────────────────────────────────────────────────
function findMessage(id: number): AgentMessage | undefined {
  return messages.value.find((m) => m.id === id)
}

function failMessage(id: number, reason: MessageReason): void {
  const m = findMessage(id)
  if (m && m.status !== 'delivered') {
    m.status = 'failed'
    m.reason = reason
    delete m.hold
    deps?.persistUpdate?.([{ uid: m.uid, status: 'failed', reason: encodeReason(reason) }])
    notifySenderOfFailure(m)
  }
  envelopes.delete(id)
}

/**
 * Tell the SENDING pane that its message bounced.
 *
 * An agent writing bare-line `---MSG-START---` blocks has no other way to learn
 * this: the failure is otherwise only visible in the user's Messages panel. The
 * notice goes out as an ordinary message, so it takes the same queue, idle gate
 * and verified injection as everything else rather than a private path.
 *
 * Skipped for anything whose sender is not a live CLI pane in this window: an
 * inbound cross-workspace row (the sending window is told by reportDelivery and
 * notifies its own pane), a closed or plain-terminal pane (not in the registry),
 * an MCP client (which polls `cli_check_message` instead), and a notice itself —
 * a bounced notice is logged and left there, never answered with another.
 */
function notifySenderOfFailure(m: AgentMessage): void {
  if (!deps || !m.reason) return
  if (m.kind === 'notice' || m.remote === 'inbound') return
  if (!paneByName.has(m.from)) return
  sendMessage(
    NOTICE_SENDER,
    m.from,
    renderFailureNotice(m.to, reasonToEnglish(m.reason.key, m.reason.params), m.content),
    { kind: 'notice' },
  )
}

/**
 * Explain a target's queue: the head carries why the gate is closed (null when
 * it is open and the head is about to go out), everything behind it carries its
 * own position. Only `queued` rows are annotated — a row that already moved on
 * has an outcome to show instead.
 */
function annotateHold(q: number[], headKey: string | null): void {
  q.forEach((id, i) => {
    const m = findMessage(id)
    if (!m || m.status !== 'queued') return
    if (i > 0) setHold(m, { key: 'behind', n: i })
    else if (headKey) setHold(m, { key: headKey })
    else setHold(m, undefined)
  })
}

/** Assign only on a real change. pump() re-annotates every second, and a fresh
 *  object each tick would invalidate the log panel on every one of them even
 *  though nothing it displays moved. */
function setHold(m: AgentMessage, hold: MessageHold | undefined): void {
  if (m.hold?.key === hold?.key && m.hold?.n === hold?.n) return
  const keyChanged = m.hold?.key !== hold?.key
  if (hold) m.hold = hold
  else delete m.hold
  if (keyChanged) reportHoldChange(m, hold)
}

/**
 * Report a hold change for a message the backend tracks by `msgKey` — one that
 * arrived through `agent_msg.deliver`, so an MCP `cli_send` or another window's
 * send. A message between two panes of this window is known nowhere else and
 * has nobody to tell.
 *
 * Only a changed hold KEY is worth the round trip: `n` moving as the queue
 * drains says nothing about why the head is stuck, and pump() re-annotates
 * every second. Delivery clears the hold on the backend's side, so there is
 * nothing to send when a message leaves the queue.
 */
function reportHoldChange(m: AgentMessage, hold: MessageHold | undefined): void {
  const msgKey = remoteInbound.get(m.id)
  if (msgKey === undefined) return
  deps?.reportHold?.(msgKey, hold ?? null)
}

/** Mark a message as the answer to the one whose envelope handed out `corrId`.
 *  An id this window never handed out — expired, evicted, or issued by another
 *  window — leaves the message unlinked, which is exactly how a reply written
 *  without a `re:` field behaves. */
function linkReply(m: AgentMessage, corrId: string): void {
  const rec = correlations.get(corrId)
  if (!rec) return
  const original = findMessage(rec.id)
  if (original) m.inReplyTo = original.uid
}

/** Record which CLI vendor each side is, skipping the ones we cannot name. */
function stampAgents(m: AgentMessage, from?: string, to?: string): void {
  if (from) m.fromAgent = from
  if (to) m.toAgent = to
}

/** Re-persist a row whose fields were filled in after it was first logged (the
 *  cross-workspace route resolves the target asynchronously). The store upserts
 *  on `uid` and keeps the original insertion order, so this refreshes the row
 *  rather than duplicating it. */
function repersist(m: AgentMessage): void {
  deps?.persistAppend?.([toPersistedRow(m)])
}

function pushLog(m: AgentMessage): void {
  messages.value.push(m)
  if (messages.value.length > LOG_CAP) {
    for (const evicted of messages.value.splice(0, messages.value.length - LOG_CAP)) {
      envelopes.delete(evicted.id)
    }
  }
  // The store prunes to the same 500 rows independently, so the eviction above
  // needs no counterpart write.
  deps?.persistAppend?.([toPersistedRow(m)])
}

/**
 * Merge a persisted snapshot (oldest-first) into the in-memory log.
 *
 * Restored rows are history only: envelopes, queues and the remote-ack maps are
 * in-memory and died with the previous window, so a row left `queued` or
 * `delivering` can never be delivered here — pumpPane() would silently drop it.
 * They are shown as `failed`, but the coercion is NEVER written back: the store
 * is global, so the same row may be live and about to deliver in another window,
 * and persisting `failed` over it would corrupt that window's log. A later
 * hydrate simply re-coerces. Nothing is re-enqueued.
 */
function hydrateLog(rows: PersistedMessageRow[]): void {
  // The snapshot arrives asynchronously; anything this window already logged
  // wins over its persisted copy. The live object keeps its original `id`, which
  // envelopes/queues/remoteOutbound are keyed by — replacing it with a restored
  // copy would strand those bindings and leave a delivered message showing as
  // failed.
  const live = messages.value
  const liveUids = new Set(live.map((m) => m.uid))
  const restored = (rows ?? [])
    .filter((row) => !liveUids.has(String(row.uid)))
    .map(fromPersistedRow)
  for (const m of restored) {
    if (m.status !== 'queued' && m.status !== 'delivering') continue
    m.status = 'failed'
    m.reason = HYDRATE_LOST_REASON
  }
  messages.value = [...restored, ...live].slice(-LOG_CAP)
}

/** Rate-limit key for a sender→target pair.
 *
 *  Local targets key on the exact handle, exactly as before — a pane may
 *  legitimately be named `fix/bug`, and it must keep its own budget.
 *
 *  A remotely-routed target instead keys on the pane name alone: the backend
 *  accepts several spellings of the same address (folder basename, path suffix,
 *  absolute path), and one budget per spelling would multiply the limit. */
function pairKey(from: string, to: string, remote: boolean): string {
  if (!remote) return `${from}→${to}`
  const t = to.trim()
  const slash = t.lastIndexOf('/')
  return `${from}→remote:${slash === -1 ? t : t.slice(slash + 1)}`
}

function overRateLimit(from: string, to: string, now: number, remote = false): boolean {
  const key = pairKey(from, to, remote)
  const stamps = (pairSends.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  pairSends.set(key, stamps)
  return stamps.length >= RATE_LIMIT_MAX
}

/** Report an inbound cross-workspace message's outcome back to the sending
 *  window. Idempotent: only the first call for a message reports. */
function ackInbound(id: number, ok: boolean, reason: MessageReason | null): void {
  const msgKey = remoteInbound.get(id)
  if (msgKey === undefined) return
  remoteInbound.delete(id)
  deps?.reportDelivery?.(msgKey, ok, reason)
}

export interface SendOptions {
  includeReplyHint?: boolean
  /** Correlation id the sender echoed back, when this message is a reply. */
  replyTo?: string
  /** Internal: marks a Navide-authored notice. See notifySenderOfFailure(). */
  kind?: 'notice'
}

/**
 * Validate and enqueue a message. Always returns the log entry; invalid sends
 * come back already `failed` with a reason.
 */
function sendMessage(from: string, to: string, content: string, opts: SendOptions = {}): AgentMessage {
  if (!deps) throw new Error('messaging not configured')
  const now = deps.now()
  const msg: AgentMessage = {
    ...nextMessageKeys(),
    from,
    to,
    content,
    status: 'queued',
    createdAt: now,
  }
  // Stamped before anything can reject the send: every rejection below runs
  // through failMessage, which must already see this row for what it is.
  if (opts.kind) msg.kind = opts.kind
  stampAgents(msg, agentOfName(from), agentOfName(to))
  // Linked before the row is logged so even a rejected reply shows what it was
  // answering.
  if (opts.replyTo) linkReply(msg, opts.replyTo)
  pushLog(msg)

  const targetPane = paneIdOf(to)
  if (!targetPane) {
    // A `<folder>/<pane>` target this window does not own may live in another
    // workspace window; anything else keeps failing straight away as before.
    if (deps.routeRemote && isQualifiedTarget(to)) {
      dispatchRemote(msg, from, to, content, now, opts.replyTo)
      return msg
    }
    failMessage(msg.id, { key: 'unknown-target', params: { to } })
    return msg
  }
  if (from === to) {
    failMessage(msg.id, { key: 'self-send' })
    return msg
  }
  if (overRateLimit(from, to, now)) {
    failMessage(msg.id, RATE_LIMIT_REASON)
    return msg
  }
  const q = queues.get(targetPane) ?? []
  if (q.length >= QUEUE_CAP) {
    failMessage(msg.id, QUEUE_FULL_REASON)
    return msg
  }

  const key = pairKey(from, to, false)
  pairSends.set(key, [...(pairSends.get(key) ?? []), now])
  if (msg.kind === 'notice') {
    // A notice is Navide's own text, already in the form the pane must see: its
    // first line says "delivery failed", which is how an agent tells it apart
    // from a message. An envelope would bury that under `from: Navide` and ask
    // for a reply to a handle nothing can address — so it is injected verbatim,
    // and hands out no correlation id, because it is not a message to answer.
    envelopes.set(msg.id, content)
  } else {
    // `uid` is already unique across windows and reloads, so it doubles as the
    // correlation id for a locally delivered message.
    envelopes.set(
      msg.id,
      renderEnvelope(from, content, {
        includeReplyHint: opts.includeReplyHint,
        correlationId: msg.uid,
      }),
    )
    correlations.set(msg.uid, { id: msg.id, sentAt: now })
  }
  q.push(msg.id)
  queues.set(targetPane, q)
  return msg
}

// ── Cross-workspace routing ────────────────────────────────────────────────
/** Turn a rejected route into a displayable reason: prefer the backend's code
 *  so the log localizes, fall back to its English sentence (a backend older
 *  than the code), and finally to the target that could not be resolved. */
function routeFailureReason(result: RouteResult, to: string): MessageReason {
  if (result.errorCode) return { key: result.errorCode, params: result.errorParams }
  if (result.error) return rawReason(result.error)
  return { key: 'unknown-target', params: { to } }
}

/**
 * Hand a `<folder>/<pane>` target to the backend registry. The message stays
 * `queued` here until the receiving window reports back, so the log reflects
 * what actually happened rather than assuming success. The per-pair rate limit
 * applies exactly as it does locally; the queue cap belongs to the receiving
 * window, which owns the target's queue.
 */
function dispatchRemote(
  msg: AgentMessage,
  from: string,
  to: string,
  content: string,
  now: number,
  replyTo?: string,
): void {
  const routeRemote = deps?.routeRemote
  if (!routeRemote) {
    failMessage(msg.id, { key: 'unknown-target', params: { to } })
    return
  }
  const fromPaneId = paneIdOf(from)
  if (!fromPaneId) {
    failMessage(msg.id, { key: 'unknown-target', params: { to } })
    return
  }
  if (overRateLimit(from, to, now, true)) {
    failMessage(msg.id, RATE_LIMIT_REASON)
    return
  }
  const key = pairKey(from, to, true)
  pairSends.set(key, [...(pairSends.get(key) ?? []), now])

  msg.remote = 'outbound'
  // The target's queue lives in another window, so nothing local explains this
  // row's `queued` — say so rather than leaving it looking stuck.
  msg.hold = { key: 'remote-ack' }
  const msgKey = `${fromPaneId}:${msg.id}`
  remoteOutbound.set(msgKey, { id: msg.id, sentAt: now })
  // The receiving window renders its envelope with this same key, so a reply
  // that echoes it back lands on this row.
  correlations.set(msgKey, { id: msg.id, sentAt: now })

  void (async () => {
    try {
      const result = await routeRemote({ fromPaneId, fromName: from, to, content, msgKey, replyTo })
      if (!result.ok) {
        remoteOutbound.delete(msgKey)
        failMessage(msg.id, routeFailureReason(result, to))
        return
      }
      msg.remoteWorkspace = result.targetWorkspacePath
      stampAgents(msg, undefined, result.targetAgentKey)
      repersist(msg)
    } catch (err) {
      remoteOutbound.delete(msgKey)
      failMessage(msg.id, {
        key: 'route-error',
        params: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  })()
}

/**
 * Accept a cross-workspace message addressed to a pane in THIS window. Returns
 * false when the target is not ours, which is how each window filters the
 * broadcast. Delivery then runs through the ordinary queue, so the idle gate,
 * FIFO order and injection verification are unchanged.
 */
function acceptRemoteMessage(args: {
  msgKey: string
  targetPaneId: string
  fromDisplay: string
  content: string
  remoteWorkspace?: string
  /** The sending pane's CLI vendor, as reported by the backend registry. */
  fromAgent?: string
  /** Apply the per-pair rate limit here — set for senders that did not pass
   *  through sendMessage (the MCP tools), which would otherwise have no loop
   *  guard at all. */
  rateLimit?: boolean
  /** Correlation id the sender echoed back when this message is a reply to one
   *  this window sent. Unknown ids leave the row unlinked. */
  replyTo?: string
}): boolean {
  if (!deps) return false
  const localName = nameByPane.get(args.targetPaneId)
  if (!localName) return false

  if (args.rateLimit) {
    const now = deps.now()
    if (overRateLimit(args.fromDisplay, localName, now, true)) {
      const reason = RATE_LIMIT_REASON
      const rejected: AgentMessage = {
        ...nextMessageKeys(),
        from: args.fromDisplay,
        to: localName,
        content: args.content,
        status: 'failed',
        reason,
        createdAt: now,
        remote: 'inbound',
        remoteWorkspace: args.remoteWorkspace,
      }
      stampAgents(rejected, args.fromAgent, agentByPane.get(args.targetPaneId))
      if (args.replyTo) linkReply(rejected, args.replyTo)
      pushLog(rejected)
      deps.reportDelivery?.(args.msgKey, false, reason)
      return true
    }
    const key = pairKey(args.fromDisplay, localName, true)
    pairSends.set(key, [...(pairSends.get(key) ?? []), now])
  }

  const msg: AgentMessage = {
    ...nextMessageKeys(),
    from: args.fromDisplay,
    to: localName,
    content: args.content,
    status: 'queued',
    createdAt: deps.now(),
    remote: 'inbound',
    remoteWorkspace: args.remoteWorkspace,
  }
  stampAgents(msg, args.fromAgent, agentByPane.get(args.targetPaneId))
  if (args.replyTo) linkReply(msg, args.replyTo)
  pushLog(msg)

  const q = queues.get(args.targetPaneId) ?? []
  if (q.length >= QUEUE_CAP) {
    failMessage(msg.id, QUEUE_FULL_REASON)
    deps.reportDelivery?.(args.msgKey, false, QUEUE_FULL_REASON)
    return true
  }
  // The routing key is what the sending side already knows this message by, so
  // it is the correlation id the reply is asked to echo.
  envelopes.set(
    msg.id,
    renderEnvelope(args.fromDisplay, args.content, { correlationId: args.msgKey }),
  )
  correlations.set(args.msgKey, { id: msg.id, sentAt: msg.createdAt })
  remoteInbound.set(msg.id, args.msgKey)
  q.push(msg.id)
  queues.set(args.targetPaneId, q)
  pump()
  return true
}

/**
 * Log the SENDER's side of a message the backend routed without it passing
 * through sendMessage() — the MCP `cli_send` tool broadcasts `agent_msg.deliver`
 * straight out, so without this the sending window's log stays empty. Returns
 * true when this window owns the sender and a row was added.
 *
 * No envelope and no enqueue: the window owning the TARGET pane delivers.
 */
function noteOutboundMessage(args: {
  msgKey: string
  fromPaneId: string
  /** Target pane, when the event names one. Used to skip the row when this
   *  window also owns the target — acceptRemoteMessage logs that message. */
  targetPaneId?: string
  toDisplay: string
  /** The target pane's CLI vendor, as reported by the backend registry. */
  toAgent?: string
  content: string
  crossWorkspace: boolean
  remoteWorkspace?: string
}): boolean {
  if (!deps) return false
  const fromName = nameByPane.get(args.fromPaneId)
  if (!fromName) return false
  // The local sendMessage → agent_msg.route path already logged this message in
  // dispatchRemote under the same msgKey, and its broadcast comes back here too.
  if (remoteOutbound.has(args.msgKey)) return false
  // Sender and target both live in this window: the inbound row already shows
  // the message and owns its real delivery status, so an outbound row would
  // duplicate one message in one log.
  if (args.targetPaneId && nameByPane.has(args.targetPaneId)) return false

  const now = deps.now()
  const msg: AgentMessage = {
    ...nextMessageKeys(),
    from: fromName,
    to: args.toDisplay,
    content: args.content,
    status: 'queued',
    createdAt: now,
  }
  // `remote` means "crossed a workspace boundary" — a same-workspace MCP send
  // must not get the cross-workspace badge.
  if (args.crossWorkspace) {
    msg.remote = 'outbound'
    msg.remoteWorkspace = args.remoteWorkspace
  }
  msg.hold = { key: 'remote-ack' }
  stampAgents(msg, agentByPane.get(args.fromPaneId), args.toAgent)
  pushLog(msg)
  // Hook the row into the ordinary outbound lifecycle: resolveRemoteDelivery()
  // flips it to delivered/failed, expireStaleRemotes() is the backstop.
  remoteOutbound.set(args.msgKey, { id: msg.id, sentAt: now })
  // The receiving window renders its envelope with this key, so a reply echoing
  // it back links to this row — same as a send through dispatchRemote.
  correlations.set(args.msgKey, { id: msg.id, sentAt: now })
  return true
}

/** Apply a delivery report to this window's outbound log entry (no-op when the
 *  report belongs to another window). */
function resolveRemoteDelivery(msgKey: string, ok: boolean, reason: string): void {
  const rec = remoteOutbound.get(msgKey)
  if (rec === undefined) return
  remoteOutbound.delete(msgKey)
  const msg = findMessage(rec.id)
  if (!msg) return
  if (ok) {
    msg.status = 'delivered'
    msg.deliveredAt = deps ? deps.now() : msg.createdAt
    delete msg.hold
    deps?.persistUpdate?.([{ uid: msg.uid, status: 'delivered', delivered_at: msg.deliveredAt }])
  } else {
    const decoded = decodeReason(reason) ?? { key: 'delivery-failed' }
    // The message was called off before it went in — either this window asked,
    // or the receiving one dropped it from its own panel. Withdrawn, not failed:
    // nothing went wrong, so the sending pane gets no failure notice.
    if (decoded.key === CANCELLED_REASON.key) markCancelled(msg)
    else failMessage(rec.id, decoded)
  }
}

/** Fail outbound messages whose target window never reported back, so they stop
 *  sitting in `queued` (which clearMessageLog deliberately keeps) and stop
 *  holding a remoteOutbound entry.
 *
 *  The same verdict goes out over the ordinary reportDelivery path, because the
 *  backend keeps its own per-msgKey status for the MCP `cli_check_message` tool
 *  and nothing else will ever close this one: the window that was supposed to
 *  report is gone. Without it that status sits on `queued` until its TTL drops
 *  it — precisely the case (target window killed, machine slept) the tool
 *  exists to answer.
 *
 *  Reported only AFTER the remoteOutbound entry is dropped: the report comes
 *  back as an `agent_msg.delivery_result` broadcast, and resolveRemoteDelivery()
 *  must find nothing left to resolve rather than fail the row a second time. */
function expireStaleRemotes(now: number): void {
  for (const [msgKey, rec] of [...remoteOutbound]) {
    if (now - rec.sentAt < REMOTE_ACK_TIMEOUT_MS) continue
    remoteOutbound.delete(msgKey)
    failMessage(rec.id, NO_REPORT_REASON)
    deps?.reportDelivery?.(msgKey, false, NO_REPORT_REASON)
  }
}

/** Drop correlation ids old enough that no reply is still coming, so the table
 *  stays bounded over a long session. */
function expireCorrelations(now: number): void {
  for (const [corrId, rec] of [...correlations]) {
    if (now - rec.sentAt >= CORRELATION_TTL_MS) correlations.delete(corrId)
  }
}

/**
 * Broadcast: fan `content` out to every registered pane except `from`, each as
 * an ordinary single-target message (so per-pair rate limit, queue cap, idle
 * gate and the delivery log all apply per recipient). Returns one log entry per
 * recipient; empty when there is no one else to send to.
 */
function sendBroadcast(from: string, content: string, opts: SendOptions = {}): AgentMessage[] {
  const targets = [...paneByName.keys()].filter((name) => name !== from)
  return targets.map((to) => sendMessage(from, to, content, opts))
}

/**
 * Try to deliver queue heads. Safe to call often (interval + turn events);
 * per-pane in-flight guard makes it re-entrant.
 */
function pump(): void {
  if (!deps) return
  // Runs even while paused: pausing stops local injection, it does not make a
  // dead target window start answering.
  const now = deps.now()
  expireStaleRemotes(now)
  expireCorrelations(now)
  if (paused.value) {
    for (const q of queues.values()) annotateHold(q, 'paused')
    return
  }
  for (const paneId of queues.keys()) void pumpPane(paneId)
}

async function pumpPane(paneId: string): Promise<void> {
  if (!deps || paused.value) return
  const q = queues.get(paneId)
  if (!q || q.length === 0) return
  // Mid-injection: the head has no hold and the rest already carry their
  // positions from the call that let the head through.
  if (delivering.has(paneId)) return
  // A push channel answers to its own gates, which the caller has already
  // applied — so a pane it accepts needs no second opinion from the typed
  // path's gate, which is exactly what makes a message reach a pane someone is
  // typing in.
  const push = deps.pushTarget?.(paneId) ?? null
  if (!push && !deps.isPaneIdle(paneId)) {
    annotateHold(q, deps.idleHoldKey?.(paneId) ?? 'busy')
    return
  }
  annotateHold(q, null)

  const id = q[0]
  const msg = findMessage(id)
  const envelope = envelopes.get(id)
  if (!msg || !envelope) {
    q.shift()
    ackInbound(id, false, { key: 'dropped' })
    return
  }
  delivering.add(paneId)
  msg.status = 'delivering'
  deps.persistUpdate?.([{ uid: msg.uid, status: 'delivering' }])
  let ackOk = false
  let ackReason: MessageReason | null = null
  let requeued = false
  try {
    const ok = await deliverOnce(paneId, msg, envelope, push)
    if (ok === null) {
      // Pushed and it did not land, and typing it in now is not an option —
      // either the channel may still be holding the text, or the typed path's
      // own gate is shut because the push was chosen for a pane someone is
      // typing in. Put the message back at the head of its queue with nothing
      // spent: the next pump sends it whichever way is open then.
      requeued = true
      msg.status = 'queued'
      delete msg.route
      deps.persistUpdate?.([{ uid: msg.uid, status: 'queued' }])
    } else if (ok) {
      msg.status = 'delivered'
      msg.deliveredAt = deps.now()
      deps.persistUpdate?.([{ uid: msg.uid, status: 'delivered', delivered_at: msg.deliveredAt }])
      envelopes.delete(id)
      ackOk = true
    } else {
      ackReason = { key: 'inject-failed' }
      failMessage(id, ackReason)
    }
  } catch (err) {
    ackReason = {
      key: 'inject-error',
      params: { error: err instanceof Error ? err.message : String(err) },
    }
    failMessage(id, ackReason)
  } finally {
    delivering.delete(paneId)
    if (!requeued) {
      q.shift()
      ackInbound(id, ackOk, ackReason)
    }
  }
}

/**
 * One delivery attempt for the head of a pane's queue.
 *
 * Returns true when the message reached the pane, false when it demonstrably
 * did not, and null when a push failed and typing it in now would be wrong —
 * the caller puts the message back rather than choosing between losing it and
 * writing it into a pane that cannot take it.
 *
 * Two separate reasons to hold off, and both have to be checked. The channel
 * may still be holding the text ('unclear'), in which case typing would submit
 * the envelope twice over. And the push may have been chosen precisely because
 * the typed path's gate was shut — someone is typing in the pane — so the
 * fallback is re-gated rather than assumed.
 */
async function deliverOnce(
  paneId: string,
  msg: AgentMessage,
  envelope: string,
  push: { kind: string } | null,
): Promise<boolean | null> {
  if (!deps) return false
  if (push && deps.pushDeliver) {
    msg.route = `push:${push.kind}`
    const outcome = await deps.pushDeliver(paneId, envelope)
    if (outcome === 'landed') return true
    delete msg.route
    if (outcome === 'unclear') return null
    if (!deps.isPaneIdle(paneId)) return null
  }
  return deps.deliver(paneId, envelope)
}

/**
 * Reserve the next deliverable message for `paneId` and return its envelope,
 * for a caller that will hand it over WITHOUT injecting it — today that is a
 * claude pane's Stop hook, which passes the text to the agent as its next
 * instruction (see the backend's `hook_drain`).
 *
 * The gates that still apply are the ones about whether the message may go out
 * at all: the global pause, and the per-pane in-flight guard (a message being
 * typed into the pane right now must finish before another one starts). The
 * per-pair rate limit needs no check here — it is spent when a message is sent,
 * so anything already queued has paid for itself.
 *
 * The gates that do NOT apply are the ones about the input box: the idle gate
 * (the turn is ending, which is why we were asked) and the typing hold (nothing
 * is written to the pane, so a half-typed line cannot be submitted by this).
 *
 * Reserved, not consumed. The row stays at the head of its queue, marked
 * `delivering` with the pane held in-flight — the same state pumpPane keeps a
 * message in while its write is unconfirmed — until settleHookDrain() says
 * whether the hand-over landed. That is what makes a Stop hook that gave up
 * before its answer arrived cost nothing: the message is still exactly where
 * it was, for the ordinary typed path to pick up.
 */
function drainForHook(paneId: string): string | null {
  if (!deps || paused.value) return null
  if (delivering.has(paneId)) return null
  const q = queues.get(paneId)
  if (!q || q.length === 0) return null
  const id = q[0]
  const msg = findMessage(id)
  const envelope = envelopes.get(id)
  if (!msg || !envelope) {
    q.shift()
    ackInbound(id, false, { key: 'dropped' })
    return null
  }
  delivering.add(paneId)
  msg.status = 'delivering'
  msg.route = 'hook'
  delete msg.hold
  deps.persistUpdate?.([{ uid: msg.uid, status: 'delivering' }])
  return envelope
}

/**
 * Close a drainForHook() reservation. `ok` means the envelope reached the Stop
 * hook that was waiting for it; anything else — the hook timed out first, the
 * socket failed — restores the message, because nothing was written anywhere
 * and no agent has seen it.
 *
 * A pane that closed in between has already failed everything it had queued
 * (see unregisterPane), so there is nothing left to settle.
 */
function settleHookDrain(paneId: string, ok: boolean): void {
  if (!deps) return
  delivering.delete(paneId)
  const q = queues.get(paneId)
  const id = q?.[0]
  if (!q || id === undefined) return
  const msg = findMessage(id)
  if (!msg || msg.status !== 'delivering' || msg.route !== 'hook') return
  if (!ok) {
    msg.status = 'queued'
    delete msg.route
    deps.persistUpdate?.([{ uid: msg.uid, status: 'queued' }])
    return
  }
  q.shift()
  envelopes.delete(id)
  msg.status = 'delivered'
  msg.deliveredAt = deps.now()
  deps.persistUpdate?.([{ uid: msg.uid, status: 'delivered', delivered_at: msg.deliveredAt }])
  // Same report the injection path sends, so a cross-workspace sender's row
  // leaves `queued` whichever way its message actually arrived — and only once
  // it actually has.
  ackInbound(id, true, null)
}

// ── Cancel ─────────────────────────────────────────────────────────────────
/** The queue a message is sitting in, or null when nothing local holds it —
 *  it was already taken, or its queue lives in another window. */
function queuedLocation(id: number): { paneId: string; q: number[]; index: number } | null {
  for (const [paneId, q] of queues) {
    const index = q.indexOf(id)
    if (index !== -1) return { paneId, q, index }
  }
  return null
}

/** Take a message out of its local queue, if it is still there to take.
 *
 *  Only the head can be mid-injection — pumpPane and drainForHook both hold
 *  `q[0]` and shift it when they are done — so that is the one entry a pane
 *  with an injection in flight must keep. Everything behind it splices out
 *  safely, and the head those two are holding stays exactly where it was. */
function unqueue(id: number): boolean {
  const loc = queuedLocation(id)
  if (!loc) return false
  if (loc.index === 0 && delivering.has(loc.paneId)) return false
  loc.q.splice(loc.index, 1)
  return true
}

/** Mark a message withdrawn. Deliberately not failMessage(): the send was
 *  called off on purpose, so there is nothing to tell the sending pane about —
 *  a "delivery failed" notice injected into the pane that just cancelled would
 *  be the noise cancelling exists to avoid. */
function markCancelled(m: AgentMessage): void {
  m.status = 'cancelled'
  delete m.hold
  envelopes.delete(m.id)
  deps?.persistUpdate?.([{ uid: m.uid, status: 'cancelled' }])
}

/** The routing key an outbound cross-workspace message is known by, while it is
 *  still awaiting a report. */
function outboundKeyOf(id: number): string | null {
  for (const [msgKey, rec] of remoteOutbound) {
    if (rec.id === id) return msgKey
  }
  return null
}

/**
 * Withdraw a message that has not gone in yet. Returns false when it is too
 * late — anything already `delivering`, `delivered` or `failed` is beyond
 * recall, because the text is being (or has been) written into the pane.
 *
 * A message whose queue this window owns is dropped on the spot. One handed to
 * another window is only a request: that window owns the queue and decides, and
 * the answer arrives as an ordinary delivery report, so a message that went in
 * while the request was in flight stays `delivered` rather than being rewritten
 * as cancelled here.
 */
function cancelMessage(id: number): boolean {
  const m = findMessage(id)
  if (!m || m.status !== 'queued') return false
  if (unqueue(id)) {
    markCancelled(m)
    // An inbound cross-workspace row's sender is still waiting on a verdict.
    ackInbound(id, false, CANCELLED_REASON)
    return true
  }
  const msgKey = outboundKeyOf(id)
  const request = deps?.requestRemoteCancel
  if (!msgKey || !request) return false
  setHold(m, { key: 'cancelling' })
  void (async () => {
    try {
      await request(msgKey)
    } catch {
      // The request never left. Put the row back to waiting rather than leaving
      // it claiming a cancellation nobody was asked for.
      if (m.status === 'queued') setHold(m, { key: 'remote-ack' })
    }
  })()
  return true
}

/**
 * Honor another window's cancel request for a message queued here. Returns
 * false when it is too late, which is why nothing is reported in that case:
 * the delivery that beat the request will report the real outcome itself.
 */
function cancelRemoteInbound(msgKey: string): boolean {
  for (const [id, key] of remoteInbound) {
    if (key !== msgKey) continue
    const m = findMessage(id)
    if (!m || m.status !== 'queued' || !unqueue(id)) return false
    markCancelled(m)
    ackInbound(id, false, CANCELLED_REASON)
    return true
  }
  return false
}

// ── Pause / log ────────────────────────────────────────────────────────────
function pauseMessaging(): void {
  paused.value = true
  // Don't make the log wait for the next pump tick to explain itself.
  for (const q of queues.values()) annotateHold(q, 'paused')
}

/**
 * Re-send a finished entry as a brand-new message. Everything is re-validated
 * from scratch — target lookup, rate limit, queue cap — so a retry can fail
 * again for a different reason, and it spends the pair's budget like any other
 * send, which is what stops the button from being a loop hole.
 *
 * A retried cross-workspace message is logged as an ordinary send: the original
 * routing key was consumed when its failure was reported, and re-deriving the
 * route from `to` is exactly what sendMessage already does.
 *
 * A cancelled row is re-sendable for the same reason a failed one is: the text
 * never reached anyone, so sending it again delivers it once, not twice.
 */
function retryMessage(id: number): AgentMessage | null {
  const m = findMessage(id)
  if (!m || (m.status !== 'failed' && m.status !== 'cancelled')) return null
  return sendMessage(m.from, m.to, m.content)
}

function resumeMessaging(): void {
  paused.value = false
  pump()
}

const CLEAR_KEEP_STATUSES: MessageStatus[] = ['queued', 'delivering']

function clearMessageLog(): void {
  // Keep undelivered entries — they are still queued state, not just history.
  messages.value = messages.value.filter((m) => CLEAR_KEEP_STATUSES.includes(m.status))
  deps?.persistClear?.(CLEAR_KEEP_STATUSES)
}

/** Test-only: wipe all singleton state. */
export function _resetMessagingForTest(): void {
  deps = null
  seq = 0
  bootUid = newBootUid()
  messages.value = []
  paused.value = false
  nameByPane.clear()
  paneByName.clear()
  agentByPane.clear()
  queues.clear()
  delivering.clear()
  envelopes.clear()
  pairSends.clear()
  remoteOutbound.clear()
  remoteInbound.clear()
  correlations.clear()
}

export function useAgentMessaging() {
  return {
    messages: readonly(messages),
    paused: readonly(paused),
    configureMessaging,
    registerPane,
    renamePane,
    setDerivedName,
    unregisterPane,
    nameOf,
    paneIdOf,
    suggestName,
    sendMessage,
    sendBroadcast,
    retryMessage,
    cancelMessage,
    cancelRemoteInbound,
    acceptRemoteMessage,
    noteOutboundMessage,
    resolveRemoteDelivery,
    drainForHook,
    settleHookDrain,
    pump,
    pauseMessaging,
    resumeMessaging,
    clearMessageLog,
    hydrateLog,
  }
}
