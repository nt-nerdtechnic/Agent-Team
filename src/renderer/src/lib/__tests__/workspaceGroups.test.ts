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
    runGroupsByWorkspace: {},
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

  it('groups a held workspace the window is not looking at', () => {
    // Groups are persisted per workspace. Reading only the viewed one's list
    // made every other workspace's panes fall into the ungrouped catch-all, so
    // switching away flattened a project's Run sections in the sidebar.
    const rows = build({
      here: A,
      order: [A, B],
      panes: [pane('b1', B, 'g1'), pane('b2', B, 'g2')],
      lineage: [row('b1'), row('b2')],
      runGroups: [],
      runGroupsByWorkspace: { [B]: [{ id: 'g1', name: 'Run 1' }, { id: 'g2', name: 'Run 2' }] },
    })
    const beta = rows.find((r) => r.path === B)!
    expect(beta.groups.map((g) => [g.id, g.name])).toEqual([
      ['g1', 'Run 1'],
      ['g2', 'Run 2'],
    ])
  })

  it('falls back to one flat section for a held workspace not loaded yet', () => {
    // A peek that has not answered must not lose the panes off the sidebar.
    const rows = build({
      here: A,
      order: [A, B],
      panes: [pane('b1', B, 'g1')],
      lineage: [row('b1')],
      runGroupsByWorkspace: {},
    })
    const beta = rows.find((r) => r.path === B)!
    expect(beta.groups).toHaveLength(1)
    expect(beta.groups[0].id).toBe('')
    expect(beta.groups[0].rows.map((r) => r.id)).toEqual(['b1'])
  })

  it('splits the viewed workspace by the live list, not the stored copy', () => {
    // The tab bar edits runGroups; the store only catches up on save. A rename
    // in flight has to show the new name, not the one last written to disk.
    const rows = build({
      here: A,
      order: [A],
      panes: [pane('a', A, 'g1')],
      lineage: [row('a')],
      runGroups: [{ id: 'g1', name: 'renamed' }],
      runGroupsByWorkspace: { [A]: [{ id: 'g1', name: 'stale' }] },
    })
    expect(rows[0].groups[0].name).toBe('renamed')
  })

  it('matches a stored workspace key that carries a trailing slash', () => {
    const rows = build({
      here: A,
      order: [A, `${B}/`],
      panes: [pane('b1', B, 'g1')],
      lineage: [row('b1')],
      runGroupsByWorkspace: { [B]: [{ id: 'g1', name: 'Run 1' }] },
    })
    const beta = rows.find((r) => r.path === `${B}/`)!
    expect(beta.groups.map((g) => g.name)).toEqual(['Run 1'])
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

  it('lists a workspace no list holds but a pane still names', () => {
    // Detaching a workspace takes it out of the order without taking its panes
    // with it, and a manual resume can start one in a folder this window never
    // adopted. The stage shows those panes either way; without a row of their
    // own they had no heading to sit under — not hidden but missing, and a
    // restore placeholder among them could be opened from nowhere else.
    const rows = build({
      here: A,
      order: [A],
      panes: [pane('a1', A), pane('stray', C)],
      lineage: [row('a1'), row('stray')],
    })
    expect(rows.map((r) => r.path)).toEqual([A, C])
    const orphaned = rows.find((r) => r.path === C)
    expect(orphaned?.lineage.map((l) => l.id)).toEqual(['stray'])
    expect(orphaned?.count).toBe(1)
    expect(orphaned?.label).toBe('gamma')
    // Same shape as any other row — the fallback shares one builder with the
    // held workspaces, so grouping is not a second implementation.
    expect(orphaned?.groups).toEqual([{ id: '', name: '', rows: [row('stray')] }])
  })

  it('splits a fallback row into run groups like any other row', () => {
    // Its own groups, not the viewed workspace's: a row is split by the list
    // belonging to the workspace it names. Reading `runGroups` here would put
    // this project's tab names on another project's panes, and only ever match
    // by coincidence of ids.
    const rows = build({
      here: A,
      order: [A],
      panes: [pane('x', C, 'g1'), pane('y', C)],
      lineage: [row('x'), row('y')],
      runGroups: [{ id: 'g1', name: 'the viewed workspace' }],
      runGroupsByWorkspace: { [C]: [{ id: 'g1', name: 'one' }] },
    })
    const gamma = rows.find((r) => r.path === C)
    expect(gamma?.groups.map((g) => [g.id, g.rows.map((r) => r.id)]))
      .toEqual([['g1', ['x']], ['', ['y']]])
    expect(gamma?.groups[0].name).toBe('one')
  })

  it('does not list a workspace twice for panes it already holds', () => {
    // The fallback runs after both lists, over the same seen set, so a pane in
    // a workspace already on screen adds nothing.
    const rows = build({
      here: A,
      order: [A, B],
      panes: [pane('a1', A), pane('b1', B), pane('b2', `${B}/`)],
      lineage: [row('a1'), row('b1'), row('b2')],
    })
    expect(rows.map((r) => r.path)).toEqual([A, B])
    expect(rows.find((r) => r.path === B)?.lineage.map((l) => l.id)).toEqual(['b1', 'b2'])
  })

  it('lists an unheld workspace once however many panes name it', () => {
    const rows = build({
      here: A,
      order: [A],
      panes: [pane('s1', C), pane('s2', C)],
      lineage: [row('s1'), row('s2')],
    })
    expect(rows.map((r) => r.path)).toEqual([A, C])
    expect(rows[1].count).toBe(2)
  })
})
