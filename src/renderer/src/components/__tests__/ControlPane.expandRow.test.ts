// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// Coverage for the compact Active Agents list (one-line rows, click-to-expand
// accordion): a click on an agent-line focuses the pane AND toggles the row's
// detail body; at most one row is expanded at a time; collapsed rows hide the
// command/detail/actions body but keep the status dot visible.

const minimalProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [
    { id: 'pane-a', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false },
    { id: 'pane-b', agentLabel: 'Codex', status: 'idle', command: 'codex', origin: 'manual', isMinimized: false, isCommander: false }
  ],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
  autoAnswerEnabled: false,
  existingProject: null
} as unknown as Record<string, unknown>

describe('ControlPane – compact agent rows with click-to-expand', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
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

  it('renders every row collapsed: status dot visible, detail body absent', () => {
    const items = wrapper.findAll('.agent-item')
    expect(items).toHaveLength(2)
    expect(wrapper.findAll('.status-dot')).toHaveLength(2)
    expect(wrapper.find('.status-dot').attributes('data-state')).toBe('running')
    expect(wrapper.find('.agent-cmd').exists()).toBe(false)
    expect(wrapper.find('.row.tight').exists()).toBe(false)
    expect(items[0].classes()).not.toContain('expanded')
    expect(wrapper.findAll('.agent-line-sub')).toHaveLength(2)
  })

  it('click expands the row, shows the detail body, and emits focus-pane', async () => {
    await wrapper.findAll('.agent-line')[0].trigger('click')
    const events = wrapper.emitted('focus-pane')
    expect(events).toHaveLength(1)
    // Payload: pane id + the native MouseEvent (so App can read modifier keys).
    expect(events![0][0]).toBe('pane-a')
    expect(events![0][1]).toBeInstanceOf(MouseEvent)
    const items = wrapper.findAll('.agent-item')
    expect(items[0].classes()).toContain('expanded')
    expect(items[0].find('.agent-cmd').text()).toContain('claude')
    expect(items[0].find('.row.tight').exists()).toBe(true)
    expect(items[0].find('.state').attributes('data-state')).toBe('running')
    // Expanded row hides inline sub-label and shows detail card's role line
    expect(items[0].find('.agent-line-sub').exists()).toBe(false)
    expect(items[0].find('.agent-role-line').exists()).toBe(true)
  })

  it('second click on the same row collapses it (still re-emitting focus-pane)', async () => {
    await wrapper.findAll('.agent-line')[0].trigger('click')
    await wrapper.findAll('.agent-line')[0].trigger('click')
    const events = wrapper.emitted('focus-pane')
    expect(events?.map((e) => e[0])).toEqual(['pane-a', 'pane-a'])
    expect(wrapper.findAll('.agent-item')[0].classes()).not.toContain('expanded')
    expect(wrapper.find('.agent-cmd').exists()).toBe(false)
  })

  it('modifier click emits focus-pane but leaves the accordion toggle memory untouched', async () => {
    // Real-app contract: a modifier click still moves focus (App calls
    // selectPane), and focus alone expands a row via the :class binding. What
    // a modifier click must NOT do is move the accordion's own toggle memory
    // (expandedPaneId) — so the parent's focusPaneId prop is fed back here.
    // Open pane-b via a plain click; the parent focuses it.
    await wrapper.findAll('.agent-line')[1].trigger('click')
    await wrapper.setProps({ focusPaneId: 'pane-b' })
    // Modifier-click pane-a; the parent moves focus there.
    await wrapper.findAll('.agent-line')[0].trigger('click', { metaKey: true })
    const events = wrapper.emitted('focus-pane')
    expect(events).toHaveLength(2)
    expect((events![1][1] as MouseEvent).metaKey).toBe(true)
    await wrapper.setProps({ focusPaneId: 'pane-a' })
    const items = wrapper.findAll('.agent-item')
    // pane-a expands through focus — the existing focus-driven contract...
    expect(items[0].classes()).toContain('expanded')
    // ...while pane-b stays expanded: the toggle memory was not moved by the
    // modifier click (a plain click on pane-a would have collapsed pane-b).
    expect(items[1].classes()).toContain('expanded')
  })

  it('expanding another row collapses the first (single-open accordion)', async () => {
    await wrapper.findAll('.agent-line')[0].trigger('click')
    await wrapper.findAll('.agent-line')[1].trigger('click')
    const items = wrapper.findAll('.agent-item')
    expect(items[0].classes()).not.toContain('expanded')
    expect(items[1].classes()).toContain('expanded')
    expect(wrapper.findAll('.agent-cmd')).toHaveLength(1)
    expect(items[1].find('.agent-cmd').text()).toContain('codex')
  })
})
