// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import OnboardingWizard from '../OnboardingWizard.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { OnboardDep, OnboardStatus } from '../../composables/useOnboarding'

const depBase = {
  binary_path: '', resolved_path: '', install_method: '', update_cmd: '',
  doctor_cmd: '', autoupdate_env: '', autoupdate_policy: '',
} as const

function dep(over: Partial<OnboardDep> & { id: string; group: OnboardDep['group'] }): OnboardDep {
  return {
    ...depBase,
    label: over.id,
    description: '',
    status: 'missing',
    version: '',
    min_version: '',
    optional: false,
    needs_terminal: false,
    can_install: true,
    docs_url: '',
    ...over,
  } as OnboardDep
}

/** Two missing foundation deps — enough to see whether the loop stops. */
function status(over: Partial<OnboardStatus> = {}): OnboardStatus {
  return {
    deps: [
      dep({ id: 'homebrew', group: 'foundation', needs_terminal: true }),
      dep({ id: 'node', group: 'foundation' }),
      dep({ id: 'claude', group: 'agent_cli', optional: true, needs_terminal: true }),
      dep({ id: 'ollama', group: 'analyzer' }),
    ],
    models: [],
    model_catalog: [],
    cli_health: {
      entries: [], findings: [], fingerprint: '', dismissed: false, needs_attention: false,
    },
    gate: {
      foundation_ready: false,
      has_any_cli: false,
      analyzer_ready: false,
      ollama_ok: false,
      ollama_service_up: false,
      has_model: false,
      all_required_ready: false,
      suggested_model: 'qwen2.5-coder:7b',
    },
    complete: false,
    skip: false,
    ...over,
  }
}

function stubTerminal(result: { ok: boolean; error?: string } = { ok: true }): void {
  ;(globalThis as unknown as {
    window: { agentTeam: { openTerminal: (c: string) => Promise<{ ok: boolean; error?: string }> } }
  }).window.agentTeam = {
    openTerminal: () => Promise.resolve(result),
  } as never
}

function installCount(mock: ReturnType<typeof createMockBackend>): number {
  return mock.sent.filter((s) => s.type === 'onboarding.install').length
}

