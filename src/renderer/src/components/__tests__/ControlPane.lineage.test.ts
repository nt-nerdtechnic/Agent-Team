// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// The Active Agents list renders a lineage tree: rows come from the `lineage`
// prop (App's structure layer) and are joined with `panes` (the status layer
// App rebuilds every 400ms). Keeping the two apart is the point — see the
// comment on orderedPanes — so these tests pin the join, not the tree walk.

const basePanes = [
  { id: 'root', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false },
  { id: 'kid-1', agentLabel: 'Explorer', status: 'idle', command: 'claude', origin: 'mcp', isMinimized: false, isCommander: false },
  { id: 'kid-2', agentLabel: 'Reviewer', status: 'idle', command: 'claude', origin: 'mcp', isMinimized: false, isCommander: false }
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
      panes: basePanes,
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

describe('ControlPane – lineage tree', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper?.unmount())

  it('renders the flat list unchanged when no lineage prop is supplied', () => {
    wrapper = mountWith({})
    const items = wrapper.findAll('.agent-item')
    expect(items).toHaveLength(3)
    expect(items.every((i) => !i.attributes('style'))).toBe(true)
  })

  it('indents each row by its depth', () => {
    wrapper = mountWith({
      lineage: [
        { id: 'root', depth: 0, hasChildren: true, collapsed: false },
        { id: 'kid-1', depth: 1, hasChildren: false, collapsed: false },
        { id: 'kid-2', depth: 1, hasChildren: false, collapsed: false }
      ]
    })
    const styles = wrapper.findAll('.agent-item').map((i) => i.attributes('style') ?? '')
    expect(styles[0]).not.toContain('margin-left')
    expect(styles[1]).toContain('13px')
    expect(styles[2]).toContain('13px')
  })

  it('follows the lineage order, not the panes order', () => {
    wrapper = mountWith({
      lineage: [
        { id: 'kid-2', depth: 0, hasChildren: false, collapsed: false },
        { id: 'root', depth: 0, hasChildren: false, collapsed: false },
        { id: 'kid-1', depth: 0, hasChildren: false, collapsed: false }
      ]
    })
    const labels = wrapper.findAll('.agent-item').map((i) => i.text())
    expect(labels[0]).toContain('Reviewer')
    expect(labels[1]).toContain('Claude')
  })

  it('shows a caret only on rows that have children', () => {
    wrapper = mountWith({
      lineage: [
        { id: 'root', depth: 0, hasChildren: true, collapsed: false },
        { id: 'kid-1', depth: 1, hasChildren: false, collapsed: false },
        { id: 'kid-2', depth: 1, hasChildren: false, collapsed: false }
      ]
    })
    expect(wrapper.findAll('.lineage-caret')).toHaveLength(1)
  })

  it('emits toggle-collapsed with the pane id when the caret is clicked', async () => {
    wrapper = mountWith({
      lineage: [{ id: 'root', depth: 0, hasChildren: true, collapsed: false }]
    })
    await wrapper.find('.lineage-caret').trigger('click')
    expect(wrapper.emitted('toggle-collapsed')?.[0]).toEqual(['root'])
  })

  it('renders a folded parent with no children rows, and flips the caret', () => {
    // A collapsed subtree is absent from `lineage` itself — App drops it during
    // the walk — so the list simply has fewer rows.
    wrapper = mountWith({
      lineage: [{ id: 'root', depth: 0, hasChildren: true, collapsed: true }]
    })
    expect(wrapper.findAll('.agent-item')).toHaveLength(1)
    expect(wrapper.find('.lineage-caret').text()).toBe('▸')
  })

  it('does not badge agent-spawned panes', () => {
    // origin === 'mcp' is still recorded and still drives spawn behaviour; it
    // just does not need a badge. The indentation already says an agent
    // spawned this pane, and the badge repeated it on the row where the
    // pane's own name has least room to begin with.
    wrapper = mountWith({
      lineage: [
        { id: 'root', depth: 0, hasChildren: true, collapsed: false },
        { id: 'kid-1', depth: 1, hasChildren: false, collapsed: false }
      ]
    })
    expect(wrapper.findAll('.mcp-tag')).toHaveLength(0)
    // The child is still under its parent — the signal that replaced it.
    const rows = wrapper.findAll('.agent-item')
    expect(rows[1].attributes('style')).toContain('margin-left')
  })

  it('skips lineage rows whose pane has not arrived yet', () => {
    // The two props are separate reactive writes; a frame can see one first.
    wrapper = mountWith({
      lineage: [
        { id: 'root', depth: 0, hasChildren: false, collapsed: false },
        { id: 'not-yet-spawned', depth: 1, hasChildren: false, collapsed: false }
      ]
    })
    expect(wrapper.findAll('.agent-item')).toHaveLength(1)
  })
})
