import { describe, it, expect } from 'vitest'
import { cliHealthGuideForLaunch, useOnboarding, type OnboardStatus } from '../useOnboarding'
import { createMockBackend, withScope, flush } from './mockBackend'

// Fields every backend-sent dep carries; irrelevant to the gate assertions here.
const depBase = {
  binary_path: '', resolved_path: '', install_method: '', update_cmd: '',
  doctor_cmd: '', autoupdate_env: '', autoupdate_policy: '',
} as const

function status(opts: { found?: boolean; cli?: boolean; ollama?: boolean; models?: string[] }): OnboardStatus {
  const found = opts.found ?? true
  const cli = opts.cli ?? true
  const ollama = opts.ollama ?? true
  const models = opts.models ?? ['qwen2.5-coder']
  const analyzer = ollama && models.length > 0
  const all = found && cli && analyzer
  return {
    deps: [
      { ...depBase, id: 'node', label: 'Node', description: '', group: 'foundation', status: found ? 'ok' : 'missing', version: '22.0.0', min_version: '22.0.0', optional: false, needs_terminal: false, can_install: true, docs_url: '' },
      { ...depBase, id: 'claude', label: 'Claude', description: '', group: 'agent_cli', status: cli ? 'ok' : 'missing', version: '', min_version: '', optional: true, needs_terminal: true, can_install: true, docs_url: '' },
      { ...depBase, id: 'ollama', label: 'Ollama', description: '', group: 'analyzer', status: ollama ? 'ok' : 'missing', version: '', min_version: '', optional: false, needs_terminal: false, can_install: true, docs_url: '' },
    ],
    models,
    model_catalog: [
      { name: 'qwen2.5-coder:7b', size: '~4.7 GB', desc: '', recommended: true },
    ],
    cli_health: {
      entries: [],
      findings: [],
      fingerprint: '',
      dismissed: false,
      needs_attention: false,
    },
    gate: {
      foundation_ready: found,
      has_any_cli: cli,
      analyzer_ready: analyzer,
      ollama_ok: ollama,
      has_model: models.length > 0,
      all_required_ready: all,
      suggested_model: 'qwen2.5-coder',
    },
    complete: false,
    skip: false,
  }
}

describe('useOnboarding', () => {
  it('refresh populates status and derived gate flags', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await flush()
    expect(result.allRequiredReady.value).toBe(true)
    expect(result.foundationReady.value).toBe(true)
    expect(result.hasAnyCli.value).toBe(true)
    expect(result.analyzerReady.value).toBe(true)
    expect(result.foundationDeps.value).toHaveLength(1)
    expect(result.cliDeps.value).toHaveLength(1)
    scope.stop()
  })

  it('gate blocks when no CLI is present', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    expect(result.hasAnyCli.value).toBe(false)
    expect(result.allRequiredReady.value).toBe(false)
    scope.stop()
  })

  it('gate blocks when ollama present but no model', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ models: [] }))
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    expect(result.analyzerReady.value).toBe(false)
    expect(result.allRequiredReady.value).toBe(false)
    scope.stop()
  })

  it('install of a needs_terminal dep opens an external terminal', async () => {
    const calls: string[] = []
    ;(globalThis as unknown as { window: { agentTeam: { openTerminal: (c: string) => Promise<{ ok: boolean }> } } }).window = {
      agentTeam: { openTerminal: (c: string) => { calls.push(c); return Promise.resolve({ ok: true }) } },
    }
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    mock.setResponse('onboarding.install', { ok: true, needs_terminal: true, command: 'npm i -g x' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.cliDeps.value[0])
    await flush()
    expect(calls).toContain('npm i -g x')
    scope.stop()
  })

  it('markComplete sends onboarding.complete', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.markComplete()
    expect(mock.sent.some((s) => s.type === 'onboarding.complete')).toBe(true)
    scope.stop()
  })

  it('shows CLI health guide only for completed onboarding with an undismissed finding', () => {
    const ready = status({})
    ready.complete = true
    ready.cli_health = {
      entries: [],
      findings: [{ type: 'duplicate_install', agent_key: 'claude', label: 'Claude' }],
      fingerprint: '0123456789abcdef',
      dismissed: false,
      needs_attention: true,
    }
    expect(cliHealthGuideForLaunch(ready)?.fingerprint).toBe('0123456789abcdef')

    ready.complete = false
    expect(cliHealthGuideForLaunch(ready)).toBeNull()
    ready.complete = true
    ready.cli_health.needs_attention = false
    expect(cliHealthGuideForLaunch(ready)).toBeNull()
  })

  it('does not open the repair guide for a failed vendor update alone', () => {
    const ready = status({})
    ready.complete = true
    ready.cli_health = {
      entries: [],
      findings: [{
        type: 'update_failed',
        agent_key: 'claude',
        label: 'Claude',
        records: [{
          scope: 'profile:4ad13e88', home: '/tmp/p', timestamp: '2026-07-25T00:07:12.372Z',
          outcome: 'failed', status: 'install_failed', version_from: '2.1.219', version_to: '',
        }],
      }],
      fingerprint: '0123456789abcdef',
      dismissed: false,
      needs_attention: true,
    }
    expect(cliHealthGuideForLaunch(ready)).toBeNull()

    ready.cli_health.findings.push({ type: 'probe_failed', agent_key: 'codex', label: 'Codex' })
    expect(cliHealthGuideForLaunch(ready)?.fingerprint).toBe('0123456789abcdef')
  })

  it('maintenance runs the vendor command in a terminal and never composes one', async () => {
    const calls: string[] = []
    ;(globalThis as unknown as { window: { agentTeam: { openTerminal: (c: string) => Promise<{ ok: boolean }> } } }).window = {
      agentTeam: { openTerminal: (c: string) => { calls.push(c); return Promise.resolve({ ok: true }) } },
    }
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    mock.setResponse('onboarding.cli_maintenance', { ok: true, needs_terminal: true, command: 'claude update' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()

    await result.runMaintenance('claude', 'update')
    await flush()

    expect(calls).toEqual(['claude update'])
    const sent = mock.sent.find((s) => s.type === 'onboarding.cli_maintenance')
    expect(sent?.payload).toEqual({ agent_key: 'claude', action: 'update' })
    scope.stop()
  })

  it('maintenance opens no terminal when the vendor ships no such command', async () => {
    const calls: string[] = []
    ;(globalThis as unknown as { window: { agentTeam: { openTerminal: (c: string) => Promise<{ ok: boolean }> } } }).window = {
      agentTeam: { openTerminal: (c: string) => { calls.push(c); return Promise.resolve({ ok: true }) } },
    }
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    mock.setResponse('onboarding.cli_maintenance', { ok: false, error: 'no official update command', docs_url: 'https://docs' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()

    const outcome = await result.runMaintenance('kimi', 'update')
    await flush()

    expect(calls).toEqual([])
    expect(outcome?.ok).toBe(false)
    scope.stop()
  })
})
