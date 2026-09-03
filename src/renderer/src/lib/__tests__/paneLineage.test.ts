import { describe, expect, it } from 'vitest'
import { buildPaneLineage, resolveSiblingDrop, withDescendants, type LineagePane } from '../paneLineage'
import { reorderBatchByIds } from '../paneBatchDrag'

// The spawn tree flattened into render order. It lived in App.vue, which
// cannot be mounted in a test, so its three interesting cases — a missing
// parent, a collapsed subtree, a cycle — could only be asserted as source
// text. These run it.

const p = (id: string, spawnedBy?: string): LineagePane => ({ id, ...(spawnedBy ? { spawnedBy } : {}) })
const none = new Set<string>()
const shape = (rows: ReturnType<typeof buildPaneLineage>) =>
  rows.map((r) => `${'  '.repeat(r.depth)}${r.id}`)

describe('buildPaneLineage', () => {
  it('keeps flat panes in their given order', () => {
    expect(shape(buildPaneLineage([p('a'), p('b'), p('c')], none))).toEqual(['a', 'b', 'c'])
  })

  it('puts each child under its parent, depth-first', () => {
    const panes = [p('a'), p('b'), p('a1', 'a'), p('a2', 'a'), p('a1x', 'a1')]
    expect(shape(buildPaneLineage(panes, none))).toEqual([
      'a',
      '  a1',
      '    a1x',
      '  a2',
      'b',
    ])
  })

  it('marks a pane that has children', () => {
    const rows = buildPaneLineage([p('a'), p('a1', 'a')], none)
    expect(rows.find((r) => r.id === 'a')?.hasChildren).toBe(true)
    expect(rows.find((r) => r.id === 'a1')?.hasChildren).toBe(false)
  })

  it('makes a child whose parent is gone a root', () => {
    // Closed in another window, or a record predating lineage persistence.
    // Hiding it with the parent would lose a live pane from the list.
    const rows = buildPaneLineage([p('a'), p('orphan', 'vanished')], none)
    expect(shape(rows)).toEqual(['a', 'orphan'])
    expect(rows.find((r) => r.id === 'orphan')?.depth).toBe(0)
  })

  it('treats a pane parented to itself as a root', () => {
    expect(shape(buildPaneLineage([p('self', 'self')], none))).toEqual(['self'])
  })

  it('leaves a collapsed pane\'s descendants out entirely', () => {
    // This is what makes range selection over the list collapse-aware without
    // knowing anything about collapsing.
    const panes = [p('a'), p('a1', 'a'), p('a1x', 'a1'), p('b')]
    const rows = buildPaneLineage(panes, new Set(['a']))
    expect(shape(rows)).toEqual(['a', 'b'])
    expect(rows.find((r) => r.id === 'a')?.collapsed).toBe(true)
    // Still reported as having children — the caret has to render.
    expect(rows.find((r) => r.id === 'a')?.hasChildren).toBe(true)
  })

  it('collapses one level without hiding a sibling subtree', () => {
    const panes = [p('a'), p('a1', 'a'), p('a1x', 'a1'), p('a2', 'a'), p('a2x', 'a2')]
    expect(shape(buildPaneLineage(panes, new Set(['a1'])))).toEqual([
      'a',
      '  a1',
      '  a2',
      '    a2x',
    ])
  })

  it('lists panes caught in a cycle rather than dropping them', () => {
    // The backend guards against this, but hand-edited state and older records
    // exist. The walk cannot reach them; being absent from the sidebar while
    // running is worse than being listed at the wrong depth.
    const panes = [p('a'), p('x', 'y'), p('y', 'x')]
    const rows = buildPaneLineage(panes, none)
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'x', 'y'])
    for (const id of ['x', 'y']) {
      expect(rows.find((r) => r.id === id)?.depth, id).toBe(0)
    }
  })

  it('lists every pane exactly once', () => {
    const panes = [p('a'), p('a1', 'a'), p('b'), p('b1', 'b'), p('orphan', 'gone'), p('x', 'y'), p('y', 'x')]
    const rows = buildPaneLineage(panes, none)
    expect(rows).toHaveLength(panes.length)
    expect(new Set(rows.map((r) => r.id)).size).toBe(panes.length)
  })

  it('returns nothing for no panes', () => {
    expect(buildPaneLineage([], none)).toEqual([])
  })
})

