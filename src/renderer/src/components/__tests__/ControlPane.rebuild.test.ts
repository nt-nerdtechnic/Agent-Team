// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

const minimalProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [
    {
      id: 'pane-resumable',
      agentKey: 'codex',
      agentLabel: 'Codex',
      status: 'idle',
      command: 'codex',
      origin: 'manual',
      isMinimized: false,
      rebuildVisible: true,
      canRebuild: true
    },
    {
      id: 'pane-fresh',
      agentKey: 'codex',
      agentLabel: 'Codex',
      status: 'idle',
      command: 'codex',
      origin: 'manual',
      isMinimized: false,
      rebuildVisible: true,
      canRebuild: false
    },
    {
      id: 'pane-not-resumable',
      agentKey: 'shell',
      agentLabel: 'Terminal',
      status: 'idle',
      command: 'zsh',
      origin: 'manual',
      isMinimized: false,
      rebuildVisible: false,
      canRebuild: false
    }
  ],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
  autoAnswerEnabled: false,
  existingProject: null,
  canRebuildAll: true,
  rebuildingAll: false
} as unknown as Record<string, unknown>

describe('ControlPane – rebuild control', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: minimalProps,
      global: { mocks: { $t: (key: string) => key } }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
  })

  it('renders for every resume-capable pane (visible), not only rebuildable ones', () => {
    // codex resumable + codex fresh render; the non-resumable shell pane does not
    expect(wrapper.findAll('.agent-rebuild-btn')).toHaveLength(2)
  })

  it('disables the button and shows the disabled tooltip for a not-yet-rebuildable pane', () => {
    const buttons = wrapper.findAll<HTMLButtonElement>('.agent-rebuild-btn')
    const enabled = buttons[0] // pane-resumable
    const disabled = buttons[1] // pane-fresh
    expect(enabled.element.disabled).toBe(false)
    expect(enabled.attributes('title')).toBe('pane.terminal.rebuild-tooltip')
    expect(disabled.element.disabled).toBe(true)
    expect(disabled.attributes('title')).toBe('pane.terminal.rebuild-tooltip-disabled')
  })

  it('emits the pane id so App can call its existing rebuild implementation', async () => {
    await wrapper.findAll('.agent-rebuild-btn')[0].trigger('click')
    expect(wrapper.emitted('rebuild')).toEqual([['pane-resumable']])
  })

  it('exposes the same rebuild-all event from the Active agents header', async () => {
    await wrapper.get('.agent-rebuild-all-btn').trigger('click')
    expect(wrapper.emitted('rebuild-all')).toEqual([[]])
  })

  it('disables rebuild-all while App reports a rebuild batch in progress', async () => {
    await wrapper.setProps({ rebuildingAll: true })
    expect(wrapper.get<HTMLButtonElement>('.agent-rebuild-all-btn').element.disabled).toBe(true)
    expect(wrapper.get('.agent-rebuild-all-btn').classes()).toContain('busy')
  })
})
