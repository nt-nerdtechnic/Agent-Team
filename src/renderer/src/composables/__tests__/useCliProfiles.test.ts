// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import {
  createCliAccountSwitchHandler,
  forcedRestartAgentKey,
  paneNeedsAccountRestart,
  runAccountRestartBatch,
  useCliProfiles,
  type CliProfile,
  type SetDefaultResult,
} from '../useCliProfiles'
import { createMockBackend, withScope, flush } from './mockBackend'

function profile(id: string, agentKey: string, name: string): CliProfile {
  return { id, agentKey, name, createdAt: '2026-07-01T00:00:00Z' }
}

const SUPPORTED = ['claude', 'codex', 'kimi', 'grok']

describe('useCliProfiles', () => {
  it('loads profiles/defaults/supported agents on connect', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [profile('p1', 'claude', 'Work')],
      defaults: { claude: 'p1' },
      supported_agents: SUPPORTED,
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(result.profiles.value.map((p) => p.id)).toEqual(['p1'])
    expect(result.defaults.value.claude).toBe('p1')
    expect(result.supportedAgents.value).toEqual(SUPPORTED)
    expect(result.loaded.value).toBe(true)
    scope.stop()
  })

  it('create sends snake_case payload and adopts the returned lists', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    const created = profile('p2', 'codex', 'Personal')
    mock.setResponse('cli_profiles.create', {
      profile: created,
      profiles: [created],
      defaults: {},
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const out = await result.create('codex', 'Personal')
    expect(out?.id).toBe('p2')
    const call = mock.sent.find((s) => s.type === 'cli_profiles.create')
    expect(call?.payload).toEqual({ agent_key: 'codex', name: 'Personal' })
    expect(result.profiles.value.map((p) => p.id)).toEqual(['p2'])
    scope.stop()
  })

  it('set_default sends profile_id (null for built-in Default) and updates defaults', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [profile('p1', 'claude', 'Work')],
      defaults: { claude: 'p1' },
      supported_agents: SUPPORTED,
    })
    mock.setResponse('cli_profiles.set_default', { defaults: { claude: null } })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', null)
    expect(res).toEqual({ ok: true })
    const call = mock.sent.find((s) => s.type === 'cli_profiles.set_default')
    expect(call?.payload).toEqual({ agent_key: 'claude', profile_id: null })
    expect(result.defaultProfileId('claude')).toBe(null)
    scope.stop()
  })

  it('set_default forwards force: true in the payload', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_default', { defaults: { claude: 'p1' } })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', 'p1', { force: true })
    expect(res).toEqual({ ok: true })
    const call = mock.sent.find((s) => s.type === 'cli_profiles.set_default')
    expect(call?.payload).toEqual({ agent_key: 'claude', profile_id: 'p1', force: true })
    scope.stop()
  })

  it('set_default maps PANES_RUNNING to code + count without setting the banner error', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false,
      error: { code: 'PANES_RUNNING', message: 'panes running', details: { count: 2 } },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', 'p1')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('PANES_RUNNING')
      expect(res.count).toBe(2)
      expect(res.message).toBeTruthy()
    }
    // The confirm flow (or an alert) handles it — never the pane banner.
    expect(result.error.value).toBe('')
    scope.stop()
  })

  it('set_default maps PROFILE_SWAP_FAILED to a localized error', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false,
      error: { code: 'PROFILE_SWAP_FAILED', message: 'swap failed, rolled back' },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', 'p1')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('PROFILE_SWAP_FAILED')
      expect(res.message).toBeTruthy()
      expect(result.error.value).toBe(res.message)
    }
    scope.stop()
  })

  it('syncs cache from a cli_profiles.changed broadcast', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    mock.emit('cli_profiles.changed', {
      profiles: [profile('p9', 'kimi', 'Alt')],
      defaults: { kimi: 'p9' },
      reason: 'create',
    })
    expect(result.profilesForAgent('kimi').map((p) => p.id)).toEqual(['p9'])
    expect(result.defaultProfileId('kimi')).toBe('p9')
    scope.stop()
  })

  it('surfaces the error message when a mutation fails', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.create', null as unknown as object, {
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'name taken' },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const out = await result.create('claude', 'dup')
    expect(out).toBe(null)
    expect(result.error.value).toBe('name taken')
    scope.stop()
  })

  it('hasProfiles / profilesForAgent partition by agent', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [profile('a', 'claude', 'One'), profile('b', 'codex', 'Two')],
      defaults: {},
      supported_agents: SUPPORTED,
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(result.hasProfiles('claude')).toBe(true)
    expect(result.hasProfiles('grok')).toBe(false)
    expect(result.profilesForAgent('codex').map((p) => p.id)).toEqual(['b'])
    scope.stop()
  })
})

