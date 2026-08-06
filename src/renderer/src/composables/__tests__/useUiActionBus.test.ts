import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { useUiActionBus, handleUiInvokeRequest, type UiInvokeRequest } from '../useUiActionBus'
import { registerCommand, _resetRegistry } from '../../keybindings/commandRegistry'
import { createMockBackend, flush } from './mockBackend'

beforeEach(() => {
  _resetRegistry()
})

function baseRequest(overrides: Partial<UiInvokeRequest> = {}): UiInvokeRequest {
  return {
    request_id: 'req-1',
    workspace_path: '/ws',
    op: 'invoke',
    action: null,
    args: null,
    global: false,
    ...overrides,
  }
}

describe('useUiActionBus — ownership filtering', () => {
  it('ignores a non-global request whose workspace_path does not match this window', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-b' }))
    await flush()

    expect(sent.find((s) => s.type === 'ui.invoke.result')).toBeUndefined()
  })

  it('handles a non-global request whose workspace_path matches this window', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('noop', () => 'ok')
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-a', action: 'noop' }))
    await flush()

    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toEqual({ request_id: 'req-1', ok: true, result: 'ok', error: null })
  })

  it('handles a global request regardless of workspace_path', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('noop', () => 'ok')
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/somewhere-else', action: 'noop', global: true }))
    await flush()

    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toEqual({ request_id: 'req-1', ok: true, result: 'ok', error: null })
  })
})

describe('handleUiInvokeRequest — op dispatch', () => {
  const currentWorkspace = ref('/ws')
  const deps = () => ({ currentWorkspace, buildSnapshot: vi.fn() })

  it('op "invoke" runs the registered command with args and replies with its result', async () => {
    const { backend, sent } = createMockBackend()
    const handler = vi.fn((args) => ({ received: args }))
    registerCommand('do.thing', handler)

    await handleUiInvokeRequest(
      baseRequest({ action: 'do.thing', args: { n: 1 }, workspace_path: '/ws' }),
      { backend, ...deps() },
    )

    expect(handler).toHaveBeenCalledWith({ n: 1 })
    const reply = sent[0]
    expect(reply.type).toBe('ui.invoke.result')
    expect(reply.payload).toEqual({ request_id: 'req-1', ok: true, result: { received: { n: 1 } }, error: null })
  })

  it('op "invoke" with an unknown action replies ok:false with an error string', async () => {
    const { backend, sent } = createMockBackend()
    await handleUiInvokeRequest(
      baseRequest({ action: 'no.such.command', workspace_path: '/ws' }),
      { backend, ...deps() },
    )
    expect(sent[0].payload).toMatchObject({ request_id: 'req-1', ok: false })
    expect((sent[0].payload as { error: string }).error).toContain('no.such.command')
  })

  it('op "invoke" with a null action replies ok:false without touching the registry', async () => {
    const { backend, sent } = createMockBackend()
    await handleUiInvokeRequest(
      baseRequest({ op: 'invoke', action: null, workspace_path: '/ws' }),
      { backend, ...deps() },
    )
    expect(sent[0].payload).toMatchObject({ ok: false })
  })

  it('op "invoke" whose handler throws replies ok:false with the thrown message, never rejecting', async () => {
    const { backend, sent } = createMockBackend()
    registerCommand('boom', () => {
      throw new Error('handler exploded')
    })
    await expect(
      handleUiInvokeRequest(
        baseRequest({ action: 'boom', workspace_path: '/ws' }),
        { backend, ...deps() },
      ),
    ).resolves.toBeUndefined()
    expect(sent[0].payload).toEqual({ request_id: 'req-1', ok: false, result: undefined, error: 'handler exploded' })
  })

  it('op "snapshot" calls the injected buildSnapshot and replies with its result', async () => {
    const { backend, sent } = createMockBackend()
    const buildSnapshot = vi.fn(async () => ({ workspace: '/ws', panes: [] }))
    await handleUiInvokeRequest(
      baseRequest({ op: 'snapshot', workspace_path: '/ws' }),
      { backend, currentWorkspace, buildSnapshot },
    )
    expect(buildSnapshot).toHaveBeenCalledTimes(1)
    expect(sent[0].payload).toEqual({
      request_id: 'req-1',
      ok: true,
      result: { workspace: '/ws', panes: [] },
      error: null,
    })
  })

  it('op "snapshot" whose buildSnapshot throws replies ok:false', async () => {
    const { backend, sent } = createMockBackend()
    const buildSnapshot = vi.fn(() => {
      throw new Error('snapshot failed')
    })
    await handleUiInvokeRequest(
      baseRequest({ op: 'snapshot', workspace_path: '/ws' }),
      { backend, currentWorkspace, buildSnapshot },
    )
    expect(sent[0].payload).toEqual({ request_id: 'req-1', ok: false, result: undefined, error: 'snapshot failed' })
  })

  it('op "list_actions" replies with every registered command id', async () => {
    const { backend, sent } = createMockBackend()
    registerCommand('a.one', () => {})
    registerCommand('a.two', () => {})
    await handleUiInvokeRequest(
      baseRequest({ op: 'list_actions', workspace_path: '/ws' }),
      { backend, ...deps() },
    )
    expect(sent[0].payload.ok).toBe(true)
    expect((sent[0].payload.result as string[]).sort()).toEqual(['a.one', 'a.two'])
  })

  it('an unknown op replies ok:false with an error string', async () => {
    const { backend, sent } = createMockBackend()
    await handleUiInvokeRequest(
      baseRequest({ op: 'bogus' as unknown as UiInvokeRequest['op'], workspace_path: '/ws' }),
      { backend, ...deps() },
    )
    expect(sent[0].payload).toMatchObject({ ok: false })
  })

  it('ignores a payload missing request_id or op entirely (no reply sent)', async () => {
    const { backend, sent } = createMockBackend()
    await handleUiInvokeRequest({ workspace_path: '/ws' }, { backend, ...deps() })
    await handleUiInvokeRequest(null, { backend, ...deps() })
    expect(sent).toHaveLength(0)
  })
})
