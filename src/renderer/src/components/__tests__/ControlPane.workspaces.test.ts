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

/** A workspace row. `groups` mirrors whatever lineage the caller supplied: the
 *  sidebar renders through the group sections now, so a row without them shows
 *  no panes at all — and every test here is about the panes. */
const current = (over: Record<string, unknown> = {}) => {
  const row = {
    path: '/Users/me/Desktop/Agent-Team', label: 'Agent-Team',
    displayPath: '~/Desktop/Agent-Team', isCurrent: true, collapsed: false,
    count: 2, lineage: [], ...over
  }
  // A caller that supplies its own groups means to test them; otherwise the
  // row gets the one ungrouped section an untouched workspace has.
  return 'groups' in row ? row : { ...row, groups: [{ id: '', name: '', rows: row.lineage }] }
}

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

  it('shows the path under the name, with home collapsed', () => {
    // Two projects can share a folder name; the path is what tells them apart.
    wrapper = mountWith({ workspaces: [current()] })
    const path = wrapper.find('.ws-path')
    expect(path.exists()).toBe(true)
    expect(path.text()).toBe('~/Desktop/Agent-Team')
  })

  it('emits toggle-workspace from the caret', async () => {
    wrapper = mountWith({ workspaces: [current()] })
    await wrapper.find('.ws-caret').trigger('click')
    expect(wrapper.emitted('toggle-workspace')?.[0]).toEqual(['/Users/me/Desktop/Agent-Team'])
  })

  it('every workspace heading offers a way to add an agent', () => {
    wrapper = mountWith({
      workspaces: [current(), current({ path: '/Users/me/Desktop/Other', label: 'Other' })],
    })
    expect(wrapper.findAll('.ws-add')).toHaveLength(2)
  })

  it('this window own add is the spawn action, not just a card toggle', () => {
    wrapper = mountWith({ workspaces: [current()] })
    const own = wrapper.findAll('.ws-add')[0]
    // Guarded by the same condition as the card's button: with no agent
    // selected there is nothing to spawn, so it must not look clickable.
    expect(own.attributes('disabled')).toBeDefined()
  })

  it('moves rebuild-all and history onto the workspace row', async () => {
    // Both act on one workspace's panes, so grouped they belong on its row —
    // and the section header must not keep a second copy.
    wrapper = mountWith({ workspaces: [current()] })
    const acts = wrapper.find('.ws-head--current').findAll('.ws-act')
    expect(acts).toHaveLength(2)
    expect(wrapper.find('.agent-header-actions').exists()).toBe(false)
    await acts[1].trigger('click')
    expect(wrapper.emitted('open-history')).toBeTruthy()
  })

  it('keeps them in the header while nothing is grouped', () => {
    wrapper = mountWith({})
    expect(wrapper.find('.agent-header-actions').exists()).toBe(true)
    expect(wrapper.findAll('.ws-act')).toHaveLength(0)
  })

  it('offers neither opening nor switching in a detached window', async () => {
    // A detached window is one run group's view of ONE workspace. Both actions
    // are refused in App anyway; hiding them beats letting them do nothing.
    const other = current({ path: '/Users/me/Desktop/Other', label: 'Other' })
    wrapper = mountWith({
      workspace: '/Users/me/Desktop/Agent-Team',
      workspaces: [current(), other],
      detachedWindow: true,
    })
    expect(wrapper.find('.hdr-add-ws').exists()).toBe(false)
    const rows = wrapper.findAll('.ws-head--current')
    expect(rows[1].classes()).not.toContain('ws-head--switchable')
    await rows[1].trigger('click')
    expect(wrapper.emitted('switch-to-workspace')).toBeUndefined()
  })

  it('offers a way to open another workspace from the section header', async () => {
    // Orca's Projects header adds a project; the per-workspace ＋ below adds an
    // agent inside one. Two different things, so two different buttons.
    wrapper = mountWith({ workspaces: [current()] })
    const add = wrapper.find('.hdr-add-ws')
    expect(add.exists()).toBe(true)
    await add.trigger('click')
    expect(wrapper.emitted('open-workspace-picker')).toBeTruthy()
  })

  it('keeps that button even before anything is grouped', async () => {
    // The section is a list of projects either way.
    wrapper = mountWith({})
    await wrapper.find('.hdr-add-ws').trigger('click')
    expect(wrapper.emitted('open-workspace-picker')).toBeTruthy()
  })

  it('renders a section per local workspace, each with its own panes', () => {
    // Two projects in one window: each heading owns the panes its own lineage
    // names, and neither shows the other's.
    const second = current({
      path: '/Users/me/Desktop/Other', label: 'Other', displayPath: '~/Desktop',
      count: 1, lineage: [{ id: 'p2', depth: 0, hasChildren: false, collapsed: false }]
    })
    wrapper = mountWith({
      workspaces: [
        current({ lineage: [{ id: 'p1', depth: 0, hasChildren: false, collapsed: false }], count: 1 }),
        second
      ]
    })
    const heads = wrapper.findAll('.ws-head--current')
    expect(heads).toHaveLength(2)
    expect(wrapper.findAll('.ws-name').map((n) => n.text())).toEqual(['Agent-Team', 'Other'])
    // One pane under each, not both under the first.
    expect(wrapper.findAll('.agent-item')).toHaveLength(2)
  })

  it('colours a group spine by the same rollup its tab uses', async () => {
    // The colour used to be an identity palette hashed from the group id. That
    // said WHICH group a row belonged to — which the heading right above it
    // already says. The run state says something the heading does not.
    wrapper = mountWith({
      panes: [
        { id: 'p1', agentLabel: 'A', status: 'running', command: 'c', origin: 'manual', isMinimized: false, isCommander: false },
        { id: 'p2', agentLabel: 'B', status: 'idle', command: 'c', origin: 'manual', isMinimized: false, isCommander: false },
      ],
      workspaces: [current({
        count: 2,
        lineage: [
          { id: 'p1', depth: 0, hasChildren: false, collapsed: false },
          { id: 'p2', depth: 0, hasChildren: false, collapsed: false },
        ],
        groups: [
          { id: 'g1', name: '主要開發', rows: [{ id: 'p1', depth: 0, hasChildren: false, collapsed: false }] },
          { id: 'g2', name: '需求整理', rows: [{ id: 'p2', depth: 0, hasChildren: false, collapsed: false }] },
        ],
      })],
    })
    const heads = wrapper.findAll('.ws-grp')
    expect(heads).toHaveLength(2)
    // 'running' rolls up to active; 'idle' does not. Same rule as the tab dot,
    // because it IS the same function.
    expect(heads[0].attributes('data-state')).toBe('active')
    expect(heads[1].attributes('data-state')).toBe('idle')
  })

  it('asks to reorder when a heading is dropped on another', async () => {
    const second = current({ path: '/Users/me/Desktop/Other', label: 'Other' })
    wrapper = mountWith({ workspaces: [current(), second] })
    const heads = wrapper.findAll('.ws-head--current')
    const data = new Map([['application/x-workspace-path', '/Users/me/Desktop/Other']])
    await heads[0].trigger('drop', {
      dataTransfer: { getData: (t: string) => data.get(t) ?? '', types: [...data.keys()] },
    })
    expect(wrapper.emitted('reorder-workspace')?.[0]).toEqual([
      '/Users/me/Desktop/Other',
      '/Users/me/Desktop/Agent-Team',
    ])
  })

  it('does not ask when a heading is dropped on itself', async () => {
    // A drop on the row you picked up is a cancelled drag, not a reorder.
    const second = current({ path: '/Users/me/Desktop/Other', label: 'Other' })
    wrapper = mountWith({ workspaces: [current(), second] })
    const data = new Map([['application/x-workspace-path', '/Users/me/Desktop/Agent-Team']])
    await wrapper.findAll('.ws-head--current')[0].trigger('drop', {
      dataTransfer: { getData: (t: string) => data.get(t) ?? '', types: [...data.keys()] },
    })
    expect(wrapper.emitted('reorder-workspace')).toBeUndefined()
  })

  it('ignores a pane drag over a workspace heading', async () => {
    // The pane rows carry application/x-pane-id. Accepting it here would draw
    // a workspace drop line for a drag that cannot land on a heading.
    wrapper = mountWith({ workspaces: [current(), current({ path: '/x', label: 'x' })] })
    const head = wrapper.findAll('.ws-head--current')[0]
    await head.trigger('dragover', { dataTransfer: { types: ['application/x-pane-id'] } })
    expect(head.classes()).not.toContain('ws-head--drop')
  })

  it('shows no group heading when nobody has made a group', () => {
    // An untouched workspace must look exactly as it did before this existed.
    // A lone "manual" heading over everything distinguishes nothing.
    wrapper = mountWith({
      workspaces: [current({
        count: 1,
        lineage: [{ id: 'p1', depth: 0, hasChildren: false, collapsed: false }],
      })],
    })
    expect(wrapper.findAll('.ws-grp')).toHaveLength(0)
  })

  it('collapsing one local workspace leaves the other alone', () => {
    wrapper = mountWith({
      workspaces: [
        current({ lineage: [{ id: 'p1', depth: 0, hasChildren: false, collapsed: false }], count: 1, collapsed: true }),
        current({
          path: '/Users/me/Desktop/Other', label: 'Other', displayPath: '~/Desktop', count: 1,
          lineage: [{ id: 'p2', depth: 0, hasChildren: false, collapsed: false }]
        })
      ]
    })
    const hidden = wrapper.findAll('.agent-item').filter((r) => r.attributes('style')?.includes('display: none'))
    expect(hidden).toHaveLength(1)
  })

  it('offers a context menu on a workspace heading', async () => {
    wrapper = mountWith({ workspaces: [current()] })
    await wrapper.find('.ws-head--current').trigger('contextmenu')
    const menu = wrapper.find('.ws-ctx-menu')
    expect(menu.exists()).toBe(true)
    expect(menu.findAll('.ws-ctx-opt').length).toBeGreaterThanOrEqual(2)
  })

  it('will not offer to close the workspace the window was opened with', async () => {
    // Closing the primary would leave the window with no root.
    wrapper = mountWith({ workspace: '/Users/me/Desktop/Agent-Team', workspaces: [current()] })
    await wrapper.find('.ws-head--current').trigger('contextmenu')
    expect(wrapper.find('.ws-ctx-opt.danger').exists()).toBe(false)
  })

  it('closes an adopted workspace from that menu', async () => {
    const adopted = current({ path: '/Users/me/Desktop/Other', label: 'Other' })
    wrapper = mountWith({ workspace: '/Users/me/Desktop/Agent-Team', workspaces: [current(), adopted] })
    await wrapper.findAll('.ws-head--current')[1].trigger('contextmenu')
    const close = wrapper.find('.ws-ctx-opt.danger')
    expect(close.exists()).toBe(true)
    await close.trigger('click')
    expect(wrapper.emitted('close-workspace')?.[0]).toEqual(['/Users/me/Desktop/Other'])
  })

  it('reveals a workspace folder from that menu', async () => {
    // The titlebar button that used to do this is gone.
    wrapper = mountWith({ workspaces: [current()] })
    await wrapper.find('.ws-head--current').trigger('contextmenu')
    await wrapper.findAll('.ws-ctx-opt')[0].trigger('click')
    expect(wrapper.emitted('reveal-workspace-folder')?.[0]).toEqual(['/Users/me/Desktop/Agent-Team'])
  })

  it('closes that menu on Escape', async () => {
    wrapper = mountWith({ workspaces: [current()] })
    await wrapper.find('.ws-head--current').trigger('contextmenu')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ws-ctx-menu').exists()).toBe(false)
  })

  it('switches when the row is clicked, not just the name', async () => {
    // The name alone is a few characters wide with nothing to say it does
    // anything — the whole row is the target.
    const other = current({ path: '/Users/me/Desktop/Other', label: 'Other' })
    wrapper = mountWith({ workspace: '/Users/me/Desktop/Agent-Team', workspaces: [current(), other] })
    const rows = wrapper.findAll('.ws-head--current')
    // The one on screen is inert and not marked clickable.
    expect(rows[0].classes()).not.toContain('ws-head--switchable')
    await rows[0].trigger('click')
    expect(wrapper.emitted('switch-to-workspace')).toBeUndefined()
    expect(rows[1].classes()).toContain('ws-head--switchable')
    await rows[1].trigger('click')
    expect(wrapper.emitted('switch-to-workspace')?.[0]).toEqual(['/Users/me/Desktop/Other'])
  })

  it('the row controls keep working without switching', async () => {
    // caret, rebuild, history and ＋ all stop propagation.
    const other = current({ path: '/Users/me/Desktop/Other', label: 'Other' })
    wrapper = mountWith({ workspace: '/Users/me/Desktop/Agent-Team', workspaces: [current(), other] })
    const row = wrapper.findAll('.ws-head--current')[1]
    await row.find('.ws-caret').trigger('click')
    expect(wrapper.emitted('toggle-workspace')?.[0]).toEqual(['/Users/me/Desktop/Other'])
    expect(wrapper.emitted('switch-to-workspace')).toBeUndefined()
    await row.findAll('.ws-act')[1].trigger('click')
    expect(wrapper.emitted('open-history')).toBeTruthy()
    expect(wrapper.emitted('switch-to-workspace')).toBeUndefined()
  })

  it('marks which workspace is on screen', () => {
    const other = current({ path: '/Users/me/Desktop/Other', label: 'Other' })
    wrapper = mountWith({ workspace: '/Users/me/Desktop/Agent-Team', workspaces: [current(), other] })
    const heads = wrapper.findAll('.ws-head--current')
    expect(heads[0].classes()).toContain('ws-head--viewing')
    expect(heads[1].classes()).not.toContain('ws-head--viewing')
  })

  it('titles the section Workspace once workspaces are grouped', () => {
    wrapper = mountWith({ workspaces: [current()] })
    expect(wrapper.find('.agent-list-hdr .lbl').text()).toBe('label.workspace')
    wrapper.unmount()
    wrapper = mountWith({})
    expect(wrapper.find('.agent-list-hdr .lbl').text()).toBe('label.active-agents')
  })

})
