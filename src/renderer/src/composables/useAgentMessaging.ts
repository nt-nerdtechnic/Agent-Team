import { readonly, ref } from 'vue'
import {
  renderEnvelope,
  defaultMessagingName,
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
  from: string
  to: string
  /** Raw (unsanitized) content, for display in the log panel. */
  content: string
  status: MessageStatus
  /** Failure reason when status === 'failed'. */
  reason?: string
  createdAt: number
  deliveredAt?: number
}

export interface MessagingDeps {
  now: () => number
  /** Inject text into a pane; resolves true when the injection verified OK. */
  deliver: (paneId: string, text: string) => Promise<boolean>
  /** True when the pane can accept an injection right now (idle + settled). */
  isPaneIdle: (paneId: string) => boolean
}

export const RATE_LIMIT_MAX = 5
export const RATE_LIMIT_WINDOW_MS = 60_000
export const QUEUE_CAP = 10
const LOG_CAP = 500

/** Reserved `to:` keywords that fan a message out to every other pane instead
 *  of a single named target. `all` (case-insensitive) or `*`. */
export function isBroadcastTarget(to: string): boolean {
  const t = to.trim().toLowerCase()
  return t === 'all' || t === '*'
}

// ── Module-level singleton state ──────────────────────────────────────────
let deps: MessagingDeps | null = null
let seq = 0

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
  for (const id of q) failMessage(id, 'target pane closed')
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
}

function overRateLimit(from: string, to: string, now: number): boolean {
  const key = `${from}→${to}`
  const stamps = (pairSends.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  pairSends.set(key, stamps)
  return stamps.length >= RATE_LIMIT_MAX
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
    id: ++seq,
    from,
    to,
    content,
    status: 'queued',
    createdAt: now,
  }
  pushLog(msg)

  const targetPane = paneIdOf(to)
  if (!targetPane) {
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

  const key = `${from}→${to}`
  pairSends.set(key, [...(pairSends.get(key) ?? []), now])
  envelopes.set(msg.id, renderEnvelope(from, content, opts))
  q.push(msg.id)
  queues.set(targetPane, q)
  return msg
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
  if (!deps || paused.value) return
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
    return
  }
  delivering.add(paneId)
  msg.status = 'delivering'
  try {
    const ok = await deps.deliver(paneId, envelope)
    if (ok) {
      msg.status = 'delivered'
      msg.deliveredAt = deps.now()
      envelopes.delete(id)
    } else {
      failMessage(id, 'injection failed (echo not verified)')
    }
  } catch (err) {
    failMessage(id, `injection error: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    q.shift()
    delivering.delete(paneId)
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

function clearMessageLog(): void {
  // Keep undelivered entries — they are still queued state, not just history.
  messages.value = messages.value.filter((m) => m.status === 'queued' || m.status === 'delivering')
}

/** Test-only: wipe all singleton state. */
export function _resetMessagingForTest(): void {
  deps = null
  seq = 0
  messages.value = []
  paused.value = false
  nameByPane.clear()
  paneByName.clear()
  queues.clear()
  delivering.clear()
  envelopes.clear()
  pairSends.clear()
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
    pump,
    pauseMessaging,
    resumeMessaging,
    clearMessageLog,
  }
}
