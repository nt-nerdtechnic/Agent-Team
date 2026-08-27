import { expect, expectTypeOf, describe, it } from 'vitest'
import { ref } from 'vue'
import type { useBackend, WsResponse, BackendStatus } from '../useBackend'
import { createHostGitTransport, type HostGitBackend } from '../hostGitTransport'
import type {
  GitEventType,
  GitRequestType,
  GitTransport,
  GitTransportError,
} from '../../../../shared/gitCompatibility'
import type {
  GitTransportContractHarness,
  GitTransportRequestRecord,
} from '../../../../shared/gitCompatibility.testing'
import { runGitTransportContract } from '../../../../shared/gitCompatibility.testing'

interface HostHarness {
  backend: HostGitBackend
  sent: GitTransportRequestRecord[]
  emit(type: GitEventType, payload: unknown): void
  setResponse<TPayload>(
    type: GitRequestType,
    payload: TPayload,
    options?: { ok?: boolean; error?: GitTransportError | null },
  ): void
}

function createHostHarness(): HostHarness {
  const status = ref<BackendStatus>('connected')
  const listeners = new Map<GitEventType, Set<(payload: unknown) => void>>()
  const responses = new Map<GitRequestType, WsResponse>()
  const sent: GitTransportRequestRecord[] = []

  async function send<TPayload = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<WsResponse<TPayload>> {
    // The adapter must bind the feature contract's default instead of leaving
    // the effective deadline to an adapter-specific fallback.
    sent.push({ type: type as GitRequestType, payload, timeoutMs: timeoutMs ?? Number.NaN })
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

  const backend = { status, send, on } satisfies HostGitBackend
  return { backend, sent, emit, setResponse }
}

function createContractHarness(): GitTransportContractHarness {
  const harness = createHostHarness()
  return {
    transport: createHostGitTransport(harness.backend),
    sent: harness.sent,
    emit: harness.emit,
    setResponse: harness.setResponse,
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

  it('normalizes a concrete backend rejection into the shared error envelope', async () => {
    const harness = createHostHarness()
    const backend: HostGitBackend = {
      ...harness.backend,
      send: async () => { throw new Error('socket closed') },
    }
    await expect(createHostGitTransport(backend).send('git.status')).resolves.toEqual({
      ok: false,
      payload: null,
      error: { code: 'BACKEND_ERROR', message: 'socket closed' },
    })
  })
})
