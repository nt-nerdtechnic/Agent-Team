import { expect, expectTypeOf, describe, it } from 'vitest'
import { ref } from 'vue'
import type { useBackend, WsResponse, BackendStatus } from '../useBackend'
import { createHostGitTransport, type HostGitBackend } from '../hostGitTransport'
import type {
  GitEventType,
  GitRequestType,
  GitTransport,
  GitTransportError,
} from '../../../../../packages/features/git/src'
import type {
  GitTransportContractHarness,
  GitTransportRequestRecord,
} from '../../../../../packages/features/git/src/__tests__/gitTransport.contract'
import { runGitTransportContract } from '../../../../../packages/features/git/src/__tests__/gitTransport.contract'

interface HostHarness {
  backend: HostGitBackend
  sent: GitTransportRequestRecord[]
  emit(type: GitEventType, payload: unknown): void
  setResponse<TPayload>(
    type: GitRequestType,
    payload: TPayload,
    options?: { ok?: boolean; error?: GitTransportError | null },
  ): void
  setRejection(type: GitRequestType, error?: Error | string): void
  clearRejection(type: GitRequestType): void
}

function createHostHarness(): HostHarness {
  const status = ref<BackendStatus>('connected')
  const listeners = new Map<GitEventType, Set<(payload: unknown) => void>>()
  const responses = new Map<GitRequestType, WsResponse>()
  const rejections = new Map<GitRequestType, Error>()
  const sent: GitTransportRequestRecord[] = []

  async function send<TPayload = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<WsResponse<TPayload>> {
    // The adapter must bind the feature contract's default instead of leaving
    // the effective deadline to an adapter-specific fallback.
    sent.push({ type: type as GitRequestType, payload, timeoutMs: timeoutMs ?? Number.NaN })
    const rejection = rejections.get(type as GitRequestType)
    if (rejection) throw rejection
    const response = responses.get(type as GitRequestType)
    return (response ?? {
      id: 'test-request',
      type,
      ok: true,
      payload: null,
      error: null,
      timestamp: '',
    }) as WsResponse<TPayload>
  }

  function on(type: string, callback: (payload: unknown) => void): () => void {
    const eventType = type as GitEventType
    let callbacks = listeners.get(eventType)
    if (!callbacks) {
      callbacks = new Set()
      listeners.set(eventType, callbacks)
    }
    callbacks.add(callback)
    return () => callbacks?.delete(callback)
  }

  function emit(type: GitEventType, payload: unknown): void {
    for (const callback of [...(listeners.get(type) ?? [])]) {
      try {
        callback(payload)
      } catch {
        // Match the concrete shared WebSocket client: one listener cannot
        // prevent the remaining listeners from receiving an event.
      }
    }
  }

  function setResponse<TPayload>(
    type: GitRequestType,
    payload: TPayload,
    options: { ok?: boolean; error?: GitTransportError | null } = {},
  ): void {
    const ok = options.ok ?? true
    responses.set(type, {
      id: 'test-response',
      type,
      ok,
      payload: ok ? payload : null,
      error: options.error ?? null,
      timestamp: '',
    })
  }

  function setRejection(type: GitRequestType, error: Error | string = 'ws not open'): void {
    rejections.set(type, typeof error === 'string' ? new Error(error) : error)
  }

  function clearRejection(type: GitRequestType): void {
    rejections.delete(type)
  }

  const backend = { status, send, on } satisfies HostGitBackend
  return { backend, sent, emit, setResponse, setRejection, clearRejection }
}

function createContractHarness(): GitTransportContractHarness {
  const harness = createHostHarness()
  return {
    transport: createHostGitTransport(harness.backend),
    sent: harness.sent,
    emit: harness.emit,
    setResponse: harness.setResponse,
    setRejection: harness.setRejection,
    clearRejection: harness.clearRejection,
  }
}

runGitTransportContract(createContractHarness)

describe('Host Git WebSocket adapter', () => {
  it('keeps the Host backend structurally compatible with GitTransport', () => {
    expectTypeOf<ReturnType<typeof useBackend>>().toMatchTypeOf<GitTransport>()
  })

  it('maps the WebSocket response to the feature envelope without changing errors', async () => {
    const harness = createHostHarness()
    const transport = createHostGitTransport(harness.backend)
    const response = { ok: false, error: 'nested git failure' }
    harness.setResponse('git.status', response)

    await expect(transport.send('git.status', { workspace_path: '/workspace' })).resolves.toEqual({
      ok: true,
      payload: response,
      error: null,
    })
    expect(harness.sent[0]?.timeoutMs).toBe(10_000)
  })
})
