// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CliHealthGuide from '../CliHealthGuide.vue'
import { i18n } from '../../i18n'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { CliHealthStatus } from '../../composables/useOnboarding'

const health: CliHealthStatus = {
  entries: [{
    agent_key: 'claude',
    label: 'Claude Code',
    diagnostic_command: 'claude doctor',
    update_command: 'claude update',
    docs_url: '',
    update_state: [],
    candidates: [
      {
        path: '/Users/test/.nvm/bin/claude',
        resolved_path: '/Users/test/.nvm/lib/claude.exe',
        aliases: ['/Users/test/.nvm/bin/claude'],
        version: '2.1.210',
        status: 'ok',
        exit_code: 0,
        signal: '',
        duration_ms: 42,
        is_primary: true,
        install_manager: 'npm',
        removal_command: "printf 'remove'; npm uninstall -g @anthropic-ai/claude-code",
      },
      {
        path: '/opt/homebrew/bin/claude',
        resolved_path: '/opt/homebrew/lib/claude.exe',
        aliases: ['/opt/homebrew/bin/claude'],
        version: '2.1.168',
        status: 'ok',
        exit_code: 0,
        signal: '',
        duration_ms: 100,
        is_primary: false,
        install_manager: 'npm',
        removal_command: "printf 'remove'; npm uninstall -g @anthropic-ai/claude-code",
      },
    ],
  }],
  findings: [{
    type: 'duplicate_install',
    agent_key: 'claude',
    label: 'Claude Code',
  }],
  fingerprint: '0123456789abcdef',
  dismissed: false,
  needs_attention: true,
}

