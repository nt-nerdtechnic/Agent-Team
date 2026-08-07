import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMessageLogPersistence, MSG_LOG_FLUSH_MS } from '../useMessageLogPersistence'
import type { MessageStatus, PersistedMessageRow } from '../useAgentMessaging'

/** Regression cover for the message-log mirror's write races (FINDINGS 4/5/6/8). */

const KEEP: MessageStatus[] = ['queued', 'delivering']

function row(uid: string, status: MessageStatus): PersistedMessageRow {
  return { uid, created_at: 1, status, sender: 'a', recipient: 'b', content: 'x' }
}

interface Call {
  type: string
  payload: Record<string, unknown>
}

describe('createMessageLogPersistence', () => {
  let calls: Call[]
  let connected: boolean
  let hydrated: PersistedMessageRow[][]
  /** Per-type override: return the payload, null to fail, or a pending promise. */
  let responder: (type: string) => unknown

  function make(): ReturnType<typeof createMessageLogPersistence> {
    return createMessageLogPersistence({
      send: (type, payload) => {
        calls.push({ type, payload })
        return Promise.resolve(responder(type)) as Promise<never>
      },
      isConnected: () => connected,
      hydrate: (rows) => { hydrated.push(rows) },
    })
  }

  function types(): string[] {
    return calls.map((c) => c.type.replace('agent_msg.log_', ''))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    calls = []
    connected = true
    hydrated = []
    responder = () => ({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a queued → delivered lifecycle into one append', async () => {
    const p = make()
    p.persistAppend([row('u1', 'queued')])
    p.persistUpdate([{ uid: 'u1', status: 'delivering' }])
    p.persistUpdate([{ uid: 'u1', status: 'delivered', delivered_at: 9 }])
    await vi.advanceTimersByTimeAsync(MSG_LOG_FLUSH_MS)
    expect(types()).toEqual(['append'])
    expect(calls[0].payload.rows).toEqual([{ ...row('u1', 'delivered'), delivered_at: 9 }])
  })

  // ── FINDING 8 ────────────────────────────────────────────────────────────
  it('re-queues a failed append and succeeds on the next attempt', async () => {
    const p = make()
    responder = (type) => (type === 'agent_msg.log_append' ? null : {})
    p.persistAppend([row('u1', 'queued')])
    await vi.advanceTimersByTimeAsync(MSG_LOG_FLUSH_MS)
    expect(types()).toEqual(['append'])

    responder = () => ({})
    await vi.advanceTimersByTimeAsync(MSG_LOG_FLUSH_MS)
    expect(types()).toEqual(['append', 'append'])
    expect(calls[1].payload.rows).toEqual([row('u1', 'queued')])
  })

  it('a re-queued append does not clobber a newer write for the same uid', async () => {
    const p = make()
    responder = (type) => (type === 'agent_msg.log_append' ? null : {})
    p.persistAppend([row('u1', 'queued')])
    await vi.advanceTimersByTimeAsync(MSG_LOG_FLUSH_MS)
    // The row moved on while the failed append was in flight.
    p.persistAppend([row('u1', 'delivered')])
    responder = () => ({})
    await vi.advanceTimersByTimeAsync(MSG_LOG_FLUSH_MS)
    expect(calls[1].payload.rows).toEqual([row('u1', 'delivered')])
  })

  it('holds writes while disconnected and drains them on connect', async () => {
    const p = make()
    connected = false
    p.persistAppend([row('u1', 'queued')])
    await vi.advanceTimersByTimeAsync(MSG_LOG_FLUSH_MS * 3)
    expect(calls).toEqual([])

    connected = true
    p.onConnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(types()).toContain('append')
  })

  // ── FINDING 4 ────────────────────────────────────────────────────────────
  it('a clear cannot overtake an append batch already in flight', async () => {
    const p = make()
    let releaseAppend = (): void => {}
    responder = (type) =>
      type === 'agent_msg.log_append'
        ? new Promise((resolve) => { releaseAppend = () => resolve({}) })
        : {}

    p.persistAppend([row('u1', 'delivered')])
    await vi.advanceTimersByTimeAsync(MSG_LOG_FLUSH_MS)
    expect(types()).toEqual(['append'])

    // The user clears while that append is still awaiting its response. Fired
    // straight out, the clear could reach the store first and the append would
    // then resurrect the rows it deleted.
    p.persistClear(KEEP)
    await vi.advanceTimersByTimeAsync(MSG_LOG_FLUSH_MS)
    expect(types()).toEqual(['append'])

    releaseAppend()
    await vi.advanceTimersByTimeAsync(MSG_LOG_FLUSH_MS)
    expect(types()).toEqual(['append', 'clear'])
    expect(calls[1].payload).toEqual({ keep_statuses: KEEP })
  })

  it('drops a pending row whose pending patch takes it out of the kept statuses', async () => {
    const p = make()
    // Appended as `queued`, delivered before the 200 ms flush — the batch would
    // be written as `delivered`, so the clear must drop it rather than let it
    // land after the clear and resurrect a row the user removed.
    p.persistAppend([row('u1', 'queued')])
    p.persistUpdate([{ uid: 'u1', status: 'delivered', delivered_at: 3 }])
    p.persistClear(KEEP)
    await vi.advanceTimersByTimeAsync(MSG_LOG_FLUSH_MS)
    expect(types()).toEqual(['clear'])
  })

  it('keeps a pending row the clear preserves', async () => {
    const p = make()
    p.persistAppend([row('u1', 'queued')])
    p.persistClear(KEEP)
    await vi.advanceTimersByTimeAsync(MSG_LOG_FLUSH_MS)
    // Clear first: it only deletes what is already in the store, and the row
    // behind it is one it deliberately keeps.
    expect(types()).toEqual(['clear', 'append'])
    expect(calls[1].payload.rows).toEqual([row('u1', 'queued')])
  })

  // ── FINDING 5 ────────────────────────────────────────────────────────────
  it('the exit path emits the update batch without awaiting the append', () => {
    const p = make()
    // During unload no response ever comes back; awaiting the append stranded
    // the update batch, which is exactly what this path exists to save.
    responder = () => new Promise(() => {})
    p.persistAppend([row('u1', 'queued')])
    p.persistUpdate([{ uid: 'u2', status: 'delivered', delivered_at: 7 }])
    p.flushOnExit()
    expect(types()).toEqual(['append', 'update'])
    expect(calls[1].payload.updates).toEqual([{ uid: 'u2', status: 'delivered', delivered_at: 7 }])
  })

  it('the exit path still fires while an ordinary flush is in flight', async () => {
    const p = make()
    responder = () => new Promise(() => {})
    p.persistAppend([row('u1', 'queued')])
    await vi.advanceTimersByTimeAsync(MSG_LOG_FLUSH_MS)
    expect(types()).toEqual(['append'])
    p.persistUpdate([{ uid: 'u1', status: 'delivered' }])
    p.flushOnExit()
    expect(types()).toEqual(['append', 'update'])
  })

  // ── FINDING 6 ────────────────────────────────────────────────────────────
  it('retries a timed-out hydrate on connect, exactly once', async () => {
    const p = make()
    responder = (type) => (type === 'agent_msg.log_snapshot' ? null : {})
    await p.hydrate()
    expect(types()).toEqual(['snapshot'])
    expect(hydrated).toEqual([])

    responder = (type) =>
      type === 'agent_msg.log_snapshot' ? { rows: [row('u1', 'delivered')] } : {}
    p.onConnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(hydrated).toEqual([[row('u1', 'delivered')]])

    // A later reconnect must not re-import the (global) store on top of the log.
    p.onConnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(hydrated).toHaveLength(1)
    expect(types().filter((t) => t === 'snapshot')).toHaveLength(2)
  })

  it('a successful hydrate is never repeated', async () => {
    const p = make()
    responder = (type) => (type === 'agent_msg.log_snapshot' ? { rows: [] } : {})
    await p.hydrate()
    await p.hydrate()
    p.onConnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(types()).toEqual(['snapshot'])
    expect(hydrated).toEqual([[]])
  })
})
