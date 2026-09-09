import { describe, it, expect, vi } from 'vitest'
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
      ollama_service_up: ollama,
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

  it('install sends a request timeout that outlives inline brew installs', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    mock.setResponse('onboarding.install', { ok: true, output: 'installed' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.cliDeps.value[0])
    const sent = mock.sent.find((s) => s.type === 'onboarding.install')
    // Backend caps inline installs at 900s; the default 10s WS timeout would
    // abort every real install mid-download.
    expect(sent?.timeoutMs).toBeGreaterThan(900_000)
    scope.stop()
  })

  // ── install failure reporting ───────────────────────────────────────────────
  function stubTerminal(result: { ok: boolean; error?: string }): string[] {
    const calls: string[] = []
    ;(globalThis as unknown as {
      window: { agentTeam: { openTerminal: (c: string) => Promise<{ ok: boolean; error?: string }> } }
    }).window = {
      agentTeam: { openTerminal: (c: string) => { calls.push(c); return Promise.resolve(result) } },
    }
    return calls
  }

  it('surfaces the backend failure text instead of "unknown"', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false }))
    mock.setResponse('onboarding.install', { ok: false, error: 'Error: no bottle available' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.foundationDeps.value[0])
    await flush()
    const log = result.logLines.value.join('\n')
    expect(log).toContain('no bottle available')
    expect(log).not.toContain('unknown')
    result.dispose()
    scope.stop()
  })

  it('falls back to the captured output when the failure carries no error field', async () => {
    // Guards the frontend half of the contract: the backend used to report a
    // non-zero install through `output` alone, which rendered as "unknown".
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false }))
    mock.setResponse('onboarding.install', { ok: false, output: 'sh: brew: command not found' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.foundationDeps.value[0])
    await flush()
    expect(result.logLines.value.join('\n')).toContain('brew: command not found')
    result.dispose()
    scope.stop()
  })

  it('reports a failed terminal handoff instead of claiming one opened', async () => {
    // TCC automation is granted in a LATER wizard step, so this is the common
    // first-run path — it used to log success while nothing happened.
    stubTerminal({ ok: false, error: 'not authorised' })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    mock.setResponse('onboarding.install', { ok: true, needs_terminal: true, command: 'npm i -g x' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.cliDeps.value[0])
    await flush()
    const log = result.logLines.value.join('\n')
    expect(log).not.toContain('Opened in external terminal')
    expect(log).toContain('not authorised')
    expect(log).toContain('npm i -g x') // the command to run by hand
    result.dispose()
    scope.stop()
  })

  it('warns when an install reports success but detection still fails', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false }))
    mock.setResponse('onboarding.install', { ok: true, output: 'installed' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.foundationDeps.value[0])
    await flush()
    expect(result.logLines.value.join('\n')).toContain('still not detected')
    result.dispose()
    scope.stop()
  })

  // ── install failures the card has to show ───────────────────────────────────
  // The log pane sits below the fold and dies with the modal, so a failure that
  // only reached it left the button looking like it had done nothing at all.

  it('records a blocked install against the dep so its card can show it', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false }))
    mock.setResponse('onboarding.install', {
      ok: false,
      error: 'brew is required to install Python. Install brew first, then retry.',
      missing_requirements: ['brew'],
      command: 'brew install python3',
    })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.foundationDeps.value[0])
    await flush()
    const failure = result.installErrors.value.node
    expect(failure).toBeDefined()
    expect(failure.message).toContain('brew is required')
    expect(failure.command).toBe('brew install python3')
    expect(failure.ranButUndetected).toBe(false)
    result.dispose()
    scope.stop()
  })

  it('records exit-0-but-undetected as its own kind of failure', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false }))
    mock.setResponse('onboarding.install', { ok: true, output: 'installed' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.foundationDeps.value[0])
    await flush()
    expect(result.installErrors.value.node.ranButUndetected).toBe(true)
    result.dispose()
    scope.stop()
  })

  it('drops a reported failure when re-detection finds the dep anyway', async () => {
    // Homebrew exits non-zero on "already installed" often enough that the
    // command can fail while the tool is in fact present. Leaving the card red
    // in that state is its own kind of lie.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false }))
    mock.setResponse('onboarding.install', { ok: false, error: 'no bottle available' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.foundationDeps.value[0])
    await flush()
    expect(result.installErrors.value.node).toBeDefined()

    // Same failing install, but this time the post-install re-detect finds it.
    mock.setResponse('onboarding.status', status({ found: true }))
    await result.install(result.foundationDeps.value[0])
    await flush()
    expect(result.installErrors.value.node).toBeUndefined()
    result.dispose()
    scope.stop()
  })

  it('records a transport error against the dep too', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false }))
    mock.setRejection('onboarding.install', 'ws not open')
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.foundationDeps.value[0])
    await flush()
    expect(result.installErrors.value.node.message).toContain('ws not open')
    result.dispose()
    scope.stop()
  })

  it('says why a second install did not start instead of returning silently', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false, cli: false }))
    mock.setResponse('onboarding.install', { ok: true, output: 'installed' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()

    // Do not await the first: it holds `installing` while the second arrives.
    const first = result.install(result.foundationDeps.value[0])
    const second = await result.install(result.cliDeps.value[0])
    await first
    await flush()

    expect(second).toBeNull()
    // One install request, and a line saying why the other did not happen.
    expect(mock.sent.filter((s) => s.type === 'onboarding.install')).toHaveLength(1)
    expect(result.logLines.value.join('\n')).toContain('has to wait for')
    result.dispose()
    scope.stop()
  })

  it('skips the immediate re-detect when the install moved to a terminal', async () => {
    // That detection cannot possibly pass yet; the watcher polls for it instead.
    stubTerminal({ ok: true })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    mock.setResponse('onboarding.install', { ok: true, needs_terminal: true, command: 'npm i -g x' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.cliDeps.value[0])
    await flush()
    expect(mock.sent.filter((s) => s.type === 'onboarding.status')).toHaveLength(1)
    expect(result.watching.value).toBe('claude')
    result.dispose()
    expect(result.watching.value).toBe('')
    scope.stop()
  })

  it('marks a terminal handoff that failed to open', async () => {
    // `ok: true` alone described BOTH "terminal opened" and "nothing happened";
    // the dialog needs them apart to know whether to show an error.
    stubTerminal({ ok: false, error: 'not authorised' })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    mock.setResponse('onboarding.install', { ok: true, needs_terminal: true, command: 'npm i -g x' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const r = await result.install(result.cliDeps.value[0])
    await flush()
    expect(r?.terminal_opened).toBe(false)
    result.dispose()
    scope.stop()
  })

  it('reports when the terminal watcher gives up instead of stopping silently', async () => {
    // Polling used to end after ~5 minutes with no message at all, leaving the
    // user staring at a card that would never change.
    stubTerminal({ ok: true })
    vi.useFakeTimers()
    try {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', status({ cli: false }))
      mock.setResponse('onboarding.install', { ok: true, needs_terminal: true, command: 'npm i -g x' })
      const { result, scope } = withScope(() => useOnboarding(mock.backend))
      await result.refresh()
      await result.install(result.cliDeps.value[0])
      expect(result.watching.value).toBe('claude')
      // 60 polls at 5s each is the ceiling; one extra tick trips the give-up.
      await vi.advanceTimersByTimeAsync(5_000 * 61)
      expect(result.watching.value).toBe('')
      expect(result.watchOutcome.value).toBe('timeout')
      expect(result.logLines.value.join('\n')).toContain('Stopped watching')
      result.dispose()
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('records the opt-out for one CLI without touching the others', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    mock.setResponse('onboarding.install_prompt', { ok: true })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    expect(await result.dismissInstallPrompt('claude')).toBe(true)
    expect(result.installPromptDismissed.value.has('claude')).toBe(true)
    expect(result.installPromptDismissed.value.has('node')).toBe(false)
    await result.dismissInstallPrompt('claude', false)
    expect(result.installPromptDismissed.value.has('claude')).toBe(false)
    scope.stop()
  })

  it('keeps the opt-out unset when the backend rejects it', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    mock.setResponse('onboarding.install_prompt', { ok: false, error: 'unknown dependency' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    expect(await result.dismissInstallPrompt('nope')).toBe(false)
    expect(result.installPromptDismissed.value.size).toBe(0)
    expect(result.logLines.value.join('\n')).toContain('unknown dependency')
    scope.stop()
  })

  it('reads the stored opt-out list from status', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', { ...status({}), install_prompt_dismissed: ['claude'] })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    expect(result.installPromptDismissed.value.has('claude')).toBe(true)
    scope.stop()
  })

  it('ignores a second model pull while one is in flight', async () => {
    stubTerminal({ ok: true })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    mock.setResponse('onboarding.pull_model', { ok: true, needs_terminal: true, command: 'ollama pull a' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const first = result.pullModel('a')
    const second = await result.pullModel('b')
    await first
    await flush()
    expect(second).toBeNull()
    result.dispose()
    scope.stop()
  })

  it('startOllamaService opens the official service command', async () => {
    const calls = stubTerminal({ ok: true })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    mock.setResponse('onboarding.start_ollama', {
      ok: true, needs_terminal: true, command: 'brew services start ollama',
    })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.startOllamaService()
    await flush()
    expect(calls).toContain('brew services start ollama')
    result.dispose()
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
