// Shared WebSocket transport — the request/response + event plumbing extracted
// from the renderer's `useBackend` composable so the Electron main process
// (plugin capability broker) can reuse the exact same transport semantics.
//
// This module is deliberately framework-free: no Vue, no `window`, no
// `electron`. It resolves its WebSocket constructor at connect time
// (`globalThis.WebSocket` by default, or an injected impl — `ws` in the main
// process, a Fake in tests), so it runs unchanged under Node, Electron main,
// and a browser/happy-dom renderer.

export interface WsRequest<TPayload = Record<string, unknown>> {
  id: string
  type: string
  payload: TPayload
  timestamp: string
}

export interface WsResponse<TPayload = unknown> {
  id: string
  type: string
  ok: boolean
  payload: TPayload | null
  error: { code: string; message: string; details?: Record<string, unknown> } | null
  timestamp: string
}

export type WsClientStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

/** Minimal structural view of a WebSocket, satisfied by browser `WebSocket`,
 *  the `ws` package, and the test Fake alike. */
interface WsLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, cb: (ev: unknown) => void): void
}
/** Constructor shape the client needs. Exported so a caller injecting a
 *  non-DOM impl (e.g. the `ws` package in Electron main) can cast to it. */
export interface WsConstructor {
  new (url: string): WsLike
  readonly OPEN: number
  readonly CONNECTING: number
}
type WsCtor = WsConstructor

export interface WsClientOptions {
  /** Called on every transport status transition. */
  onStatus?: (status: WsClientStatus) => void
  /** Called with a human message when the socket raises an error event. */
  onError?: (message: string) => void
  /** WebSocket constructor override; defaults to `globalThis.WebSocket`. */
  WebSocketImpl?: WsCtor
  /** Bound on the reconnect send queue. Default 200. */
  maxSendQueue?: number
  /** Reconnect backoff base / cap (ms). Defaults 1500 / 30000. */
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

export interface WsClient {
  /** Issue a request; resolves with the response envelope, rejects on
   *  timeout / closed-for-good. Queued while mid-reconnect. */
  send<T = unknown>(type: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<WsResponse<T>>
  /** Subscribe to server-pushed events of `type`. Returns a disposer. */
  on(type: string, cb: (payload: unknown) => void): () => void
  /** (Re)connect to `url`. Clears any prior errored/fail-fast state. */
  connect(url: string): void
  /** Tear down the socket + timers and reject everything in flight with
   *  `reason`, WITHOUT scheduling a reconnect or emitting a status. The caller
   *  decides the next state (see `useBackend.applyBackendChanged`). */
  reset(reason: string): void
  /** Tear down and reconnect immediately, skipping the backoff. For when the
   *  socket is known-dead but hasn't reported it yet — after a system resume,
   *  the old TCP connection is gone while `readyState` still reads OPEN. */
  reconnectNow(reason: string): void
  /** Put the client into fail-fast mode: subsequent sends reject instead of
   *  queueing (used when the backend has errored for good). */
  markErrored(): void
  /** True when currently connected/connecting to exactly `url`. */
  isHealthyFor(url: string): boolean
  currentUrl(): string
  /** Permanent teardown. */
  dispose(reason: string): void
}

function nowIso(): string {
  return new Date().toISOString()
}

function uuid(): string {
  return globalThis.crypto.randomUUID()
}

export function createWsClient(opts: WsClientOptions = {}): WsClient {
  const maxSendQueue = opts.maxSendQueue ?? 200
  const reconnectBaseMs = opts.reconnectBaseMs ?? 1_500
  const reconnectMaxMs = opts.reconnectMaxMs ?? 30_000

  let url = ''
  let socket: WsLike | null = null
  let activeCtor: WsCtor | null = null
  let disposed = false
  let errored = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempts = 0

  interface PendingEntry { resolve: (resp: WsResponse) => void; reject: (err: Error) => void }
  const pending = new Map<string, PendingEntry>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  interface QueuedRequest { req: WsRequest; settle: PendingEntry }
  const sendQueue: QueuedRequest[] = []

  function resolveCtor(): WsCtor {
    const ctor = opts.WebSocketImpl ?? (globalThis as { WebSocket?: WsCtor }).WebSocket
    if (!ctor) throw new Error('no WebSocket implementation available')
    return ctor
  }

  function setStatus(s: WsClientStatus): void {
    opts.onStatus?.(s)
  }

  function emit(type: string, payload: unknown): void {
    const set = listeners.get(type)
    if (!set) return
    for (const cb of set) {
      try {
        cb(payload)
      } catch (err) {
        console.error('[wsClient] listener error', err)
      }
    }
  }

  function on(type: string, cb: (payload: unknown) => void): () => void {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
    }
  }

  function writeToSocket(sock: WsLike, req: WsRequest, settle: PendingEntry): void {
    pending.set(req.id, settle)
    sock.send(JSON.stringify(req))
  }

  function flushSendQueue(sock: WsLike): void {
    const items = sendQueue.splice(0)
    for (const { req, settle } of items) writeToSocket(sock, req, settle)
  }

  function rejectSendQueue(err: Error): void {
    const items = sendQueue.splice(0)
    for (const { settle } of items) settle.reject(err)
  }

  function isOpen(sock: WsLike | null, ctor: WsCtor | null): boolean {
    return sock !== null && ctor !== null && sock.readyState === ctor.OPEN
  }

