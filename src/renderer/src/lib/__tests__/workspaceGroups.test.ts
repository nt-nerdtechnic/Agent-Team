import { describe, expect, it } from 'vitest'
import { buildWorkspaceGroups, workspaceParentPath, type LineageRow } from '../workspaceGroups'

// The sidebar's grouping, run for real rather than read as source text. It sat
// inside App.vue, which cannot be mounted in a test (backend and terminal
// lifecycles start on mount), so every assertion about it was a grep over the
// file. These call it.

const HOME = '/Users/me'

const pane = (id: string, ws: string): { id: string; workspacePath: string } => ({
  id,
  workspacePath: ws,
})
const row = (id: string, depth = 0): LineageRow => ({
  id,
  depth,
  hasChildren: false,
  collapsed: false,
})
const remote = (id: string, ws: string, label?: string): {
  pane_id: string
  workspace_path: string
  workspace_label?: string
  busy: boolean
} => ({ pane_id: id, workspace_path: ws, ...(label ? { workspace_label: label } : {}), busy: false })

const A = '/Users/me/Desktop/alpha'
const B = '/Users/me/Desktop/beta'
const C = '/Users/me/Git/gamma'

function build(over: Partial<Parameters<typeof buildWorkspaceGroups>[0]> = {}) {
  return buildWorkspaceGroups({
    here: A,
    order: [A],
    panes: [],
    lineage: [],
    roster: [],
    openPaths: [],
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

  it('adds another window\'s workspace as a read-only row', () => {
    const rows = build({ roster: [remote('r1', C, 'gamma'), remote('r2', C)] })
    const other = rows.find((r) => r.path === C)
    expect(other?.isCurrent).toBe(false)
    expect(other?.count).toBe(2)
    expect(other?.lineage).toEqual([])
    expect(other?.label).toBe('gamma')
  })

  it('names another workspace from the first entry that carries a label', () => {
    // They all name the same workspace, but a registration made before the
    // label was known omits it — taking entries[0] blindly showed the folder
    // basename or the real name depending on arrival order.
    const rows = build({ roster: [remote('r1', C), remote('r2', C, 'gamma')] })
    expect(rows.find((r) => r.path === C)?.label).toBe('gamma')
  })

  it('falls back to the folder name when no entry has a label', () => {
    const rows = build({ roster: [remote('r1', C)] })
    expect(rows.find((r) => r.path === C)?.label).toBe('gamma')
  })

  it('never lists a workspace this window holds as another window\'s', () => {
    // The roster does not distinguish this window from any other.
    const rows = build({
      here: A,
      order: [A],
      panes: [pane('a1', A)],
      lineage: [row('a1')],
      roster: [remote('a1', A), remote('other', A)],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].isCurrent).toBe(true)
  })

  it('drops a roster entry for a pane this window already renders', () => {
    const rows = build({
      here: A,
      order: [A],
      panes: [pane('shared', A)],
      lineage: [row('shared')],
      roster: [remote('shared', C)],
    })
    // 'shared' is ours, so C contributes nothing and gets no row.
    expect(rows.map((r) => r.path)).toEqual([A])
  })

  it('lists a workspace that is open with no CLI started', () => {
    const rows = build({ openPaths: [C] })
    const idle = rows.find((r) => r.path === C)
    expect(idle?.count).toBe(0)
    expect(idle?.isCurrent).toBe(false)
  })

  it('does not list an open workspace twice', () => {
    const rows = build({ here: A, order: [A], openPaths: [A, `${A}/`, C], roster: [remote('r', C)] })
    expect(rows.map((r) => r.path)).toEqual([A, C])
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
