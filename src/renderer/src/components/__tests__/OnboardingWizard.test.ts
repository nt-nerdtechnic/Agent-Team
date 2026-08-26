// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import OnboardingWizard from '../OnboardingWizard.vue'
import { i18n } from '@navide/ui-foundation'
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
