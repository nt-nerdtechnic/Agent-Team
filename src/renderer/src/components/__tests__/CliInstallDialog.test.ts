// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CliInstallDialog from '../CliInstallDialog.vue'
import { i18n } from '@navide/ui-foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { OnboardDep, OnboardStatus } from '../../composables/useOnboarding'

const depBase = {
  binary_path: '', resolved_path: '', install_method: '', update_cmd: '',
  doctor_cmd: '', autoupdate_env: '', autoupdate_policy: '',
} as const

function dep(over: Partial<OnboardDep> & { id: string }): OnboardDep {
  return {
    ...depBase,
    label: over.id,
    description: '',
    group: 'agent_cli',
    status: 'missing',
    version: '',
    min_version: '',
    optional: true,
    needs_terminal: true,
    can_install: true,
    install_cmd: `install ${over.id}`,
    docs_url: 'https://example.invalid/docs',
    ...over,
  } as OnboardDep
}

function status(over: Partial<OnboardStatus> = {}): OnboardStatus {
  return {
    deps: [dep({ id: 'qwen' }), dep({ id: 'homebrew', group: 'foundation', optional: false })],
    models: [],
    model_catalog: [],
    cli_health: {
      entries: [], findings: [], fingerprint: '', dismissed: false, needs_attention: false,
    },
    gate: {
      foundation_ready: false, has_any_cli: false, analyzer_ready: false, ollama_ok: false,
      ollama_service_up: false, has_model: false, all_required_ready: false,
      suggested_model: '',
    },
    install_prompt_dismissed: [],
    complete: true,
    skip: false,
    ...over,
  }
}

function stubTerminal(result: { ok: boolean; error?: string } = { ok: true }): void {
  ;(globalThis as unknown as {
    window: { agentTeam: { openTerminal: (c: string) => Promise<{ ok: boolean; error?: string }> } }
  }).window.agentTeam = { openTerminal: () => Promise.resolve(result) } as never
}