describe('createCliAccountSwitchHandler', () => {
  type SetDefaultFn = (
    agentKey: string,
    profileId: string | null,
    opts?: { force?: boolean },
  ) => Promise<SetDefaultResult>

  function makeCaps(confirmResult = true) {
    return {
      confirm: vi.fn(async () => confirmResult),
      agentLabel: (agentKey: string) => agentKey,
    }
  }

  it('passes a clean switch straight through (no confirm)', async () => {
    const setDefault = vi.fn<SetDefaultFn>().mockResolvedValue({ ok: true })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    const res = await handler('claude', 'p1')
    expect(res).toEqual({ ok: true })
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenCalledWith('claude', 'p1')
    expect(caps.confirm).not.toHaveBeenCalled()
  })

  it('PANES_RUNNING: confirm, then force the switch — no direct restart (broadcast-driven)', async () => {
    const setDefault = vi
      .fn<SetDefaultFn>()
      .mockResolvedValueOnce({ ok: false, code: 'PANES_RUNNING', count: 2, message: 'in use' })
      .mockResolvedValueOnce({ ok: true })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    const res = await handler('claude', 'p1')
    expect(res).toEqual({ ok: true })
    expect(setDefault).toHaveBeenCalledTimes(2)
    expect(setDefault).toHaveBeenNthCalledWith(1, 'claude', 'p1')
    expect(setDefault).toHaveBeenNthCalledWith(2, 'claude', 'p1', { force: true })
    expect(caps.confirm).toHaveBeenCalledTimes(1)
  })

  it('a declined confirm cancels the switch with a message-less failure', async () => {
    const setDefault = vi
      .fn<SetDefaultFn>()
      .mockResolvedValue({ ok: false, code: 'PANES_RUNNING', count: 1, message: 'in use' })
    const caps = makeCaps(false)
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    const res = await handler('claude', 'p1')
    expect(res).toEqual({ ok: false, code: 'PANES_RUNNING' })
    expect(setDefault).toHaveBeenCalledTimes(1)
  })

  it('a failing forced switch surfaces the forced failure', async () => {
    const setDefault = vi
      .fn<SetDefaultFn>()
      .mockResolvedValueOnce({ ok: false, code: 'PANES_RUNNING', count: 1, message: 'in use' })
      .mockResolvedValueOnce({ ok: false, code: 'PROFILE_SWAP_FAILED', message: 'swap failed' })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    const res = await handler('claude', 'p1')
    expect(res).toEqual({ ok: false, code: 'PROFILE_SWAP_FAILED', message: 'swap failed' })
  })

  it('non-PANES_RUNNING failures pass through without a confirm', async () => {
    const setDefault = vi
      .fn<SetDefaultFn>()
      .mockResolvedValue({ ok: false, code: 'PROFILE_SWAP_FAILED', message: 'swap failed' })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    const res = await handler('claude', 'p1')
    expect(res).toEqual({ ok: false, code: 'PROFILE_SWAP_FAILED', message: 'swap failed' })
    expect(caps.confirm).not.toHaveBeenCalled()
  })
})

describe('forcedRestartAgentKey', () => {
  it('returns the agent key for a forced set_default broadcast', () => {
    expect(
      forcedRestartAgentKey({ reason: 'set_default', forced: true, agent_key: 'claude' }),
    ).toBe('claude')
  })

  it('returns null for a quiet (non-forced) set_default', () => {
    expect(
      forcedRestartAgentKey({ reason: 'set_default', forced: false, agent_key: 'claude' }),
    ).toBeNull()
  })

  it('returns null for other reasons and malformed payloads', () => {
    expect(
      forcedRestartAgentKey({ reason: 'login-harvest', forced: true, agent_key: 'claude' }),
    ).toBeNull()
    expect(forcedRestartAgentKey({ reason: 'set_default', forced: true })).toBeNull()
    expect(forcedRestartAgentKey(undefined)).toBeNull()
    expect(forcedRestartAgentKey(null)).toBeNull()
  })
})

describe('paneNeedsAccountRestart', () => {
  const pane = { realized: true, agentKey: 'claude', isLogin: false }

  it('includes a realized, live pane of the switched agent', () => {
    expect(paneNeedsAccountRestart(pane, 'claude', 'running')).toBe(true)
  })

  it('includes a pane whose terminal ref has not mounted yet (undefined status)', () => {
    expect(paneNeedsAccountRestart(pane, 'claude', undefined)).toBe(true)
  })

  it('excludes login panes, other agents, and unrealized panes', () => {
    expect(paneNeedsAccountRestart({ ...pane, isLogin: true }, 'claude', 'running')).toBe(false)
    expect(paneNeedsAccountRestart(pane, 'codex', 'running')).toBe(false)
    expect(paneNeedsAccountRestart({ ...pane, realized: false }, 'claude', 'running')).toBe(false)
  })

  it('excludes exited and errored panes', () => {
    expect(paneNeedsAccountRestart(pane, 'claude', 'exited')).toBe(false)
    expect(paneNeedsAccountRestart(pane, 'claude', 'error')).toBe(false)
  })
})

describe('runAccountRestartBatch', () => {
  it('all panes restart cleanly: no toast, no log', async () => {
    const log = vi.fn()
    const toastPartial = vi.fn()
    await runAccountRestartBatch(
      ['pane-1', 'pane-2'],
      vi.fn(async () => undefined),
      log,
      toastPartial,
    )
    expect(toastPartial).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('aggregates returned failure tokens and thrown errors into one toast', async () => {
    const log = vi.fn()
    const toastPartial = vi.fn()
    const rebuild = vi
      .fn<(id: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('no-session')
      .mockRejectedValueOnce(new Error('boom'))
    await runAccountRestartBatch(['pane-1', 'pane-2', 'pane-3'], rebuild, log, toastPartial)
    expect(toastPartial).toHaveBeenCalledTimes(1)
    expect(toastPartial).toHaveBeenCalledWith(2, 3)
    expect(log).toHaveBeenCalledTimes(2)
    expect(log.mock.calls[0][0]).toContain('no-session')
    expect(log.mock.calls[1][0]).toContain('boom')
  })
})
