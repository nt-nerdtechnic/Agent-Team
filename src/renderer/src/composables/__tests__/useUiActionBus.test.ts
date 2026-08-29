import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { useUiActionBus, handleUiInvokeRequest, type UiInvokeRequest } from '../useUiActionBus'
import { registerCommand } from '@navide/plugin-ui/shared'
import { _resetRegistry } from '@navide/plugin-ui/shared/testing'
import { recordDiagnostic, _resetDiagnostics } from '../../lib/uiDiagnostics'
import { createMockBackend, flush } from './mockBackend'

beforeEach(() => {
  _resetRegistry()
  _resetDiagnostics()
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

  // The backend sends `addressed` to one window alone: the one hosting the pane
  // that asked. That window must answer whatever workspace it currently has
  // open — a pane whose window had switched project could otherwise never drive
  // its own UI, and the mismatch looked exactly like a hung window.
  it('handles an addressed request regardless of workspace_path', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('noop', () => 'ok')
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-b', action: 'noop', addressed: true }))
    await flush()

    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toEqual({ request_id: 'req-1', ok: true, result: 'ok', error: null })
  })

  // A window can hold several workspaces with only one showing; ownership is
  // "does this window hold it", not "is it the one on screen".
  it('answers for a workspace it holds but is not currently showing', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('noop', () => 'ok')
    useUiActionBus({
      backend,
      currentWorkspace,
      buildSnapshot: () => ({}),
      ownsWorkspace: (p) => p === '/ws-a' || p === '/ws-held',
    })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-held', action: 'noop' }))
    await flush()

    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toEqual({ request_id: 'req-1', ok: true, result: 'ok', error: null })
  })

  it('stays silent for a workspace it does not hold', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('noop', () => 'ok')
    useUiActionBus({
      backend,
      currentWorkspace,
      buildSnapshot: () => ({}),
      ownsWorkspace: (p) => p === '/ws-a',
    })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-other', action: 'noop' }))
    await flush()

    expect(sent.find((s) => s.type === 'ui.invoke.result')).toBeUndefined()
  })

  // Reaching this window is not the same as being able to act on the project
  // the request names. ui.pane.create / ui.window.openGit / ui.preview.show all
  // read the window's OWN currentWorkspace, so answering one for a workspace
  // this window merely holds spawned the agent into (and persisted it under)
  // the project on screen instead — ok:true on the wrong project.
  it('refuses an addressed workspace-scoped action naming a project it is not showing', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    const ranAgainst: string[] = []
    registerCommand('ui.pane.create', () => {
      ranAgainst.push(currentWorkspace.value)
      return 'pane-1'
    })
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({
      workspace_path: '/ws-held',
      action: 'ui.pane.create',
      args: { agent: 'claude' },
      addressed: true,
    }))
    await flush()

    expect(ranAgainst).toEqual([])
    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toMatchObject({ request_id: 'req-1', ok: false })
    // The reply names both projects: the caller has to know which window to
    // switch, and a bare "refused" reads as a bug in the action.
    expect((reply?.payload as { error: string }).error).toContain('/ws-held')
    expect((reply?.payload as { error: string }).error).toContain('/ws-a')
  })

  it('runs a workspace-scoped action addressed to the project it IS showing', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    const ranAgainst: string[] = []
    registerCommand('ui.pane.create', () => {
      ranAgainst.push(currentWorkspace.value)
      return 'pane-1'
    })
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({
      workspace_path: '/ws-a',
      action: 'ui.pane.create',
      addressed: true,
    }))
    await flush()

    expect(ranAgainst).toEqual(['/ws-a'])
    expect(sent.find((s) => s.type === 'ui.invoke.result')?.payload).toMatchObject({ ok: true })
  })

  it('does not let a trailing slash make the shown project look like another one', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    const ran: string[] = []
    registerCommand('ui.preview.show', () => { ran.push('x') })
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({
      workspace_path: '/ws-a/',
      action: 'ui.preview.show',
      addressed: true,
    }))
    await flush()

    expect(ran).toEqual(['x'])
    expect(sent.find((s) => s.type === 'ui.invoke.result')?.payload).toMatchObject({ ok: true })
  })

  // The other half of the same rule: a request that does NOT act on the shown
  // project keeps the wider ownership test, which is the whole point of
  // addressing a pane's own window.
  it('still answers a pane-keyed action for a workspace it is not showing', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('ui.pane.getStatus', () => ({ status: 'idle' }))
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({
      workspace_path: '/ws-held',
      action: 'ui.pane.getStatus',
      args: { paneId: 'p1' },
      addressed: true,
    }))
    await flush()

    expect(sent.find((s) => s.type === 'ui.invoke.result')?.payload).toMatchObject({
      ok: true,
      result: { status: 'idle' },
    })
  })

  // Not addressed means some other window may have that project on screen, so
  // this one owes the same silence it owes any mismatch — an error reply here
  // would race the window that can actually do the work.
  it('stays silent on a broadcast workspace-scoped action for a held-but-not-shown project', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    const ran: string[] = []
    registerCommand('ui.window.openGit', () => { ran.push('x') })
    useUiActionBus({
      backend,
      currentWorkspace,
      buildSnapshot: () => ({}),
      ownsWorkspace: (p) => p === '/ws-a' || p === '/ws-held',
    })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-held', action: 'ui.window.openGit' }))
    await flush()

    expect(ran).toEqual([])
    expect(sent.find((s) => s.type === 'ui.invoke.result')).toBeUndefined()
  })

  it('still ignores a mismatched request that is not addressed to it', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('noop', () => 'ok')
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-b', action: 'noop', addressed: false }))
    await flush()

    expect(sent.find((s) => s.type === 'ui.invoke.result')).toBeUndefined()
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

describe('handleUiInvokeRequest — warnings from uiDiagnostics', () => {
  const currentWorkspace = ref('/ws')
  const deps = () => ({ currentWorkspace, buildSnapshot: vi.fn() })

  it('omits warnings entirely when the action recorded no diagnostics', async () => {
    const { backend, sent } = createMockBackend()
    registerCommand('noop', () => 'ok')
    await handleUiInvokeRequest(baseRequest({ action: 'noop', workspace_path: '/ws' }), { backend, ...deps() })

    expect(sent[0].payload).toEqual({ request_id: 'req-1', ok: true, result: 'ok', error: null })
    expect('warnings' in sent[0].payload).toBe(false)
  })

  it('includes warnings recorded by the command while it ran, formatted as "[code] message"', async () => {
    const { backend, sent } = createMockBackend()
    registerCommand('flaky', () => {
      recordDiagnostic({ level: 'warn', code: 'inject.resend', message: 'content not echoed — resending' })
      return 'ok'
    })
    await handleUiInvokeRequest(baseRequest({ action: 'flaky', workspace_path: '/ws' }), { backend, ...deps() })

    expect(sent[0].payload).toEqual({
      request_id: 'req-1',
      ok: true,
      result: 'ok',
      error: null,
      warnings: ['[inject.resend] content not echoed — resending']
    })
  })

  it('only reports diagnostics recorded during this action, not ones from before it started', async () => {
    const { backend, sent } = createMockBackend()
    recordDiagnostic({ level: 'error', code: 'inject.failed', message: 'stale — from an earlier action' })
    registerCommand('noop', () => 'ok')
    await handleUiInvokeRequest(baseRequest({ action: 'noop', workspace_path: '/ws' }), { backend, ...deps() })

    expect('warnings' in sent[0].payload).toBe(false)
  })
})
