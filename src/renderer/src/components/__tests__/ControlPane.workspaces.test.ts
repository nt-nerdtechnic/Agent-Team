// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// The sidebar's outer layer is the workspace (project), not a tab group.
//
// Only one workspace per window has live panes — the one this window owns.
// Every other row comes from the backend messaging registry, which knows a
// pane's name, agent and busy flag and nothing else, so those rows are
// read-only and click through to the window that does own them.

const localPanes = [
  { id: 'p1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false },
  { id: 'p2', agentLabel: 'Codex', status: 'idle', command: 'codex', origin: 'manual', isMinimized: false, isCommander: false }
]

const remote = (name: string, opts: Partial<{ busy: boolean; offline: boolean }> = {}) => ({
  pane_id: `r-${name}`,
  name,
  workspace_path: '/other',
  agent_key: 'claude',
  busy: opts.busy ?? false,
  offline: opts.offline ?? false
})

function mountWith(extra: Record<string, unknown>): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      agentSpecs: [],
      roles: [],
      stages: [],
      panes: localPanes,
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false,
      existingProject: null,
      ...extra
    } as never,
    global: { mocks: { $t: (key: string) => key } }
  })
}

const current = (over: Record<string, unknown> = {}) => ({
  path: '/here', label: 'Agent-Team', isCurrent: true, collapsed: false,
  count: 2, lineage: [], remote: [], ...over
})
const other = (over: Record<string, unknown> = {}) => ({
  path: '/other', label: 'DealPilot', isCurrent: false, collapsed: false,
  count: 1, lineage: [], remote: [remote('分析後台')], ...over
})

describe('ControlPane – workspace sections', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper?.unmount())

  it('renders the flat list when no workspaces prop is given', () => {
    wrapper = mountWith({})
    expect(wrapper.findAll('.ws-head')).toHaveLength(0)
    expect(wrapper.findAll('.agent-item')).toHaveLength(2)
  })

  it('shows this window own workspace heading with its pane count', () => {
    wrapper = mountWith({ workspaces: [current()] })
    const head = wrapper.find('.ws-head')
    expect(head.exists()).toBe(true)
    expect(head.classes()).toContain('ws-head--current')
    expect(head.text()).toContain('Agent-Team')
    expect(wrapper.find('.ws-count').text()).toBe('2')
  })

  it('puts this window workspace first, others after', () => {
    wrapper = mountWith({ workspaces: [current(), other()] })
    const names = wrapper.findAll('.ws-name').map((n) => n.text())
    expect(names).toEqual(['Agent-Team', 'DealPilot'])
  })

  it('renders another workspace panes as read-only rows', () => {
    wrapper = mountWith({ workspaces: [current(), other()] })
    const remotes = wrapper.findAll('.remote-item')
    expect(remotes).toHaveLength(1)
    expect(remotes[0].text()).toContain('分析後台')
    // No per-pane controls: this window has no terminal for it.
    expect(remotes[0].find('.agent-line-actions').exists()).toBe(false)
  })

  it('maps busy and offline onto the status dot', () => {
    wrapper = mountWith({
      workspaces: [current(), other({ remote: [remote('busy-one', { busy: true }), remote('gone', { offline: true })] })]
    })
    const states = wrapper.findAll('.remote-item .status-dot').map((d) => d.attributes('data-state'))
    expect(states).toEqual(['running', 'error'])
  })

  it('emits toggle-workspace from the caret', async () => {
    wrapper = mountWith({ workspaces: [current()] })
    await wrapper.find('.ws-caret').trigger('click')
    expect(wrapper.emitted('toggle-workspace')?.[0]).toEqual(['/here'])
  })

  it('hides a collapsed workspace rows but keeps its heading', () => {
    wrapper = mountWith({ workspaces: [current(), other({ collapsed: true })] })
    expect(wrapper.findAll('.ws-head')).toHaveLength(2)
    // v-show, so the element is present but not displayed.
    const hidden = wrapper.findAll('.remote-item').filter((r) => r.attributes('style')?.includes('display: none'))
    expect(hidden).toHaveLength(1)
  })

  it('emits reveal-workspace when another workspace name is clicked', async () => {
    wrapper = mountWith({ workspaces: [current(), other()] })
    const names = wrapper.findAll('.ws-name')
    await names[1].trigger('click')
    expect(wrapper.emitted('reveal-workspace')?.[0]).toEqual(['/other'])
  })

  it('emits reveal-workspace when one of its panes is clicked', async () => {
    wrapper = mountWith({ workspaces: [current(), other()] })
    await wrapper.find('.remote-item').trigger('click')
    expect(wrapper.emitted('reveal-workspace')?.[0]).toEqual(['/other'])
  })

  it('every workspace heading offers a way to add an agent', () => {
    wrapper = mountWith({ workspaces: [current(), other()] })
    expect(wrapper.findAll('.ws-add')).toHaveLength(2)
  })

  it('only another workspace add emits — this one opens the local spawn card', async () => {
    wrapper = mountWith({ workspaces: [current(), other()] })
    const adds = wrapper.findAll('.ws-add')
    await adds[0].trigger('click')          // this window's own heading
    expect(wrapper.emitted('add-in-workspace')).toBeUndefined()
    await adds[1].trigger('click')          // the other workspace
    expect(wrapper.emitted('add-in-workspace')?.[0]).toEqual(['/other'])
  })
})