describe('OnboardingWizard', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  async function open(mock: ReturnType<typeof createMockBackend>): Promise<VueWrapper> {
    const w = mount(OnboardingWizard, {
      props: { backend: mock.backend },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return w
  }

  it('stops installing the rest once one install moves to a terminal', async () => {
    // Homebrew is interactive: it has only been *handed off*, so `brew install
    // node` right after it would fail with exit 127 on a fresh Mac.
    stubTerminal({ ok: true })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install', {
      ok: true, needs_terminal: true, command: 'install-brew.sh',
    })
    wrapper = await open(mock)

    await wrapper.find('.ob-linkbtn').trigger('click')
    await flushPromises()

    expect(installCount(mock)).toBe(1)
  })

  it('stops when an install is blocked by a missing bootstrap binary', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install', {
      ok: false, error: 'brew is required', missing_requirements: ['brew'],
    })
    wrapper = await open(mock)

    await wrapper.find('.ob-linkbtn').trigger('click')
    await flushPromises()

    expect(installCount(mock)).toBe(1)
  })

  it('still installs every missing dep when nothing blocks', async () => {
    // Guards the stop conditions above from becoming an unconditional break.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [
        dep({ id: 'node', group: 'foundation' }),
        dep({ id: 'pnpm', group: 'foundation' }),
      ],
    }))
    mock.setResponse('onboarding.install', { ok: true, output: 'done' })
    wrapper = await open(mock)

    await wrapper.find('.ob-linkbtn').trigger('click')
    await flushPromises()

    expect(installCount(mock)).toBe(2)
  })

  it('surfaces a failed install in the log with the backend text', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install', { ok: false, error: 'Error: no bottle available' })
    wrapper = await open(mock)

    await wrapper.find('.ob-linkbtn').trigger('click')
    await flushPromises()

    const log = wrapper.find('.ob-log').text()
    expect(log).toContain('no bottle available')
    expect(log).not.toContain('unknown')
  })

  // ── A single card's Install button ──────────────────────────────────────────
  // The reported symptom was "I click Python and nothing happens". Every case
  // below ends with the backend failing in well under a second, which used to
  // reach the user only through the log pane at the bottom of the column.

  /** Python as the backend actually reports it on a Mac without Homebrew. */
  function pythonStatus(brewOk: boolean): OnboardStatus {
    return status({
      deps: [
        dep({
          id: 'homebrew', label: 'Homebrew', group: 'foundation',
          needs_terminal: true, status: brewOk ? 'ok' : 'missing',
        }),
        dep({
          id: 'python', label: 'Python', group: 'foundation',
          install_cmd: 'brew install python3',
          requirements: [{ name: 'brew', ok: brewOk }],
        }),
      ],
    })
  }

  /** The Install button on the currently expanded card. */
  function installButton(w: VueWrapper) {
    return w.findAll('.oc-card.expanded .ob-btn.primary')[0]
  }

  it('sends the install request when a single card Install is clicked', async () => {
    // Nothing covered this at all: the existing cases all went through the
    // batch "install missing" link, not a card's own button.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', pythonStatus(true))
    mock.setResponse('onboarding.install', { ok: true, output: 'done' })
    wrapper = await open(mock)

    // Homebrew is ok, so Python is the first unfinished card and is expanded.
    await installButton(wrapper).trigger('click')
    await flushPromises()

    expect(mock.sent.filter((s) => s.type === 'onboarding.install')).toEqual([
      expect.objectContaining({ payload: { dep_id: 'python' } }),
    ])
  })

  it('shows a blocked install on the card, not only in the log', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', pythonStatus(true))
    mock.setResponse('onboarding.install', {
      ok: false,
      error: 'brew is required to install Python. Install brew first, then retry.',
      missing_requirements: ['brew'],
    })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    const card = wrapper.findAll('.oc-card.expanded')[0]
    expect(card.find('.oc-error').exists()).toBe(true)
    const text = card.find('.oc-error').text()
    expect(text).toContain('brew is required')
    // A failing in-app install must still leave a way forward by hand.
    expect(text).toContain('brew install python3')
  })

  it('names the missing prerequisite before the user clicks Install', async () => {
    // The backend already reports each dep's prerequisites and their state;
    // the wizard used to drop that and let the click fail instead.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', pythonStatus(false))
    wrapper = await open(mock)

    // Homebrew is the first unfinished card; open Python's.
    await wrapper.findAll('.oc-head')[1].trigger('click')
    await flushPromises()

    const card = wrapper.findAll('.oc-card.expanded')[0]
    expect(card.find('.oc-error').text()).toContain('Homebrew')
    // No install has been attempted — this is a pre-click warning.
    expect(installCount(mock)).toBe(0)
  })

  it('jumps to the prerequisite card from the blocked dep', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', pythonStatus(false))
    wrapper = await open(mock)

    await wrapper.findAll('.oc-head')[1].trigger('click')
    await flushPromises()
    const goTo = wrapper
      .findAll('.oc-card.expanded .ob-btn.ghost')
      .find((b) => b.text().includes('Homebrew'))
    expect(goTo).toBeDefined()

    await goTo!.trigger('click')
    await flushPromises()

    // Homebrew's card is now the expanded one.
    const cards = wrapper.findAll('.oc-card')
    expect(cards[0].classes()).toContain('expanded')
    expect(cards[1].classes()).not.toContain('expanded')
  })

  it('says an inline install is running while it has no output to show', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', pythonStatus(true))
    let release = (): void => {}
    const held = new Promise<void>((r) => { release = r })
    const original = mock.backend.send
    ;(mock.backend as { send: typeof original }).send = (async (t: string, p: never, ms: never) => {
      if (t === 'onboarding.install') await held
      return original(t, p, ms)
    }) as typeof original
    mock.setResponse('onboarding.install', { ok: true, output: 'done' })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    // Mid-install: brew streams nothing back, so this line is the only sign.
    expect(wrapper.find('.ob-running').exists()).toBe(true)
    expect(wrapper.find('.ob-running').text()).toContain('brew install python3')

    release()
    await flushPromises()
    expect(wrapper.find('.ob-running').exists()).toBe(false)
  })

  it('distinguishes "still the old version" from "not detected at all"', async () => {
    // `brew install python3` exits 0 while /usr/bin/python3 (3.9) keeps winning
    // the PATH. Saying "not detected" there is simply untrue.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [
        dep({
          id: 'python', label: 'Python', group: 'foundation',
          status: 'outdated', version: '3.9.6', min_version: '3.12.0',
          install_cmd: 'brew install python3',
        }),
      ],
    }))
    mock.setResponse('onboarding.install', { ok: true, output: 'done' })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    const text = wrapper.find('.oc-error').text()
    expect(text).toContain('3.9.6')
    expect(text).not.toContain(i18n.global.t('onboard.installed-not-detected', { label: 'Python' }))
  })

  it('installs a prerequisite before whatever needs it', async () => {
    // In list order this ran `brew install python3` first, which exits 127 on
    // a Mac with no Homebrew.
    stubTerminal({ ok: true })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [
        dep({ id: 'python', group: 'foundation', requirements: [{ name: 'brew', ok: false }] }),
        dep({ id: 'homebrew', group: 'foundation', needs_terminal: true }),
      ],
    }))
    mock.setResponse('onboarding.install', { ok: true, needs_terminal: true, command: 'install-brew.sh' })
    wrapper = await open(mock)

    await wrapper.find('.ob-linkbtn').trigger('click')
    await flushPromises()

    expect(mock.sent.filter((s) => s.type === 'onboarding.install')).toEqual([
      expect.objectContaining({ payload: { dep_id: 'homebrew' } }),
    ])
  })

  it('offers to start the Ollama service when it is installed but down', async () => {
    const s = status()
    s.deps = s.deps.map((d) => (d.id === 'ollama' ? { ...d, status: 'ok' as const } : d))
    s.gate = { ...s.gate, ollama_ok: true, ollama_service_up: false }
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', s)
    wrapper = await open(mock)

    // Step 2 holds the agent CLIs and the analyzer.
    await wrapper.findAll('.ob-steps button')[1].trigger('click')
    await flushPromises()
    // ollama detects as ok, so its card is collapsed — expanding a finished
    // card is exactly what used to be a dead click.
    await wrapper.findAll('.oc-head')[1].trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain(i18n.global.t('action.start-ollama'))
    expect(wrapper.text()).toContain(i18n.global.t('onboard.ollama-stopped'))
  })
})