describe('CliInstallDialog', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  async function open(
    mock: ReturnType<typeof createMockBackend>,
    props: Record<string, unknown> = {},
  ): Promise<VueWrapper> {
    const w = mount(CliInstallDialog, {
      props: { backend: mock.backend, depId: 'qwen', ...props },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return w
  }

  it('opens on the check step of a three-step wizard', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    wrapper = await open(mock)

    const steps = wrapper.findAll('.ci-steps li')
    expect(steps).toHaveLength(3)
    expect(steps[0].classes()).toContain('active')
    expect(wrapper.text()).toContain(i18n.global.t('cli-install.check-title', { label: 'qwen' }))
  })

  it('lists only prerequisites it cannot install for the user', async () => {
    // Anything installable is a numbered link in the chain instead, so the two
    // lists never state the same requirement twice. curl has no provider.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [
        dep({ id: 'qwen', requirements: [{ name: 'npm', ok: false }, { name: 'curl', ok: false }] }),
        dep({ id: 'node', group: 'foundation', label: 'Node.js' }),
      ],
    }))
    wrapper = await open(mock)

    const rows = wrapper.findAll('.ci-reqs li')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('curl')
    // npm comes from Node, which appears in the ordered chain.
    expect(wrapper.findAll('.ci-chain li').map((li) => li.find('.ci-chain-label').text()))
      .toEqual(['Node.js', 'qwen'])
    expect(mock.sent.filter((s) => s.type === 'onboarding.install')).toHaveLength(0)
  })

  it('moves to the verify step by itself once the CLI is detected', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [dep({ id: 'qwen', status: 'ok', version: '1.2.3' })],
    }))
    wrapper = await open(mock)

    const steps = wrapper.findAll('.ci-steps li')
    expect(steps[2].classes()).toContain('active')
    expect(steps[0].classes()).toContain('done')
  })

  it('shows the exact command before anything runs', async () => {
    // Consent needs the command visible up front, not only in the result.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    wrapper = await open(mock)
    expect(wrapper.text()).toContain('install qwen')
    expect(mock.sent.filter((s) => s.type === 'onboarding.install')).toHaveLength(0)
  })

  it('names a prerequisite the probe missed and stops there', async () => {
    // The probe said nothing was needed, but the install came back blocked.
    // The user must still be told which tool is missing.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install', {
      ok: false, error: 'brew is required', missing_requirements: ['brew'],
    })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    // The late discovery joins the chain rather than vanishing between lists.
    expect(wrapper.findAll('.ci-chain li').map((li) => li.find('.ci-chain-label').text()))
      .toEqual(['homebrew', 'qwen'])
    // Blocked belongs back at the check step — the environment is the problem.
    expect(wrapper.findAll('.ci-steps li')[0].classes()).toContain('active')
  })

  it('reports a terminal that never opened instead of claiming success', async () => {
    stubTerminal({ ok: false, error: 'automation not granted' })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install', {
      ok: true, needs_terminal: true, command: 'install qwen',
    })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain(i18n.global.t('cli-install.terminal-failed'))
  })

  it('surfaces the backend error text on a failed install', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install', { ok: false, error: 'npm ERR! 404 not found' })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(wrapper.find('.ci-error').text()).toContain('npm ERR! 404')
    // Retrying has to stay possible — the old confirm() offered one shot only.
    expect(wrapper.find('.ci-install').text()).toBe(i18n.global.t('cli-install.retry'))
  })

  it('reports an install that succeeded but stayed undetected', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install', { ok: true, output: 'done' })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain(i18n.global.t('cli-install.installed-not-detected', { label: 'qwen' }))
  })

  it('switches to the ready state once the CLI is detected', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [dep({ id: 'qwen', status: 'ok', version: '1.2.3' })],
    }))
    wrapper = await open(mock)

    expect(wrapper.text()).toContain(i18n.global.t('cli-install.done-title', { label: 'qwen' }))
    expect(wrapper.find('.ci-install').exists()).toBe(false)
  })

  it('offers to start the pane again only when the prompt came from one', async () => {
    const ready = status({ deps: [dep({ id: 'qwen', status: 'ok', version: '1.2.3' })] })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', ready)

    wrapper = await open(mock, { origin: 'settings' })
    expect(wrapper.find('.ci-relaunch').exists()).toBe(false)
    wrapper.unmount()

    wrapper = await open(mock, { origin: 'pane' })
    await wrapper.find('.ci-relaunch').trigger('click')
    expect(wrapper.emitted('relaunch')?.[0]).toEqual(['qwen'])
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('persists the per-CLI opt-out', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install_prompt', { ok: true })
    wrapper = await open(mock)

    await wrapper.find('.ci-dont-ask input').setValue(true)
    await flushPromises()

    const sent = mock.sent.find((s) => s.type === 'onboarding.install_prompt')
    expect(sent?.payload).toEqual({ dep_id: 'qwen', dismissed: true })
  })

  it('shows the stored opt-out as already ticked', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ install_prompt_dismissed: ['qwen'] }))
    wrapper = await open(mock)
    expect((wrapper.find('.ci-dont-ask input').element as HTMLInputElement).checked).toBe(true)
  })

  it('hides the opt-out for foundation deps', async () => {
    // "Stop asking about Homebrew" would silence a prerequisite, not a choice.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    wrapper = await open(mock, { depId: 'homebrew' })
    expect(wrapper.find('.ci-dont-ask').exists()).toBe(false)
  })

  it('does not claim "no install command" while status is still loading', async () => {
    const mock = createMockBackend('connected')
    // No status response yet: the dep is unknown, not known-uninstallable.
    const w = mount(CliInstallDialog, {
      props: { backend: mock.backend, depId: 'qwen' },
      global: { plugins: [i18n] },
    })
    wrapper = w
    expect(w.text()).not.toContain(i18n.global.t('cli-install.no-install-command', { label: 'qwen' }))
  })

  it('tells the opener about the opt-out instead of making it re-probe', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install_prompt', { ok: true })
    wrapper = await open(mock)

    await wrapper.find('.ci-dont-ask input').setValue(true)
    await flushPromises()

    expect(wrapper.emitted('dismiss-changed')?.[0]).toEqual([{ depId: 'qwen', dismissed: true }])
  })

  it('keeps the box unticked when the backend rejects the opt-out', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install_prompt', { ok: false, error: 'nope' })
    wrapper = await open(mock)

    await wrapper.find('.ci-dont-ask input').setValue(true)
    await flushPromises()

    expect((wrapper.find('.ci-dont-ask input').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.emitted('dismiss-changed')).toBeUndefined()
  })

  it('says so when a dep has no install command at all', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [dep({ id: 'qwen', can_install: false, install_cmd: '' })],
    }))
    wrapper = await open(mock)
    expect(wrapper.text()).toContain(i18n.global.t('cli-install.no-install-command', { label: 'qwen' }))
    expect(wrapper.find('.ci-install').exists()).toBe(false)
  })
})

/**
 * A machine that has never installed any CLI: picking one means Homebrew →
 * Node → that CLI. This is the case the dialog used to reveal one failure at a
 * time, so each step of the chain is pinned down here.
 */