// --- Drag reorder over a tree -------------------------------------------
//
// Pane order lives in one flat array; the sidebar renders that array as a
// tree. Dropping used to be resolved against the flat array alone, so a drop
// onto a row that happens to be someone's child inserted the dragged pane
// between that child and its parent — where the tree walk then put it back
// somewhere else entirely, and the pane appeared not to have moved.
//
// These two helpers close that gap: a drag carries the dragged pane's whole
// subtree, and a drop only resolves when it lands among the dragged pane's
// own siblings.

describe('withDescendants', () => {
  it('carries a pane on its own when it has no children', () => {
    const panes = [p('a'), p('b')]
    expect(withDescendants(['a'], panes)).toEqual(['a'])
  })

  it('carries the whole subtree, deepest levels included', () => {
    const panes = [p('a'), p('a1', 'a'), p('a1x', 'a1'), p('b')]
    expect(withDescendants(['a'], panes)).toEqual(['a', 'a1', 'a1x'])
  })

  it('returns the batch in pane order, not the order asked for', () => {
    // The batch keeps its relative arrangement wherever it lands, so the
    // caller's argument order must not leak into the result.
    const panes = [p('a'), p('b'), p('c')]
    expect(withDescendants(['c', 'a'], panes)).toEqual(['a', 'c'])
  })

  it('lists a pane once when it is both asked for and a descendant', () => {
    const panes = [p('a'), p('a1', 'a')]
    expect(withDescendants(['a', 'a1'], panes)).toEqual(['a', 'a1'])
  })

  it('ignores ids that are not panes', () => {
    expect(withDescendants(['ghost'], [p('a')])).toEqual([])
  })
})

describe('resolveSiblingDrop', () => {
  const tree = [p('r1'), p('c1', 'r1'), p('c1x', 'c1'), p('c2', 'r1'), p('r2')]

  it('accepts a drop between two roots', () => {
    expect(resolveSiblingDrop('r2', 'r1', tree)).toBe('r1')
  })

  it('accepts a drop between two children of the same parent', () => {
    expect(resolveSiblingDrop('c2', 'c1', tree)).toBe('c1')
  })

  it('lifts a drop onto someone else\'s child up to that subtree\'s root', () => {
    // Dragging a root onto a nested row means "put me where that group is",
    // not "put me inside it" — reordering never re-parents a pane.
    expect(resolveSiblingDrop('r2', 'c1x', tree)).toBe('r1')
  })

  it('refuses a drop into the dragged pane\'s own subtree', () => {
    expect(resolveSiblingDrop('r1', 'c1x', tree)).toBeNull()
  })

  it('refuses a drop onto another parent\'s child', () => {
    // c1 can only be ordered among r1's children; r2 is not one of them.
    expect(resolveSiblingDrop('c1', 'r2', tree)).toBeNull()
  })

  it('refuses a no-op drop onto itself', () => {
    expect(resolveSiblingDrop('r1', 'r1', tree)).toBeNull()
  })

  it('refuses ids that are not panes', () => {
    expect(resolveSiblingDrop('ghost', 'r1', tree)).toBeNull()
    expect(resolveSiblingDrop('r1', 'ghost', tree)).toBeNull()
  })

  it('survives a cycle instead of looping forever', () => {
    const cyclic = [p('a'), p('x', 'y'), p('y', 'x')]
    expect(resolveSiblingDrop('a', 'x', cyclic)).toBe('x')
  })
})

