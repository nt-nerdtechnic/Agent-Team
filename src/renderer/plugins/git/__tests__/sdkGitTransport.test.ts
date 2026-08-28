import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  type GitEventType,
  type GitRequestType,
  type GitTransport,
  type GitTransportError,
  type GitTransportStatusSource,
} from '../../../../shared/gitCompatibility'
import {
  createPluginGitTransport,
  type PluginGitSdk,
  type PluginGitSdkResponse,
} from '../sdkGitTransport'
import type {
  GitTransportContractHarness,
  GitTransportRequestRecord,
} from '../../../../shared/gitCompatibility.testing'
import { runGitTransportContract } from '../../../../shared/gitCompatibility.testing'

interface SdkHarness {
  readonly sdk: PluginGitSdk
  readonly sent: GitTransportRequestRecord[]
  emit(type: GitEventType, payload: unknown): void
  setResponse<TPayload>(
    type: GitRequestType,
    payload: TPayload,
    options?: { ok?: boolean; error?: GitTransportError | null },
  ): void
}

function createSdkHarness(): SdkHarness {
  const status: GitTransportStatusSource = { value: 'connected' }
  const listeners = new Map<GitEventType, Set<(payload: unknown) => void>>()
  const responses = new Map<GitRequestType, PluginGitSdkResponse>()
  const sent: GitTransportRequestRecord[] = []
  async function request<TPayload = unknown>(
    type: GitRequestType,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<PluginGitSdkResponse<TPayload>> {
    sent.push({ type, payload, timeoutMs })
    return (responses.get(type) ?? {
      ok: true,
      payload: null,
      error: null,
    }) as PluginGitSdkResponse<TPayload>
  }

  function subscribe(type: GitEventType, callback: (payload: unknown) => void): () => void {
    let callbacks = listeners.get(type)
    if (!callbacks) {
      callbacks = new Set()
      listeners.set(type, callbacks)
    }
    callbacks.add(callback)
    return () => callbacks?.delete(callback)
  }

  function emit(type: GitEventType, payload: unknown): void {
    for (const callback of [...(listeners.get(type) ?? [])]) callback(payload)
  }

  function setResponse<TPayload>(
    type: GitRequestType,
    payload: TPayload,
    options: { ok?: boolean; error?: GitTransportError | null } = {},
  ): void {
    const ok = options.ok ?? true
    responses.set(type, {
      ok,
      payload: ok ? payload : null,
      error: options.error ?? null,
    })
  }

  const sdk = { status, request, subscribe } satisfies PluginGitSdk
  return {
    sdk,
    sent,
    emit,
    setResponse,
  }
}

function createContractHarness(): GitTransportContractHarness {
  const harness = createSdkHarness()
  return {
    transport: createPluginGitTransport(harness.sdk),
    sent: harness.sent,
    emit: harness.emit,
    setResponse: harness.setResponse,
  }
}

runGitTransportContract(createContractHarness)

describe('plugin Git SDK adapter', () => {
  it('exposes only the Git transport seam to the feature', () => {
    expectTypeOf<keyof PluginGitSdk>().toEqualTypeOf<'status' | 'request' | 'subscribe'>()
    expectTypeOf<PluginGitSdk>().toMatchTypeOf<{
      readonly status: GitTransportStatusSource
      request: PluginGitSdk['request']
      subscribe: PluginGitSdk['subscribe']
    }>()
    expectTypeOf<GitTransport>().toMatchTypeOf<ReturnType<typeof createPluginGitTransport>>()
  })

  it('isolates listener failures and records them without breaking later listeners', () => {
    const harness = createSdkHarness()
    const transport = createPluginGitTransport(harness.sdk)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failingListener = vi.fn(() => { throw new Error('listener failed') })
    const nextListener = vi.fn()

    transport.on('git.changed', failingListener)
    transport.on('git.changed', nextListener)
    harness.emit('git.changed', { workspace_path: '/workspace' })

    expect(failingListener).toHaveBeenCalledOnce()
    expect(nextListener).toHaveBeenCalledWith({ workspace_path: '/workspace' })
    expect(errorSpy).toHaveBeenCalledWith('[plugin-git] listener error', expect.any(Error))
    errorSpy.mockRestore()
  })

  it('keeps two independently authenticated SDK closures isolated', async () => {
    // Authentication and package identity live in the Host-created SDK closure;
    // the adapter intentionally accepts no identity metadata of its own.
    const first = createSdkHarness()
    const second = createSdkHarness()
    const firstTransport = createPluginGitTransport(first.sdk)
    const secondTransport = createPluginGitTransport(second.sdk)
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    const unsubscribeFirst = firstTransport.on('git.changed', firstListener)
    secondTransport.on('git.changed', secondListener)

    await firstTransport.send('git.status', { workspace_path: '/first' })
    await secondTransport.send('git.status', { workspace_path: '/second' })
    first.emit('git.changed', { workspace_path: '/first' })
    second.emit('git.changed', { workspace_path: '/second' })

    expect(first.sent).toHaveLength(1)
    expect(first.sent[0].payload).toEqual({ workspace_path: '/first' })
    expect(second.sent).toHaveLength(1)
    expect(second.sent[0].payload).toEqual({ workspace_path: '/second' })
    expect(firstListener).toHaveBeenCalledWith({ workspace_path: '/first' })
    expect(secondListener).toHaveBeenCalledWith({ workspace_path: '/second' })

    unsubscribeFirst()
    first.emit('git.changed', { workspace_path: '/first-again' })
    second.emit('git.changed', { workspace_path: '/second-again' })

    expect(firstListener).toHaveBeenCalledOnce()
    expect(secondListener).toHaveBeenCalledTimes(2)
    expect(secondListener).toHaveBeenLastCalledWith({ workspace_path: '/second-again' })
  })

  it('normalizes an SDK rejection into the shared error envelope', async () => {
    const harness = createSdkHarness()
    const sdk: PluginGitSdk = {
      ...harness.sdk,
      request: async () => { throw new Error('broker unavailable') },
    }
    await expect(createPluginGitTransport(sdk).send('git.status')).resolves.toEqual({
      ok: false,
      payload: null,
      error: { code: 'BACKEND_ERROR', message: 'broker unavailable' },
    })
  })
})
