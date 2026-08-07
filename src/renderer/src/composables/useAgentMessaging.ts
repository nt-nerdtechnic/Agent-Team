import { readonly, ref } from 'vue'
import {
  renderEnvelope,
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
 * per-target queue cap, global pause switch.
 */

export type MessageStatus = 'queued' | 'delivering' | 'delivered' | 'failed'

export interface AgentMessage {
  id: number
  /** Persistence key, `${bootUid}:${id}`. `id` is a module counter that restarts
   *  at 0 on every reload and is shared-by-value across windows, so only this is
   *  safe as a key in the (global) backend store. */
  uid: string
  from: string
  to: string
  /** Raw (unsanitized) content, for display in the log panel. */
  content: string
  status: MessageStatus
  /** Failure reason when status === 'failed'. */
  reason?: string
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
  reason?: string
  delivered_at?: number
  remote?: 'outbound' | 'inbound'
  remote_workspace?: string
}

/** A status patch for an already-persisted row. */
export interface PersistedMessageUpdate {
  uid: string
  status?: MessageStatus
  reason?: string
  delivered_at?: number
}

export interface RouteResult {
  ok: boolean
  error?: string
  targetDisplay?: string
  targetWorkspacePath?: string
}

export interface MessagingDeps {
  now: () => number
  /** Inject text into a pane; resolves true when the injection verified OK. */
  deliver: (paneId: string, text: string) => Promise<boolean>
  /** True when the pane can accept an injection right now (idle + settled). */
  isPaneIdle: (paneId: string) => boolean
  /** Ask the backend registry to route a target this window does not own.
   *  Absent (or throwing) → cross-workspace addressing degrades to the previous
   *  local-only behaviour. */
  routeRemote?: (args: {
    fromPaneId: string
    fromName: string
    to: string
    content: string
    msgKey: string
  }) => Promise<RouteResult>
  /** Tell the sending window how an inbound cross-workspace message ended. */
  reportDelivery?: (msgKey: string, ok: boolean, reason: string) => void
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

/** Reserved `to:` keywords that fan a message out to every other pane instead
 *  of a single named target. `all` (case-insensitive) or `*`. */
export function isBroadcastTarget(to: string): boolean {
  const t = to.trim().toLowerCase()
  return t === 'all' || t === '*'
}

/** Reason written onto rows that were still in flight when the window died. */
const HYDRATE_LOST_REASON = 'window reloaded before delivery'

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
    reason: m.reason,
    delivered_at: m.deliveredAt,
    remote: m.remote,
    remote_workspace: m.remoteWorkspace,
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
  if (row.reason) m.reason = row.reason
  if (row.delivered_at != null) m.deliveredAt = row.delivered_at
  if (row.remote) m.remote = row.remote
  if (row.remote_workspace) m.remoteWorkspace = row.remote_workspace
  return m
}

const messages = ref<AgentMessage[]>([])
const paused = ref(false)

const nameByPane = new Map<string, string>()
const paneByName = new Map<string, string>()
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

function configureMessaging(d: MessagingDeps): void {
  deps = d
}

// ── Name registry ──────────────────────────────────────────────────────────
function registerPane(paneId: string, agentKey: string, preferredName?: string): string {
  const existing = nameByPane.get(paneId)
  if (existing) return existing
  // A requested handle (persisted name / pane title) keeps its base and only
  // gains a -N suffix on collision; with no valid request, use <agent>-N.
  const base = preferredName ? normalizeMessagingName(preferredName) : null
  const name = base
    ? uniqueMessagingName(base, paneByName.keys())
    : defaultMessagingName(agentKey, paneByName.keys())
  nameByPane.set(paneId, name)
  paneByName.set(name, paneId)
  return name
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
  const name = norm
    ? uniqueMessagingName(norm, paneByName.keys())
    : defaultMessagingName(agentKey, paneByName.keys())
  nameByPane.set(paneId, name)
  paneByName.set(name, paneId)
  return name
}

function renamePane(paneId: string, rawName: string): boolean {
  const name = normalizeMessagingName(rawName)
  if (!name) return false
  const current = nameByPane.get(paneId)
  if (name === current) return true
  if (paneByName.has(name)) return false
  if (current) paneByName.delete(current)
  nameByPane.set(paneId, name)
  paneByName.set(name, paneId)
  return true
}

function unregisterPane(paneId: string): void {
  const q = queues.get(paneId) ?? []
  for (const id of q) {
    failMessage(id, 'target pane closed')
    // Undelivered cross-workspace messages must not leave the sending window
    // waiting for a report that will never come.
    ackInbound(id, false, 'target pane closed')
  }
  queues.delete(paneId)
  delivering.delete(paneId)
  const name = nameByPane.get(paneId)
  if (name) paneByName.delete(name)
  nameByPane.delete(paneId)
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
  return uniqueMessagingName(base, paneByName.keys())
}

// ── Queue ──────────────────────────────────────────────────────────────────
function findMessage(id: number): AgentMessage | undefined {
  return messages.value.find((m) => m.id === id)
}

function failMessage(id: number, reason: string): void {
  const m = findMessage(id)
  if (m && m.status !== 'delivered') {
    m.status = 'failed'
    m.reason = reason
    deps?.persistUpdate?.([{ uid: m.uid, status: 'failed', reason }])
  }
  envelopes.delete(id)
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
function ackInbound(id: number, ok: boolean, reason: string): void {
  const msgKey = remoteInbound.get(id)
  if (msgKey === undefined) return
  remoteInbound.delete(id)
  deps?.reportDelivery?.(msgKey, ok, reason)
}

export interface SendOptions {
  includeReplyHint?: boolean
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
  pushLog(msg)

  const targetPane = paneIdOf(to)
  if (!targetPane) {
    // A `<folder>/<pane>` target this window does not own may live in another
    // workspace window; anything else keeps failing straight away as before.
    if (deps.routeRemote && isQualifiedTarget(to)) {
      dispatchRemote(msg, from, to, content, now)
      return msg
    }
    failMessage(msg.id, `unknown target "${to}"`)
    return msg
  }
  if (from === to) {
    failMessage(msg.id, 'sender and target are the same pane')
    return msg
  }
  if (overRateLimit(from, to, now)) {
    failMessage(msg.id, `rate limit: max ${RATE_LIMIT_MAX} msgs / ${RATE_LIMIT_WINDOW_MS / 1000}s per pair`)
    return msg
  }
  const q = queues.get(targetPane) ?? []
  if (q.length >= QUEUE_CAP) {
    failMessage(msg.id, `target queue full (${QUEUE_CAP})`)
    return msg
  }

  const key = pairKey(from, to, false)
  pairSends.set(key, [...(pairSends.get(key) ?? []), now])
  envelopes.set(msg.id, renderEnvelope(from, content, opts))
  q.push(msg.id)
  queues.set(targetPane, q)
  return msg
}

// ── Cross-workspace routing ────────────────────────────────────────────────
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
): void {
  const routeRemote = deps?.routeRemote
  if (!routeRemote) {
    failMessage(msg.id, `unknown target "${to}"`)
    return
  }
  const fromPaneId = paneIdOf(from)
  if (!fromPaneId) {
    failMessage(msg.id, `unknown target "${to}"`)
    return
  }
  if (overRateLimit(from, to, now, true)) {
    failMessage(
      msg.id,
      `rate limit: max ${RATE_LIMIT_MAX} msgs / ${RATE_LIMIT_WINDOW_MS / 1000}s per pair`,
    )
    return
  }
  const key = pairKey(from, to, true)
  pairSends.set(key, [...(pairSends.get(key) ?? []), now])

  msg.remote = 'outbound'
  const msgKey = `${fromPaneId}:${msg.id}`
  remoteOutbound.set(msgKey, { id: msg.id, sentAt: now })

  void (async () => {
    try {
      const result = await routeRemote({ fromPaneId, fromName: from, to, content, msgKey })
      if (!result.ok) {
        remoteOutbound.delete(msgKey)
        failMessage(msg.id, result.error || `unknown target "${to}"`)
        return
      }
      msg.remoteWorkspace = result.targetWorkspacePath
    } catch (err) {
      remoteOutbound.delete(msgKey)
      failMessage(msg.id, `routing error: ${err instanceof Error ? err.message : String(err)}`)
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
  /** Apply the per-pair rate limit here — set for senders that did not pass
   *  through sendMessage (the MCP tools), which would otherwise have no loop
   *  guard at all. */
  rateLimit?: boolean
}): boolean {
  if (!deps) return false
  const localName = nameByPane.get(args.targetPaneId)
  if (!localName) return false

  if (args.rateLimit) {
    const now = deps.now()
    if (overRateLimit(args.fromDisplay, localName, now, true)) {
      const reason = `rate limit: max ${RATE_LIMIT_MAX} msgs / ${RATE_LIMIT_WINDOW_MS / 1000}s per pair`
      pushLog({
        ...nextMessageKeys(),
        from: args.fromDisplay,
        to: localName,
        content: args.content,
        status: 'failed',
        reason,
        createdAt: now,
        remote: 'inbound',
        remoteWorkspace: args.remoteWorkspace,
      })
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
  pushLog(msg)

  const q = queues.get(args.targetPaneId) ?? []
  if (q.length >= QUEUE_CAP) {
    failMessage(msg.id, `target queue full (${QUEUE_CAP})`)
    deps.reportDelivery?.(args.msgKey, false, `target queue full (${QUEUE_CAP})`)
    return true
  }
  envelopes.set(msg.id, renderEnvelope(args.fromDisplay, args.content))
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
  pushLog(msg)
  // Hook the row into the ordinary outbound lifecycle: resolveRemoteDelivery()
  // flips it to delivered/failed, expireStaleRemotes() is the backstop.
  remoteOutbound.set(args.msgKey, { id: msg.id, sentAt: now })
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
    deps?.persistUpdate?.([{ uid: msg.uid, status: 'delivered', delivered_at: msg.deliveredAt }])
  } else {
    failMessage(rec.id, reason || 'delivery failed')
  }
}

/** Fail outbound messages whose target window never reported back, so they stop
 *  sitting in `queued` (which clearMessageLog deliberately keeps) and stop
 *  holding a remoteOutbound entry. */
function expireStaleRemotes(now: number): void {
  for (const [msgKey, rec] of [...remoteOutbound]) {
    if (now - rec.sentAt < REMOTE_ACK_TIMEOUT_MS) continue
    remoteOutbound.delete(msgKey)
    failMessage(rec.id, 'no delivery report from the target window')
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
  expireStaleRemotes(deps.now())
  if (paused.value) return
  for (const paneId of queues.keys()) void pumpPane(paneId)
}

async function pumpPane(paneId: string): Promise<void> {
  if (!deps || paused.value || delivering.has(paneId)) return
  const q = queues.get(paneId)
  if (!q || q.length === 0) return
  if (!deps.isPaneIdle(paneId)) return

  const id = q[0]
  const msg = findMessage(id)
  const envelope = envelopes.get(id)
  if (!msg || !envelope) {
    q.shift()
    ackInbound(id, false, 'message dropped before delivery')
    return
  }
  delivering.add(paneId)
  msg.status = 'delivering'
  deps.persistUpdate?.([{ uid: msg.uid, status: 'delivering' }])
  let ackOk = false
  let ackReason = ''
  try {
    const ok = await deps.deliver(paneId, envelope)
    if (ok) {
      msg.status = 'delivered'
      msg.deliveredAt = deps.now()
      deps.persistUpdate?.([{ uid: msg.uid, status: 'delivered', delivered_at: msg.deliveredAt }])
      envelopes.delete(id)
      ackOk = true
    } else {
      ackReason = 'injection failed (echo not verified)'
      failMessage(id, ackReason)
    }
  } catch (err) {
    ackReason = `injection error: ${err instanceof Error ? err.message : String(err)}`
    failMessage(id, ackReason)
  } finally {
    q.shift()
    delivering.delete(paneId)
    ackInbound(id, ackOk, ackReason)
  }
}

// ── Pause / log ────────────────────────────────────────────────────────────
function pauseMessaging(): void {
  paused.value = true
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
  queues.clear()
  delivering.clear()
  envelopes.clear()
  pairSends.clear()
  remoteOutbound.clear()
  remoteInbound.clear()
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
    acceptRemoteMessage,
    noteOutboundMessage,
    resolveRemoteDelivery,
    pump,
    pauseMessaging,
    resumeMessaging,
    clearMessageLog,
    hydrateLog,
  }
}