describe('a drag that moves a subtree', () => {
  // The regression this phase exists for, asserted on what the sidebar
  // actually renders rather than on the flat array.
  const render = (panes: LineagePane[]) => shape(buildPaneLineage(panes, none))

  it('moves a parent and its children together', () => {
    const panes = [p('r1'), p('c1', 'r1'), p('r2')]
    const to = resolveSiblingDrop('r2', 'r1', panes)
    expect(to).toBe('r1')
    reorderBatchByIds(panes, withDescendants(['r2'], panes), to!)
    expect(render(panes)).toEqual(['r2', 'r1', '  c1'])
  })

  it('lands next to the group when dropped on a row inside it', () => {
    // Before: this dropped r2 between r1 and c1 in the flat array, the walk
    // pulled c1 back under r1, and r2 appeared not to have moved at all.
    const panes = [p('r1'), p('c1', 'r1'), p('r2')]
    const to = resolveSiblingDrop('r2', 'c1', panes)
    expect(to).toBe('r1')
    reorderBatchByIds(panes, withDescendants(['r2'], panes), to!)
    expect(render(panes)).toEqual(['r2', 'r1', '  c1'])
  })

  it('keeps a dragged subtree contiguous', () => {
    const panes = [p('r1'), p('c1', 'r1'), p('c1x', 'c1'), p('r2')]
    const to = resolveSiblingDrop('r1', 'r2', panes)
    expect(to).toBe('r2')
    reorderBatchByIds(panes, withDescendants(['r1'], panes), to!)
    expect(render(panes)).toEqual(['r2', 'r1', '  c1', '    c1x'])
  })

  it('reorders siblings without touching the rest of the tree', () => {
    const panes = [p('r1'), p('c1', 'r1'), p('c2', 'r1'), p('r2')]
    const to = resolveSiblingDrop('c2', 'c1', panes)
    reorderBatchByIds(panes, withDescendants(['c2'], panes), to!)
    expect(render(panes)).toEqual(['r1', '  c2', '  c1', 'r2'])
  })
})

// --- Ancestry and group size --------------------------------------------
//
// Two facts the flat list cannot state on its own. Both are pure structure —
// ids and spawn pointers only, never a pane's live status or name — so they
// belong on the row rather than being recomputed at render time, where the
// 400ms status sync would rebuild the whole tree for them.

describe('lineage rows carry ancestry', () => {
  const rowFor = (rows: ReturnType<typeof buildPaneLineage>, id: string) =>
    rows.find((r) => r.id === id)

  it('gives a root no ancestors', () => {
    const rows = buildPaneLineage([p('a')], none)
    expect(rowFor(rows, 'a')?.ancestors).toEqual([])
  })

  it('names the parent of a second-level pane', () => {
    const rows = buildPaneLineage([p('a'), p('a1', 'a')], none)
    expect(rowFor(rows, 'a1')?.ancestors).toEqual(['a'])
  })

  it('names the whole chain, outermost first', () => {
    // The label reads "↳ a › a1", so the order has to be root-to-parent.
    const rows = buildPaneLineage([p('a'), p('a1', 'a'), p('a1x', 'a1')], none)
    expect(rowFor(rows, 'a1x')?.ancestors).toEqual(['a', 'a1'])
  })

  it('gives an orphan no ancestors, matching where it is drawn', () => {
    const rows = buildPaneLineage([p('a'), p('orphan', 'vanished')], none)
    expect(rowFor(rows, 'orphan')?.ancestors).toEqual([])
  })

  it('gives a pane in a cycle no ancestors, matching where it is drawn', () => {
    // The walk draws these as roots; claiming an ancestor chain here would
    // make the label disagree with the indentation.
    const rows = buildPaneLineage([p('a'), p('x', 'y'), p('y', 'x')], none)
    expect(rowFor(rows, 'x')?.ancestors).toEqual([])
    expect(rowFor(rows, 'x')?.depth).toBe(0)
  })
})

describe('lineage rows carry a descendant count', () => {
  const countOf = (panes: LineagePane[], id: string, collapsed = none) =>
    buildPaneLineage(panes, collapsed).find((r) => r.id === id)?.descendantCount

  it('counts nothing for a childless pane', () => {
    expect(countOf([p('a')], 'a')).toBe(0)
  })

  it('counts grandchildren, not just direct children', () => {
    // "3 個子代" answers how big the group is, not how deep it goes.
    const panes = [p('a'), p('a1', 'a'), p('a2', 'a'), p('a1x', 'a1')]
    expect(countOf(panes, 'a')).toBe(3)
    expect(countOf(panes, 'a1')).toBe(1)
    expect(countOf(panes, 'a2')).toBe(0)
  })

  it('still counts the children of a collapsed pane', () => {
    // The count is what a folded row shows instead of its children, so it
    // must not depend on whether they are currently drawn.
    const panes = [p('a'), p('a1', 'a'), p('a1x', 'a1')]
    const rows = buildPaneLineage(panes, new Set(['a']))
    expect(rows.map((r) => r.id)).toEqual(['a'])
    expect(rows[0].descendantCount).toBe(2)
  })

  it('does not count a pane caught in a cycle as its own descendant', () => {
    const rows = buildPaneLineage([p('a'), p('x', 'y'), p('y', 'x')], none)
    for (const row of rows) expect(row.descendantCount, row.id).toBe(0)
  })
})