describe('CliHealthGuide', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => wrapper?.unmount())

  it('shows the active and alternate binaries with exact versions and paths', () => {
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    expect(wrapper.text()).toContain('2.1.210')
    expect(wrapper.text()).toContain('/Users/test/.nvm/bin/claude')
    expect(wrapper.text()).toContain('2.1.168')
    expect(wrapper.text()).toContain('/opt/homebrew/bin/claude')
    expect(wrapper.get('.ch-dialog').attributes('role')).toBe('dialog')
    expect(wrapper.get('.ch-dialog').attributes('aria-modal')).toBe('true')
  })

  it('persists the exact fingerprint when the user skips the guide', async () => {
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.get('.ch-footer .ghost').trigger('click')

    expect(mock.sent).toContainEqual({
      type: 'onboarding.cli_health.dismiss',
      payload: { fingerprint: '0123456789abcdef' },
    })
    expect(wrapper.emitted('close')).toEqual([[]])
  })

  it('persists the fingerprint when closing from the verify step', async () => {
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })
    const next = () => wrapper!.findAll('button').find((button) => button.text() === 'Next')!

    await next().trigger('click')
    await next().trigger('click')
    const close = wrapper.findAll('button').find((button) => button.text() === "Close and don't remind me")
    await close!.trigger('click')

    expect(mock.sent).toContainEqual({
      type: 'onboarding.cli_health.dismiss',
      payload: { fingerprint: '0123456789abcdef' },
    })
    expect(wrapper.emitted('close')).toEqual([[]])
  })

  it('offers a working alternate as an immediate Navide action', async () => {
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.get('.ch-use-binary').trigger('click')

    expect(mock.sent).toContainEqual({
      type: 'onboarding.cli_health.select_binary',
      payload: {
        agent_key: 'claude',
        path: '/opt/homebrew/bin/claude',
        fingerprint: '0123456789abcdef',
      },
    })
    expect(wrapper.emitted('use-binary')).toEqual([[
      { agentKey: 'claude', path: '/opt/homebrew/bin/claude', version: '2.1.168' },
    ]])
  })

  it('asks for in-app confirmation before opening removal in Terminal', async () => {
    const commands: string[] = []
    window.agentTeam = {
      openTerminal: async (command: string) => {
        commands.push(command)
        return { ok: true }
      },
    } as typeof window.agentTeam
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.findAll('.ch-remove-binary')[1].trigger('click')

    expect(commands).toEqual([])
    expect(wrapper.get('.ch-confirm').text()).toContain('/opt/homebrew/bin/claude')
    expect(wrapper.get('.ch-confirm').text()).toContain('/Users/test/.nvm/bin/claude')

    await wrapper.get('.ch-confirm-removal').trigger('click')

    expect(commands).toEqual(["printf 'remove'; npm uninstall -g @anthropic-ai/claude-code"])
    expect(wrapper.text()).toContain('confirmation prompt')
  })

  it('cancelling the in-app confirmation opens nothing in Terminal', async () => {
    const commands: string[] = []
    window.agentTeam = {
      openTerminal: async (command: string) => {
        commands.push(command)
        return { ok: true }
      },
    } as typeof window.agentTeam
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.findAll('.ch-remove-binary')[1].trigger('click')
    await wrapper.get('.ch-cancel-removal').trigger('click')

    expect(commands).toEqual([])
    expect(wrapper.find('.ch-confirm').exists()).toBe(false)
  })

  it('never offers removal for the only working installation', () => {
    const soleWorking = structuredClone(health)
    soleWorking.entries[0].candidates[0].resolved_path = '/Users/test/.nvm/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    soleWorking.entries[0].candidates[1].resolved_path = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    soleWorking.entries[0].candidates[1].status = 'failed'
    const mock = createMockBackend('connected')

    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: soleWorking },
      global: { plugins: [i18n] },
    })

    // Only the broken duplicate is removable; the sole working install shows
    // a blocked note even though the (legacy) backend supplied a command.
    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(1)
    expect(wrapper.get('.ch-blocked').text()).toContain('no other working installation')
  })

  it('offers removal for an older backend payload when npm ownership is clear', () => {
    const legacyHealth = structuredClone(health)
    delete legacyHealth.entries[0].candidates[0].install_manager
    delete legacyHealth.entries[0].candidates[0].removal_command
    delete legacyHealth.entries[0].candidates[1].install_manager
    delete legacyHealth.entries[0].candidates[1].removal_command
    legacyHealth.entries[0].candidates[0].resolved_path = '/Users/test/.nvm/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    legacyHealth.entries[0].candidates[1].resolved_path = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    const mock = createMockBackend('connected')

    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: legacyHealth },
      global: { plugins: [i18n] },
    })

    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(2)
  })

  it('blocks the second removal until re-detect refreshes the data', async () => {
    const dual = structuredClone(health)
    dual.entries[0].candidates[0].resolved_path = '/Users/test/.nvm/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    dual.entries[0].candidates[1].resolved_path = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    const commands: string[] = []
    window.agentTeam = {
      openTerminal: async (command: string) => {
        commands.push(command)
        return { ok: true }
      },
    } as typeof window.agentTeam
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: dual },
      global: { plugins: [i18n] },
    })

    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(2)

    await wrapper.findAll('.ch-remove-binary')[1].trigger('click')
    await wrapper.get('.ch-confirm-removal').trigger('click')
    await flushPromises()

    // The initiated removal consumed the only backup: no further removal is
    // offered on the stale snapshot, and the survivor explains why.
    expect(commands).toHaveLength(1)
    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(0)
    expect(wrapper.findAll('.ch-blocked')).toHaveLength(1)
  })

  it('keeps guided removal available for a broken sole install', () => {
    const brokenOnly = structuredClone(health)
    brokenOnly.entries[0].candidates = [{ ...brokenOnly.entries[0].candidates[0], status: 'failed' }]
    const mock = createMockBackend('connected')

    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: brokenOnly },
      global: { plugins: [i18n] },
    })

    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(1)
    expect(wrapper.find('.ch-blocked').exists()).toBe(false)
  })

  it('does not reconstruct a command the backend deliberately left empty', () => {
    const suppressed = structuredClone(health)
    suppressed.entries[0].candidates[0].resolved_path = '/Users/test/.nvm/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    suppressed.entries[0].candidates[1].resolved_path = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    suppressed.entries[0].candidates[1].removal_command = ''
    const mock = createMockBackend('connected')

    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: suppressed },
      global: { plugins: [i18n] },
    })

    // Candidate 1 is allowed by the gate but the backend said "unavailable"
    // (e.g. npm missing): no fabricated fallback button, no blocked note.
    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(1)
    expect(wrapper.find('.ch-blocked').exists()).toBe(false)
  })

  it('clears an open confirmation when re-detect replaces the health data', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', { cli_health: structuredClone(health) })
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.findAll('.ch-remove-binary')[1].trigger('click')
    expect(wrapper.find('.ch-confirm').exists()).toBe(true)

    const next = () => wrapper!.findAll('button').find((button) => button.text() === 'Next')!
    await next().trigger('click')
    await next().trigger('click')
    await wrapper.get('.ch-verify button').trigger('click')
    await flushPromises()

    const back = () => wrapper!.findAll('.ch-footer .ch-btn.ghost')[1]
    await back().trigger('click')
    await back().trigger('click')

    expect(wrapper.find('.ch-confirm').exists()).toBe(false)
    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(2)
  })
})
