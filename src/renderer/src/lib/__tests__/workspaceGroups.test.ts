import { describe, expect, it } from 'vitest'
import { buildWorkspaceGroups, workspaceParentPath, type LineageRow } from '../workspaceGroups'

// The sidebar's grouping, run for real rather than read as source text. It sat
// inside App.vue, which cannot be mounted in a test (backend and terminal
// lifecycles start on mount), so every assertion about it was a grep over the
// file. These call it.

const HOME = '/Users/me'

const pane = (
  id: string,
  ws: string,
  runGroupId = '',
): { id: string; workspacePath: string; runGroupId: string } => ({
  id,
  workspacePath: ws,
  runGroupId,
})
const row = (id: string, depth = 0): LineageRow => ({
  id,
  depth,
  hasChildren: false,
  collapsed: false,
})
const A = '/Users/me/Desktop/alpha'
const B = '/Users/me/Desktop/beta'
const C = '/Users/me/Git/gamma'

function build(over: Partial<Parameters<typeof buildWorkspaceGroups>[0]> = {}) {
  return buildWorkspaceGroups({
    here: A,
    order: [A],
    panes: [],
    lineage: [],
    runGroups: [],
    collapsed: new Set<string>(),
    homeDir: HOME,
    ...over,
  })
}

describe('workspaceParentPath', () => {
  it('shows the folder the workspace sits in, home collapsed', () => {
    expect(workspaceParentPath(A, HOME)).toBe('~/Desktop')
    expect(workspaceParentPath(C, HOME)).toBe('~/Git')
  })

  it('ignores a trailing slash', () => {
    expect(workspaceParentPath(`${A}/`, HOME)).toBe('~/Desktop')
  })

  it('falls back to the folder itself at the root', () => {
    expect(workspaceParentPath('/alpha', HOME)).toBe('/alpha')
  })

  it('leaves a path outside home alone', () => {
    expect(workspaceParentPath('/opt/work/proj', HOME)).toBe('/opt/work')
  })
})

