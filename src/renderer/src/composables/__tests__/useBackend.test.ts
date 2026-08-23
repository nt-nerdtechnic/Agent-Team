// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, type EffectScope } from 'vue'
import { useBackend } from '../useBackend'

// Minimal WebSocket stand-in: records instances, lets tests flip readyState
// and fire events. Installed on globalThis so useBackend's `new WebSocket()`
// and readyState constants resolve to it.
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
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(cb)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
    this.fire('close', {})
  }

  fire(type: string, ev: unknown): void {
    this.listeners.get(type)?.forEach((cb) => cb(ev))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.fire('open', {})
  }
}

const READY_INFO = {
  status: 'ready' as const,
  wsUrl: 'ws://127.0.0.1:8765/ws',
  httpUrl: 'http://127.0.0.1:8765',
  shell: '/bin/zsh',
  port: 8765,
  pid: 4242
}

describe('useBackend applyBackendChanged', () => {
  let scope: EffectScope
  let backendChangedCb: ((info: unknown) => void) | undefined
  let systemResumedCb: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    backendChangedCb = undefined
    systemResumedCb = undefined
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('agentTeam', {
      getBackendInfo: vi.fn().mockResolvedValue(READY_INFO),
      onBackendChanged: (cb: (info: unknown) => void) => {
        backendChangedCb = cb
      },
      onSystemResumed: (cb: () => void) => {
        systemResumedCb = cb
        return () => { systemResumedCb = undefined }
      }
    })
  })

  afterEach(() => {
    scope?.stop()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function setupConnected() {
    let backend!: ReturnType<typeof useBackend>
    scope = effectScope()
    scope.run(() => {
      backend = useBackend()
    })
    // Let init()'s getBackendInfo poll resolve and connect().
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances).toHaveLength(1)
    const socket = FakeWebSocket.instances[0]
    socket.open()
    return { backend, socket }
  }

  it('keeps the healthy socket and in-flight requests on a same-backend ready snapshot', async () => {
    const { backend, socket } = await setupConnected()

    // In-flight request (the CLI pane's terminal.create at launch).
    const inflight = backend.send('terminal.create', { pane_id: 'p1' })
    const settled = vi.fn()
    inflight.then(settled, settled)
    expect(socket.sent.length).toBeGreaterThan(0)

    // The queued startup broadcast flushed on window focus: same backend.
    backendChangedCb!(READY_INFO)
    await vi.advanceTimersByTimeAsync(0)

    expect(socket.closed).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(1) // no reconnect
    expect(settled).not.toHaveBeenCalled() // not rejected with 'backend changed'
    expect(backend.status.value).toBe('connected')

    // The snapshot's metadata still lands (init() doesn't set port/pid).
    expect(backend.port.value).toBe(8765)
    expect(backend.pid.value).toBe(4242)

    // Resolve the in-flight request normally to confirm it stayed alive.
    const req = JSON.parse(socket.sent[socket.sent.length - 1]) as { id: string }
    socket.fire('message', {
      data: JSON.stringify({ id: req.id, type: 'terminal.create', ok: true, payload: {}, error: null, timestamp: '' })
    })
    await expect(inflight).resolves.toMatchObject({ ok: true })
  })

  it('still tears down and reconnects when the backend actually changed (new wsUrl)', async () => {
    const { backend, socket } = await setupConnected()

    // Catch immediately: the rejection fires synchronously inside the
    // backend:changed handler, before an `expect(...).rejects` could attach.
    const inflight = backend.send('terminal.create', { pane_id: 'p1' }).catch((err: Error) => err)

    backendChangedCb!({ ...READY_INFO, wsUrl: 'ws://127.0.0.1:9999/ws', port: 9999 })
    await vi.advanceTimersByTimeAsync(0)

    await expect(inflight).resolves.toMatchObject({ message: 'backend changed' })
    expect(socket.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1].url).toBe('ws://127.0.0.1:9999/ws')
  })

  it('reconnects when the snapshot matches but the socket is already dead', async () => {
    const { socket } = await setupConnected()

    socket.readyState = FakeWebSocket.CLOSED

    backendChangedCb!(READY_INFO)
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeWebSocket.instances).toHaveLength(2) // tore down and reconnected
  })

  it('reaches the terminal error state when main reports a backend crash', async () => {
    const { backend, socket } = await setupConnected()

    // Main's crash watcher broadcasts an error snapshot when the backend
    // process dies after a successful start.
    backendChangedCb!({ status: 'error', error: 'backend exited unexpectedly (code 1)' })
    await vi.advanceTimersByTimeAsync(0)

    expect(backend.status.value).toBe('error')
    expect(backend.lastError.value).toBe('backend exited unexpectedly (code 1)')
    expect(socket.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(1) // no reconnect loop against the dead port

    // send() fail-fasts instead of queueing forever against a dead backend.
    await expect(backend.send('fs.write_file', {})).rejects.toThrow('ws not open')
  })

  it('rebuilds the socket when the machine wakes', async () => {
    const { backend, socket } = await setupConnected()

    // Sleep severs the TCP connection without touching readyState, so the
    // socket still looks alive — no close event, no status transition.
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)

    systemResumedCb!()
    await vi.advanceTimersByTimeAsync(0)

    expect(socket.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(2) // reconnected without waiting for the watchdog
    FakeWebSocket.instances[1].open()
    expect(backend.status.value).toBe('connected')
  })

  it('stops listening for resumes once the scope is disposed', async () => {
    await setupConnected()
    scope.stop()
    expect(systemResumedCb).toBeUndefined()
  })
})

describe('useBackend init() deadline', () => {
  let scope: EffectScope

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    scope?.stop()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function setup(agentTeam: Record<string, unknown>): ReturnType<typeof useBackend> {
    vi.stubGlobal('agentTeam', agentTeam)
    let backend!: ReturnType<typeof useBackend>
    scope = effectScope()
    scope.run(() => {
      backend = useBackend()
    })
    return backend
  }

  it('keeps polling past 50s when the configured health timeout is higher', async () => {
    const getBackendInfo = vi.fn().mockResolvedValue({ status: 'starting' })
    const backend = setup({
      getBackendInfo,
      readHealthCheckTimeout: vi.fn().mockResolvedValue({ ok: true, timeoutSec: 120 }),
      onBackendChanged: vi.fn()
    })

    // The old hardcoded deadline flipped to a false 'backend did not start'
    // error at 50s while main was still legitimately waiting on /health.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(backend.status.value).not.toBe('error')

    // Slow-but-successful start: init() is still polling and connects.
    getBackendInfo.mockResolvedValue(READY_INFO)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(backend.status.value).toBe('connecting')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('gives up with an error once the configured deadline passes', async () => {
    const backend = setup({
      getBackendInfo: vi.fn().mockResolvedValue({ status: 'starting' }),
      readHealthCheckTimeout: vi.fn().mockResolvedValue({ ok: true, timeoutSec: 15 }),
      onBackendChanged: vi.fn()
    })

    // 15s configured + 5s margin → errors shortly after 20s.
    await vi.advanceTimersByTimeAsync(25_000)
    expect(backend.status.value).toBe('error')
    expect(backend.lastError.value).toBe('backend did not start')
  })

  it('falls back to the 45s default when the setting is unavailable', async () => {
    const backend = setup({
      getBackendInfo: vi.fn().mockResolvedValue({ status: 'starting' }),
      onBackendChanged: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(45_000)
    expect(backend.status.value).not.toBe('error')

    await vi.advanceTimersByTimeAsync(10_000) // past 45s + 5s margin
    expect(backend.status.value).toBe('error')
  })
})
