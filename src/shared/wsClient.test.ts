import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createWsClient, type WsClientStatus } from './wsClient'

// Same minimal WebSocket stand-in the useBackend tests use: records instances,
// lets a test flip readyState and fire events.
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  url: string
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  closed = false
  private listeners = new Map<string, Set<(ev: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) { set = new Set(); this.listeners.set(type, set) }
    set.add(cb)
  }

  send(data: string): void { this.sent.push(data) }

  closeCode?: number
  closeReason?: string

  close(code?: number, reason?: string): void {
    this.closed = true
    this.closeCode = code
    this.closeReason = reason
    this.readyState = FakeWebSocket.CLOSED
    this.fire('close', {})
  }

  /** A server-pushed event, as `terminal.output` arrives. */
  push(type: string): void {
    this.fire('message', { data: JSON.stringify({ id: '', type, payload: {}, timestamp: '' }) })
  }

  fire(type: string, ev: unknown): void {
    this.listeners.get(type)?.forEach((cb) => cb(ev))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.fire('open', {})
  }

  lastReq(): { id: string; type: string; payload: unknown } {
    return JSON.parse(this.sent[this.sent.length - 1])
  }

  reply(id: string, type: string, payload: unknown, ok = true): void {
    this.fire('message', {
      data: JSON.stringify({ id, type: `${type}.result`, ok, payload, error: null, timestamp: '' })
    })
  }
}

describe('createWsClient', () => {
  const URL = 'ws://127.0.0.1:8765/ws'
  let statuses: WsClientStatus[]

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    statuses = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function makeClient() {
    return createWsClient({ onStatus: (s) => statuses.push(s) })
  }

  it('connects and reports connecting → connected', () => {
    const c = makeClient()
    c.connect(URL)
    expect(statuses).toEqual(['connecting'])
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0].open()
    expect(statuses).toEqual(['connecting', 'connected'])
  })

  it('round-trips a request to a response by id', async () => {
    const c = makeClient()
    c.connect(URL)
    const sock = FakeWebSocket.instances[0]
    sock.open()
    const p = c.send('fs.read_file', { rel_path: 'a.txt' })
    const req = sock.lastReq()
    expect(req.type).toBe('fs.read_file')
    sock.reply(req.id, 'fs.read_file', { content: 'hi' })
    await expect(p).resolves.toMatchObject({ ok: true, payload: { content: 'hi' } })
  })

  it('queues sends made before open and flushes them on connect', async () => {
    const c = makeClient()
    c.connect(URL)
    const sock = FakeWebSocket.instances[0]
    const p = c.send('fs.list_dir', {})
    expect(sock.sent).toHaveLength(0) // parked in the queue
    sock.open()
    expect(sock.sent).toHaveLength(1) // flushed
    const req = sock.lastReq()
    sock.reply(req.id, 'fs.list_dir', { entries: [] })
    await expect(p).resolves.toMatchObject({ ok: true })
  })

  it('dispatches server-pushed events by type', () => {
    const c = makeClient()
    c.connect(URL)
    const sock = FakeWebSocket.instances[0]
    sock.open()
    const seen: unknown[] = []
    c.on('git.changed', (p) => seen.push(p))
    sock.fire('message', {
      data: JSON.stringify({ id: 'evt', type: 'git.changed', payload: { workspace_path: '/repo' }, timestamp: '' })
    })
    expect(seen).toEqual([{ workspace_path: '/repo' }])
  })

  it('stays down after an unexpected close instead of reconnecting itself', () => {
    const c = makeClient()
    c.connect(URL)
    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].close()
    expect(statuses).toContain('disconnected')
    // No backoff timer exists: the socket comes back only when the caller
    // asks for it (backend:changed → connect, system resume → reconnectNow).
    vi.advanceTimersByTime(300_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('reset() tears down without reconnecting and rejects in-flight with the reason', async () => {
    const c = makeClient()
    c.connect(URL)
    const sock = FakeWebSocket.instances[0]
    sock.open()
    const inflight = c.send('fs.read_file', {}).catch((e: Error) => e)
    c.reset('backend changed')
    await expect(inflight).resolves.toMatchObject({ message: 'backend changed' })
    expect(sock.closed).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1) // nothing reconnects on its own
  })

  it('markErrored() makes sends fail fast instead of queueing', async () => {
    const c = makeClient()
    c.connect(URL)
    c.reset('backend gone')
    c.markErrored()
    await expect(c.send('fs.read_file', {})).rejects.toThrow('ws not open')
  })

  it('isHealthyFor reflects the current url and socket state', () => {
    const c = makeClient()
    c.connect(URL)
    FakeWebSocket.instances[0].open()
    expect(c.isHealthyFor(URL)).toBe(true)
    expect(c.isHealthyFor('ws://other/ws')).toBe(false)
    c.reset('x')
    expect(c.isHealthyFor(URL)).toBe(false)
  })

  it('never probes an idle socket and never force-closes one', async () => {
    const c = makeClient()
    c.connect(URL)
    const sock = FakeWebSocket.instances[0]
    sock.open()
    // A backend saturated by terminal output answers late or not at all. The
    // client has no opinion about that: it sends nothing on its own and the
    // socket is never closed from this side.
    await vi.advanceTimersByTimeAsync(300_000)
    expect(sock.sent).toEqual([])
    expect(sock.closed).toBe(false)
    expect(statuses).toEqual(['connecting', 'connected'])
  })

  it('reconnects on reconnectNow, the caller-driven recovery path', async () => {
    const c = makeClient()
    c.connect(URL)
    const first = FakeWebSocket.instances[0]
    first.open()

    c.reconnectNow('system resumed')

    // A new socket exists right away — no timer had to fire.
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(first.closed).toBe(true)
    expect(statuses).toEqual(['connecting', 'connected', 'disconnected', 'connecting'])

    // The discarded socket's close must not spawn a competing socket.
    await vi.advanceTimersByTimeAsync(300_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('ignores reconnectNow after dispose', () => {
    const c = makeClient()
    c.connect(URL)
    FakeWebSocket.instances[0].open()
    c.dispose('shutting down')
    c.reconnectNow('system resumed')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