describe('buildWorkspaceGroups', () => {
  it('splits a workspace into its run groups, in tab order', () => {
    const rows = build({
      panes: [pane('a', A, 'g2'), pane('b', A, 'g1'), pane('c', A, 'g2')],
      lineage: [row('a'), row('b'), row('c')],
      runGroups: [{ id: 'g1', name: '需求整理' }, { id: 'g2', name: '主要開發' }],
    })
    // Tab order, not spawn order: the sidebar and the tabs must name things in
    // the same sequence or they read as two different lists.
    expect(rows[0].groups.map((g) => g.name)).toEqual(['需求整理', '主要開發'])
    expect(rows[0].groups[1].rows.map((r) => r.id)).toEqual(['a', 'c'])
  })

  it('renders in grouped order, because that is what the eye walks', () => {
    // lineage IS the render order — shift-range selection walks it.
    const rows = build({
      panes: [pane('a', A, 'g2'), pane('b', A, 'g1')],
      lineage: [row('a'), row('b')],
      runGroups: [{ id: 'g1', name: 'one' }, { id: 'g2', name: 'two' }],
    })
    expect(rows[0].lineage.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('keeps a child with its parent', () => {
    // An MCP child inherits its parent's runGroupId at spawn, so a subtree is
    // always whole. If that ever stopped being true, grouping would tear a
    // child away from the parent it is indented under.
    const rows = build({
      panes: [pane('p', A, 'g1'), pane('kid', A, 'g1'), pane('other', A, 'g2')],
      lineage: [row('p'), row('kid', 1), row('other')],
      runGroups: [{ id: 'g1', name: 'one' }, { id: 'g2', name: 'two' }],
    })
    const first = rows[0].groups[0]
    expect(first.rows.map((r) => r.id)).toEqual(['p', 'kid'])
    expect(first.rows[1].depth).toBe(1)
  })

  it('puts ungrouped panes last, as leftovers rather than a group', () => {
    const rows = build({
      panes: [pane('loose', A), pane('g', A, 'g1')],
      lineage: [row('loose'), row('g')],
      runGroups: [{ id: 'g1', name: 'one' }],
    })
    expect(rows[0].groups.map((g) => g.id)).toEqual(['g1', ''])
    expect(rows[0].groups[1].name).toBe('')
  })

  it('drops a group with no panes', () => {
    // A heading with nothing under it is a dead row: it cannot be collapsed
    // into anything, and the tab bar already lists the empty group.
    const rows = build({
      panes: [pane('a', A, 'g1')],
      lineage: [row('a')],
      runGroups: [{ id: 'g1', name: 'one' }, { id: 'empty', name: 'two' }],
    })
    expect(rows[0].groups.map((g) => g.id)).toEqual(['g1'])
  })

  it('keeps panes of a group the tab bar does not list', () => {
    // Another workspace's groups, or one deleted while its panes lived on.
    // Losing the rows would lose the panes from the sidebar entirely.
    const rows = build({
      panes: [pane('a', A, 'ghost')],
      lineage: [row('a')],
      runGroups: [],
    })
    expect(rows[0].groups).toHaveLength(1)
    expect(rows[0].groups[0].id).toBe('')
    expect(rows[0].groups[0].rows.map((r) => r.id)).toEqual(['a'])
  })

  it('is one ungrouped section when nobody has made a group', () => {
    // Which is what makes an untouched workspace render exactly as before.
    const rows = build({ panes: [pane('a', A)], lineage: [row('a')] })
    expect(rows[0].groups).toEqual([{ id: '', name: '', rows: [{ id: 'a', depth: 0, hasChildren: false, collapsed: false }] }])
  })

  it('lists the workspaces the window holds, in the order it took them on', () => {
    const rows = build({ here: B, order: [A, B] })
    expect(rows.map((r) => r.path)).toEqual([A, B])
    expect(rows.every((r) => r.isCurrent)).toBe(true)
  })

  it('does not reorder when the viewed workspace changes', () => {
    // The bug this replaced: order derived from what was on screen, so a
    // switch swapped two rows under the cursor.
    const first = build({ here: A, order: [A, B] }).map((r) => r.path)
    const second = build({ here: B, order: [A, B] }).map((r) => r.path)
    expect(second).toEqual(first)
  })

  it('gives each workspace only its own panes', () => {
    const rows = build({
      here: A,
      order: [A, B],
      panes: [pane('a1', A), pane('a2', A), pane('b1', B)],
      lineage: [row('a1'), row('b1'), row('a2')],
    })
    expect(rows.find((r) => r.path === A)?.lineage.map((l) => l.id)).toEqual(['a1', 'a2'])
    expect(rows.find((r) => r.path === A)?.count).toBe(2)
    expect(rows.find((r) => r.path === B)?.lineage.map((l) => l.id)).toEqual(['b1'])
  })

  it('keeps lineage order within a workspace', () => {
    // Filtering must not sort — the order is the rendered tree.
    const rows = build({
      panes: [pane('p1', A), pane('p2', A), pane('p3', A)],
      lineage: [row('p3'), row('p1', 1), row('p2')],
    })
    expect(rows[0].lineage.map((l) => l.id)).toEqual(['p3', 'p1', 'p2'])
    expect(rows[0].lineage[1].depth).toBe(1)
  })

  it('treats a trailing slash as the same workspace', () => {
    const rows = build({ here: `${A}/`, order: [A], panes: [pane('a1', A)], lineage: [row('a1')] })
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(1)
  })

  it('carries the collapsed flag through', () => {
    const rows = build({ here: A, order: [A, B], collapsed: new Set([B]) })
    expect(rows.find((r) => r.path === B)?.collapsed).toBe(true)
    expect(rows.find((r) => r.path === A)?.collapsed).toBe(false)
  })

  it('includes the viewed workspace even before it joins the order list', () => {
    // A watch adds it; this runs on the render before that lands.
    const rows = build({ here: B, order: [] })
    expect(rows.map((r) => r.path)).toEqual([B])
  })

  it('returns nothing when the window has no workspace at all', () => {
    expect(build({ here: '', order: [] })).toEqual([])
  })
})