  function rawSend<T>(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<WsResponse<T>> {
    return new Promise((resolve, reject) => {
      const req: WsRequest = { id: uuid(), type, payload, timestamp: nowIso() }
      let timerId: ReturnType<typeof setTimeout>
      const settle: PendingEntry = {
        resolve: (resp: WsResponse) => { clearTimeout(timerId); resolve(resp as WsResponse<T>) },
        reject: (err: Error) => { clearTimeout(timerId); reject(err) },
      }
      const canSend = isOpen(socket, activeCtor)

      // Fail fast when there is no reconnect to wait for (disposed / errored).
      if (!canSend && (disposed || errored)) {
        reject(new Error('ws not open'))
        return
      }

      // One timer covers queue-wait plus in-flight; on fire, drop the request
      // from wherever it sits so a later reconnect can't replay it.
      timerId = setTimeout(() => {
        pending.delete(req.id)
        const qi = sendQueue.findIndex((q) => q.req.id === req.id)
        if (qi !== -1) sendQueue.splice(qi, 1)
        reject(new Error(`request ${type} timeout`))
      }, timeoutMs)

      if (canSend && socket) {
        writeToSocket(socket, req, settle)
      } else if (sendQueue.length >= maxSendQueue) {
        clearTimeout(timerId)
        reject(new Error('ws not open'))
      } else {
        sendQueue.push({ req, settle })
      }
    })
  }

  function send<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 10_000
  ): Promise<WsResponse<T>> {
    return rawSend<T>(type, payload, timeoutMs)
  }

  function clearTimers(): void {
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
  }

  // There is deliberately no client-side liveness probe. One cannot tell a
  // saturated backend from a dead one: every send on a session serialises
  // behind one lock, so a pong queues behind whatever 64 KB terminal chunk is
  // in flight and a few busy panes hold it past any timeout. Force-closing
  // there costs a full reattach (PTY, git status, settings reconcile, pane
  // re-registration) and makes the stall worse. Detecting a genuinely dead
  // connection is the backend's job -- uvicorn runs its own protocol-level
  // heartbeat (ws_ping_interval / ws_ping_timeout in __main__.py) and closes
  // the socket, which lands in the close handler below and reconnects.

  function connect(url_?: string): void {
    if (url_ !== undefined) url = url_
    if (!url || disposed) return
    errored = false
    const ctor = resolveCtor()
    setStatus('connecting')
    const sock = new ctor(url)
    socket = sock
    activeCtor = ctor

    sock.addEventListener('open', () => {
      if (socket !== sock) return // superseded by a reset/reconnect swap
      setStatus('connected')
      reconnectAttempts = 0
      flushSendQueue(sock)
    })

    sock.addEventListener('message', (ev) => {
      const data = (ev as { data?: unknown }).data
      let msg: WsResponse
      try {
        msg = JSON.parse(typeof data === 'string' ? data : '') as WsResponse
      } catch (err) {
        console.error('[wsClient] bad message', err)
        return
      }
      if ('ok' in msg && msg.ok !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!
        pending.delete(msg.id)
        entry.resolve(msg)
        return
      }
      emit(msg.type, (msg as unknown as WsRequest).payload)
    })

    sock.addEventListener('close', () => {
      // A reset/reconnect swap reassigns `socket` before closing this one; if
      // we're no longer the active socket, ignore the close so it can't
      // schedule a competing reconnect.
      if (socket !== sock) return
      socket = null
      for (const [, entry] of pending) entry.reject(new Error('WebSocket closed'))
      pending.clear()
      if (disposed) return
      errored = false
      setStatus('disconnected')
      // Exponential backoff: 1.5 s → 3 s → 6 s → … capped at 30 s.
      const delay = Math.min(reconnectBaseMs * Math.pow(2, reconnectAttempts), reconnectMaxMs)
      reconnectAttempts++
      reconnectTimer = setTimeout(() => connect(), delay)
    })

    sock.addEventListener('error', () => {
      if (socket !== sock) return // superseded by a reset/reconnect swap
      errored = true
      setStatus('error')
      opts.onError?.('WebSocket error')
    })
  }

  function reset(reason: string): void {
    clearTimers()
    reconnectAttempts = 0
    const old = socket
    socket = null // so the old socket's close handler is a no-op
    if (old) { try { old.close() } catch { /* already torn down */ } }
    for (const [, entry] of pending) entry.reject(new Error(reason))
    pending.clear()
    rejectSendQueue(new Error(reason))
  }

  function reconnectNow(reason: string): void {
    if (disposed || !url) return
    // reset() nulls `socket` first, so the old socket's close handler is a
    // no-op and cannot schedule a competing backoff reconnect.
    reset(reason)
    setStatus('disconnected')
    connect()
  }

  function markErrored(): void {
    errored = true
  }

  function isHealthyFor(target: string): boolean {
    return (
      target === url &&
      socket !== null &&
      activeCtor !== null &&
      (socket.readyState === activeCtor.OPEN || socket.readyState === activeCtor.CONNECTING)
    )
  }

  function dispose(reason: string): void {
    disposed = true
    clearTimers()
    rejectSendQueue(new Error(reason))
    const old = socket
    socket = null
    if (old) { try { old.close() } catch { /* already torn down */ } }
    for (const [, entry] of pending) entry.reject(new Error(reason))
    pending.clear()
  }

  return {
    send,
    on,
    connect: (u: string) => connect(u),
    reset,
    reconnectNow,
    markErrored,
    isHealthyFor,
    currentUrl: () => url,
    dispose,
  }
}