describe('CliInstallDialog — dependency chain on a bare machine', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  /** homebrew (curl ok) → node (needs brew) → qwen (needs npm). */
  function bare(over: { installed?: string[] } = {}): OnboardStatus {
    const installed = new Set(over.installed ?? [])
    const mark = (id: string) => (installed.has(id) ? 'ok' : 'missing') as OnboardDep['status']
    return status({
      deps: [
        dep({
          id: 'qwen', label: 'Qwen Code', status: mark('qwen'),
          requirements: [{ name: 'npm', ok: installed.has('node') }],
        }),
        dep({
          id: 'node', label: 'Node.js', group: 'foundation', optional: false,
          needs_terminal: false, status: mark('node'),
          requirements: [{ name: 'brew', ok: installed.has('homebrew') }],
        }),
        dep({
          id: 'homebrew', label: 'Homebrew', group: 'foundation', optional: false,
          status: mark('homebrew'), requirements: [{ name: 'curl', ok: true }],
        }),
      ],
    })
  }

  async function open(
    mock: ReturnType<typeof createMockBackend>,
    props: Record<string, unknown> = {},
  ): Promise<VueWrapper> {
    const w = mount(CliInstallDialog, {
      props: { backend: mock.backend, depId: 'qwen', ...props },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return w
  }

  const installedIds = (mock: ReturnType<typeof createMockBackend>): string[] =>
    mock.sent.filter((s) => s.type === 'onboarding.install').map((s) => s.payload.dep_id as string)

  it('shows the whole chain in order before anything runs', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare())
    wrapper = await open(mock)

    const links = wrapper.findAll('.ci-chain li')
    expect(links.map((li) => li.find('.ci-chain-label').text())).toEqual(['Homebrew', 'Node.js', 'Qwen Code'])
    expect(links[0].classes()).toContain('next')
    expect(installedIds(mock)).toEqual([])
  })

  it('names the prerequisite on the button rather than the CLI that was asked for', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare())
    wrapper = await open(mock)
    expect(wrapper.find('.ci-install').text()).toBe(
      i18n.global.t('cli-install.install-step', { label: 'Homebrew', total: 3 })
    )
  })

  it('installs the first link, not the CLI', async () => {
    stubTerminal({ ok: true })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare())
    mock.setResponse('onboarding.install', { ok: true, needs_terminal: true, command: 'install brew' })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(installedIds(mock)).toEqual(['homebrew'])
  })

  /**
   * Make the machine actually change: every dep installed through the mock
   * becomes detectable on the next status probe. Without this the fixture would
   * describe a machine where installs never take effect, which is a different
   * case (covered separately below).
   */
  function withInstallsTakingEffect(
    mock: ReturnType<typeof createMockBackend>,
    initial: string[],
  ): void {
    const installed = new Set(initial)
    const send = mock.backend.send.bind(mock.backend)
    mock.backend.send = ((type: string, payload: Record<string, unknown>, timeoutMs?: number) => {
      if (type === 'onboarding.status') {
        return Promise.resolve({ ok: true, payload: bare({ installed: [...installed] }) })
      }
      if (type === 'onboarding.install') installed.add(String(payload.dep_id))
      return send(type, payload, timeoutMs)
    }) as typeof mock.backend.send
  }

  it('continues into the next link once an inline step lands', async () => {
    // Node installs inline; with Homebrew already present the chain should run
    // straight through to the CLI without a second press.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare({ installed: ['homebrew'] }))
    mock.setResponse('onboarding.install', { ok: true, output: 'done' })
    withInstallsTakingEffect(mock, ['homebrew'])
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(installedIds(mock)).toEqual(['node', 'qwen'])
  })

  it('walks the full chain from nothing installed', async () => {
    // The headline case: one press on a bare machine reaches the CLI.
    stubTerminal({ ok: true })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare())
    mock.setResponse('onboarding.install', { ok: true, output: 'done' })
    withInstallsTakingEffect(mock, [])
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(installedIds(mock)).toEqual(['homebrew', 'node', 'qwen'])
  })

  it('stops the chain where a step fails', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare({ installed: ['homebrew'] }))
    mock.setResponse('onboarding.install', { ok: false, error: 'brew: no bottle' })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(installedIds(mock)).toEqual(['node'])
    expect(wrapper.find('.ci-error').text()).toContain('no bottle')
  })

  it('stops when a step reports success but stays undetected', async () => {
    // "Installed" and "detectable" differ. Running the next command against a
    // machine that still cannot see this one is the exit-127 failure the chain
    // exists to prevent — and repeating the same link would recurse forever.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare({ installed: ['homebrew'] }))
    mock.setResponse('onboarding.install', { ok: true, output: 'installed' })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(installedIds(mock)).toEqual(['node'])
    expect(wrapper.text()).toContain(
      i18n.global.t('cli-install.installed-not-detected', { label: 'Node.js' })
    )
  })

  it('hides the chain when the CLI has no unmet prerequisites', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare({ installed: ['homebrew', 'node'] }))
    wrapper = await open(mock)

    expect(wrapper.find('.ci-chain').exists()).toBe(false)
    expect(wrapper.find('.ci-install').text()).toBe(i18n.global.t('cli-install.install'))
  })
})
