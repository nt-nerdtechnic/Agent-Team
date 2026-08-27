import { describe, expect, it } from 'vitest'
import { buildPaneLineage, type LineagePane } from '../paneLineage'

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
