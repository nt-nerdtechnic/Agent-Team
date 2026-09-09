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

  it('reserves the caret slot on childless rows once any row has children', () => {
    // The caret occupies a fixed slot before the status dot. Without a spacer
    // on the rows that have no caret, a pane that happened to spawn a child
    // sat 18px right of its childless siblings at the SAME depth.
    wrapper = mountWith({
      lineage: [
        { id: 'root', depth: 0, hasChildren: true, collapsed: false },
        { id: 'kid-1', depth: 1, hasChildren: false, collapsed: false },
        { id: 'kid-2', depth: 0, hasChildren: false, collapsed: false }
      ]
    })
    const lines = wrapper.findAll('.agent-line')
    // Row 0 draws the caret; rows 1 and 2 draw the spacer that matches it.
    expect(lines[0].find('.lineage-caret').exists()).toBe(true)
    expect(lines[0].find('.lineage-spacer').exists()).toBe(false)
    expect(lines[1].find('.lineage-spacer').exists()).toBe(true)
    expect(lines[2].find('.lineage-spacer').exists()).toBe(true)
  })

  it('reserves nothing when no row in the list has children', () => {
    // A sidebar with no parent/child anywhere keeps the left edge it has
    // always had — the fix must not shift a flat list sideways.
    wrapper = mountWith({
      lineage: [
        { id: 'root', depth: 0, hasChildren: false, collapsed: false },
        { id: 'kid-1', depth: 0, hasChildren: false, collapsed: false },
        { id: 'kid-2', depth: 0, hasChildren: false, collapsed: false }
      ]
    })
    expect(wrapper.findAll('.lineage-caret')).toHaveLength(0)
    expect(wrapper.findAll('.lineage-spacer')).toHaveLength(0)
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

  it('reserves the caret slot when the rows come from a workspace heading', () => {
    // With workspace headings on, the rows are read off `workspaces`, and
    // `lineage` is left empty. Keying the reserved slot off `lineage` reserved
    // nothing on exactly the list that draws the carets, so a childless pane
    // still sat 18px left of the sibling that had spawned a child.
    wrapper = mountWith({
      lineage: [],
      workspaces: [
        {
          path: '/ws',
          label: 'ws',
          displayPath: '~/ws',
          isCurrent: true,
          collapsed: false,
          count: 3, paneIds: [],
          lineage: [],
          groups: [
            {
              id: '',
              name: '',
              rows: [
                { id: 'kid-2', depth: 0, hasChildren: false, collapsed: false },
                { id: 'root', depth: 0, hasChildren: true, collapsed: false },
                { id: 'kid-1', depth: 1, hasChildren: false, collapsed: false }
              ]
            }
          ]
        }
      ]
    })
    const lines = wrapper.findAll('.agent-line')
    expect(lines).toHaveLength(3)
    // The childless pane at depth 0 lines up with its parent sibling.
    expect(lines[0].find('.lineage-spacer').exists()).toBe(true)
    expect(lines[1].find('.lineage-caret').exists()).toBe(true)
    expect(lines[2].find('.lineage-spacer').exists()).toBe(true)
  })

  it('reserves nothing in a flat workspace just because ANOTHER one has lineage', () => {
    // One window can hold several projects. Asking the question once for the
    // whole window indented every row of the flat project against a caret that
    // lives in the other one — and a collapsed project still counted, so the
    // caret was not even on screen.
    wrapper = mountWith({
      lineage: [],
      workspaces: [
        {
          path: '/deep',
          label: 'deep',
          displayPath: '~/deep',
          isCurrent: true,
          collapsed: true,
          count: 2, paneIds: [],
          lineage: [],
          groups: [
            {
              id: '',
              name: '',
              rows: [
                { id: 'root', depth: 0, hasChildren: true, collapsed: false },
                { id: 'kid-1', depth: 1, hasChildren: false, collapsed: false }
              ]
            }
          ]
        },
        {
          path: '/flat',
          label: 'flat',
          displayPath: '~/flat',
          isCurrent: true,
          collapsed: false,
          count: 1, paneIds: [],
          lineage: [],
          groups: [
            { id: '', name: '', rows: [{ id: 'kid-2', depth: 0, hasChildren: false, collapsed: false }] }
          ]
        }
      ]
    })
    const flatRow = wrapper.findAll('.agent-line').find((l) => l.text().includes('Reviewer'))
    expect(flatRow).toBeDefined()
    expect(flatRow!.find('.lineage-spacer').exists()).toBe(false)
    // The project that does have lineage still reserves the slot for its own
    // childless rows (kid-1 is indented, so it keeps its spacer).
    expect(wrapper.findAll('.lineage-caret')).toHaveLength(1)
  })

  it('reserves nothing in a workspace whose rows have no children', () => {
    wrapper = mountWith({
      lineage: [],
      workspaces: [
        {
          path: '/ws',
          label: 'ws',
          displayPath: '~/ws',
          isCurrent: true,
          collapsed: false,
          count: 3, paneIds: [],
          lineage: [],
          groups: [
            {
              id: '',
              name: '',
              rows: [
                { id: 'root', depth: 0, hasChildren: false, collapsed: false },
                { id: 'kid-1', depth: 0, hasChildren: false, collapsed: false },
                { id: 'kid-2', depth: 0, hasChildren: false, collapsed: false }
              ]
            }
          ]
        }
      ]
    })
    expect(wrapper.findAll('.lineage-spacer')).toHaveLength(0)
  })
})
