// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { useCliProfiles, type CliProfile } from '../useCliProfiles'
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

  it('set_default passes force: true through to the backend payload', async () => {
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

  it('set_default surfaces PROFILE_IN_USE with running_count and leaves error empty', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false,
      error: {
        code: 'PROFILE_IN_USE',
        message: 'profile in use',
        details: { running_count: 3 },
      },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', 'p1')
    expect(res).toEqual({ ok: false, code: 'PROFILE_IN_USE', runningCount: 3 })
    // Callers show a confirm UI for this code — no error banner.
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
