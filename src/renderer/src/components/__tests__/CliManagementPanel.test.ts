// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CliManagementPanel from '../CliManagementPanel.vue'
import { i18n } from '../../i18n'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { OnboardDep, OnboardStatus } from '../../composables/useOnboarding'

const depBase = {
  description: '', group: 'agent_cli' as const, min_version: '', optional: true,
  needs_terminal: true, can_install: true, docs_url: '',
}

const claude: OnboardDep = {
  ...depBase,
  id: 'claude', label: 'Claude Code', status: 'ok', version: '2.1.219',
  docs_url: 'https://docs.anthropic.com/claude-code',
  binary_path: '/Users/test/.local/bin/claude',
  resolved_path: '/Users/test/.local/share/claude/versions/2.1.219',
  install_method: 'native', update_cmd: 'claude update', doctor_cmd: 'claude doctor',
  autoupdate_env: 'DISABLE_AUTOUPDATER', autoupdate_policy: 'vendor',
}

// Kimi ships a doctor but no update subcommand.
const kimi: OnboardDep = {
  ...depBase,
  id: 'kimi', label: 'Kimi Code', status: 'ok', version: '0.9.0',
  docs_url: 'https://moonshotai.github.io/kimi-cli/en/',
  binary_path: '/Users/test/.kimi-code/bin/kimi',
  resolved_path: '/Users/test/.kimi-code/bin/kimi',
  install_method: 'script', update_cmd: '', doctor_cmd: 'kimi doctor',
  autoupdate_env: '', autoupdate_policy: '',
}

function status(): OnboardStatus {
  return {
    deps: [claude, kimi],
    models: [],
    model_catalog: [],
    gate: {
      foundation_ready: true, has_any_cli: true, analyzer_ready: false,
      ollama_ok: false, ollama_service_up: false, has_model: false,
      all_required_ready: true, suggested_model: '',
    },
    cli_health: {
      entries: [{
        agent_key: 'claude',
        label: 'Claude Code',
        diagnostic_command: 'claude doctor',
        update_command: 'claude update',
        docs_url: '',
        update_state: [{
          scope: 'profile:4ad13e88', home: '/Users/test/.navide/cli-profiles/claude/4ad13e88',
          timestamp: '2026-07-25T00:07:12.372Z', outcome: 'failed', status: 'install_failed',
          version_from: '2.1.219', version_to: '',
        }],
        candidates: [],
      }],
      findings: [{ type: 'update_failed', agent_key: 'claude', label: 'Claude Code' }],
      fingerprint: '0123456789abcdef',
      dismissed: false,
      needs_attention: true,
    },
    complete: true,
    skip: false,
  }
}

describe('CliManagementPanel', () => {
  let wrapper: VueWrapper | undefined
  const opened: string[] = []

  afterEach(() => { wrapper?.unmount(); opened.length = 0 })

  // Attach to the existing happy-dom window; replacing it wholesale would strip
  // the DOM event constructors vue-test-utils needs to trigger clicks.
  function stubTerminal(): void {
    ;(window as unknown as { agentTeam: { openTerminal: (c: string) => Promise<{ ok: boolean }> } }).agentTeam = {
      openTerminal: (c: string) => { opened.push(c); return Promise.resolve({ ok: true }) },
    }
  }

  async function mountPanel() {
    stubTerminal()
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.cli_maintenance', { ok: true, needs_terminal: true, command: 'claude update' })
    wrapper = mount(CliManagementPanel, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return mock
  }

  it('shows each CLI with its version, install method and the failed vendor update', async () => {
    await mountPanel()

    const text = wrapper!.text()
    expect(text).toContain('Claude Code')
    expect(text).toContain('2.1.219')
    expect(text).toContain('native installer')
    expect(text).toContain('/Users/test/.local/share/claude/versions/2.1.219')
    expect(text).toContain('failed')
    expect(wrapper!.get('.cm-update').classes()).toContain('failed')
  })

  it('runs the vendor update command rather than one of its own', async () => {
    const mock = await mountPanel()

    const update = wrapper!.findAll('button').find((button) => button.text().includes('claude update'))
    await update!.trigger('click')
    await flushPromises()

    expect(mock.sent).toContainEqual({
      type: 'onboarding.cli_maintenance',
      payload: { agent_key: 'claude', action: 'update' },
    })
    expect(opened).toEqual(['claude update'])
  })

  it('passes an unrecognised vendor outcome through verbatim', async () => {
    stubTerminal()
    const mock = createMockBackend('connected')
    const payload = status()
    payload.cli_health.entries[0].update_state[0].outcome = 'cancelled'
    mock.setResponse('onboarding.status', payload)
    wrapper = mount(CliManagementPanel, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.get('.cm-update').text()).toContain('cancelled')
  })

  it('links to vendor docs for a CLI with no update subcommand', async () => {
    await mountPanel()

    const link = wrapper!.findAll('a').find((anchor) => anchor.text().includes('vendor docs'))
    expect(link?.attributes('href')).toBe('https://moonshotai.github.io/kimi-cli/en/')
  })

  it('persists an auto-update policy change through the vendor switch', async () => {
    const mock = await mountPanel()

    const select = wrapper!.get('.cm-policy select')
    await select.setValue('manual')
    await flushPromises()

    expect(mock.sent).toContainEqual({
      type: 'onboarding.cli_autoupdate',
      payload: { agent_key: 'claude', policy: 'manual' },
    })
  })

  it('offers no policy control for a CLI without a vendor switch', async () => {
    await mountPanel()

    expect(wrapper!.findAll('.cm-policy')).toHaveLength(1)
  })
})
