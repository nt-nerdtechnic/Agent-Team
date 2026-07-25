import { ref, effectScope, type EffectScope } from 'vue'
import type { useBackend, WsResponse, BackendStatus } from '../useBackend'

// Lightweight stand-in for useBackend() used by composable tests. It records
// outgoing send() calls, lets a test preset per-type responses, and exposes
// emit() to simulate backend broadcasts to `on()` subscribers. No real
// WebSocket — every composable that takes `ReturnType<typeof useBackend>` can
// be driven deterministically.

export interface SentRecord {
  type: string
  payload: Record<string, unknown>
}

type Backend = ReturnType<typeof useBackend>

export function createMockBackend(initialStatus: BackendStatus = 'connected') {
  const status = ref<BackendStatus>(initialStatus)
  const wsUrl = ref('')
  const httpUrl = ref('')
  const lastError = ref('')

  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const responses = new Map<string, WsResponse>()
  const sent: SentRecord[] = []

  function on(type: string, cb: (p: unknown) => void): () => void {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    set.add(cb)
    return () => set!.delete(cb)
  }

  /** Simulate a backend broadcast to every `on(type)` subscriber. */
  function emit(type: string, payload: unknown): void {
    listeners.get(type)?.forEach((cb) => cb(payload))
  }

  async function send<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<WsResponse<T>> {
    sent.push({ type, payload })
    const preset = responses.get(type)
    if (preset) return preset as WsResponse<T>
    return { id: 't', type, ok: true, payload: null, error: null, timestamp: '' } as WsResponse<T>
  }

  function setResponse<T>(
    type: string,
    payload: T,
    opts: {
      ok?: boolean
      error?: { code: string; message: string; details?: Record<string, unknown> }
    } = {}
  ): void {
    const ok = opts.ok ?? true
    responses.set(type, {
      id: 't',
      type,
      ok,
      payload: ok ? (payload as unknown) : null,
      error: opts.error ?? null,
      timestamp: ''
    })
  }

  const backend = { status, wsUrl, httpUrl, lastError, send, on } as unknown as Backend

  return { backend, status, emit, setResponse, sent }
}

/** Run a composable inside its own effect scope so `watch`/`onScopeDispose`
 *  behave as they would in a component. Returns the composable result plus a
 *  `stop()` to trigger cleanup (clears intervals/listeners). */
export function withScope<T>(fn: () => T): { result: T; scope: EffectScope } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, scope }
}

/** Flush pending microtasks + a macrotask so awaited send() chains settle. */
export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}
