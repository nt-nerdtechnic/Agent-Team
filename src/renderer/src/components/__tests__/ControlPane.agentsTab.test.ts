// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'
import { executeCommand } from '@navide/shared'
import { _resetRegistry } from '@navide/shared/testing'

// The agent list, spawn card and resume notice moved out of the Pipeline tab
// into their own Agents tab. Anything that drives them programmatically has to
// surface that tab too, otherwise it writes into an unmounted subtree and the
// user sees nothing. These cases pin that down.

const props = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [
    { agentKey: 'claude', label: 'Claude Code' },
    { agentKey: 'qwen', label: 'Qwen Code' },
  ],
  roles: [],
  stages: [],
  panes: [],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: {},
  autoAnswerEnabled: false,
  existingProject: null,
} as unknown as Record<string, unknown>

/** True when the 1st tab button (Agents) carries the active class. */
function onAgentsTab(wrapper: VueWrapper): boolean {
  const btns = wrapper.findAll('.sidebar-tabs .tab-btn')
  return btns.length === 5 && btns[0].classes().includes('active')
}

describe('ControlPane – Agents tab is surfaced by programmatic entry points', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    _resetRegistry()
    // Start on the Pipeline tab: the agent pane is unmounted here.
    sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props,
      global: { mocks: { $t: (key: string) => key } }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
    _resetRegistry()
  })

  it('starts on the pipeline tab with the agent pane unmounted', () => {
    expect(onAgentsTab(wrapper)).toBe(false)
    expect(wrapper.find('.spawn-card').exists()).toBe(false)
  })

  it('showResumeError switches to the Agents tab so the notice is visible', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(wrapper.vm as any).showResumeError('session gone')
    await wrapper.vm.$nextTick()
    expect(onAgentsTab(wrapper)).toBe(true)
    expect(wrapper.text()).toContain('session gone')
  })

  it('Ctrl+<n> CLI pick switches to the Agents tab and opens the spawn card', async () => {
    expect(executeCommand('controlPane.selectCliType1')).toBe(true)
    await wrapper.vm.$nextTick()
    expect(onAgentsTab(wrapper)).toBe(true)
    expect(wrapper.find('.spawn-card').exists()).toBe(true)
  })

  it('Ctrl+<n> past the CLI list stays put', async () => {
    expect(executeCommand('controlPane.selectCliType9')).toBe(true)
    await wrapper.vm.$nextTick()
    expect(onAgentsTab(wrapper)).toBe(false)
  })
})
