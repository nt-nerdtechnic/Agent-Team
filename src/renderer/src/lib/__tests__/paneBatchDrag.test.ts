import { describe, it, expect } from 'vitest'
import { resolveDragBatch, reorderBatchByIds } from '../paneBatchDrag'
import { reorderByIds } from '../paneOrder'

const panes = (): { id: string }[] => [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
const ids = (items: { id: string }[]): string[] => items.map((it) => it.id)
const order = ['a', 'b', 'c', 'd']

describe('resolveDragBatch', () => {
  it('carries only the dragged pane when nothing is multi-selected', () => {
    expect(resolveDragBatch('b', new Set(), order)).toEqual(['b'])
    expect(resolveDragBatch('b', undefined, order)).toEqual(['b'])
  })

  it('carries only the dragged pane when the selection holds a single pane', () => {
    expect(resolveDragBatch('b', new Set(['b']), order)).toEqual(['b'])
  })

  it('carries only the dragged pane when it sits outside the selection', () => {
    expect(resolveDragBatch('d', new Set(['a', 'b']), order)).toEqual(['d'])
  })

  it('carries the whole selection when the dragged pane belongs to it', () => {
    expect(resolveDragBatch('c', new Set(['a', 'c']), order)).toEqual(['a', 'c'])
  })

  it('returns the batch in pane order, not selection insertion order', () => {
    const selected = new Set(['d', 'a', 'c'])
    expect(resolveDragBatch('d', selected, order)).toEqual(['a', 'c', 'd'])
  })

  it('keeps the dragged pane even when the order list omits it', () => {
    // A surface that does not render the dragged pane (minimized, other tab)
    // must never silently drop it from its own drag.
    expect(resolveDragBatch('d', new Set(['a', 'd']), ['a', 'b', 'c'])).toEqual(['a', 'd'])
  })

  it('ignores selected panes the order list does not contain', () => {
    expect(resolveDragBatch('a', new Set(['a', 'ghost']), order)).toEqual(['a'])
  })

  it('returns nothing for an empty dragged id', () => {
    expect(resolveDragBatch('', new Set(['a', 'b']), order)).toEqual([])
  })
})

describe('reorderBatchByIds', () => {
  it('matches reorderByIds exactly for a single mover in both directions', () => {
    for (const [from, to] of [['a', 'c'], ['d', 'b'], ['a', 'b'], ['b', 'a']] as const) {
      const batch = panes()
      const single = panes()
      expect(reorderBatchByIds(batch, [from], to)).toBe(reorderByIds(single, from, to))
      expect(ids(batch)).toEqual(ids(single))
    }
  })

  it('moves a contiguous batch forward, landing it after the target', () => {
    const items = panes()
    expect(reorderBatchByIds(items, ['a', 'b'], 'c')).toBe(true)
    expect(ids(items)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('lands a batch after the last item when dropped on it', () => {
    const items = panes()
    expect(reorderBatchByIds(items, ['a', 'b'], 'd')).toBe(true)
    expect(ids(items)).toEqual(['c', 'd', 'a', 'b'])
  })

  it('moves a batch backward, landing it before the target', () => {
    const items = panes()
    expect(reorderBatchByIds(items, ['c', 'd'], 'b')).toBe(true)
    expect(ids(items)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('keeps the movers relative order for a non-contiguous batch', () => {
    // The batch straddles the target (a above, e below), so it lands above —
    // same side a single backward drag would land on.
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]
    expect(reorderBatchByIds(items, ['e', 'a'], 'c')).toBe(true)
    expect(ids(items)).toEqual(['b', 'a', 'e', 'c', 'd'])
  })

  it('is a no-op when the target is part of the batch', () => {
    const items = panes()
    expect(reorderBatchByIds(items, ['a', 'b'], 'b')).toBe(false)
    expect(ids(items)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is a no-op when the target does not exist', () => {
    const items = panes()
    expect(reorderBatchByIds(items, ['a'], 'ghost')).toBe(false)
    expect(ids(items)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is a no-op for an empty batch', () => {
    const items = panes()
    expect(reorderBatchByIds(items, [], 'b')).toBe(false)
    expect(ids(items)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('skips unknown movers but still moves the known ones', () => {
    const items = panes()
    expect(reorderBatchByIds(items, ['ghost', 'a'], 'c')).toBe(true)
    expect(ids(items)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('is a no-op when every mover is unknown', () => {
    const items = panes()
    expect(reorderBatchByIds(items, ['ghost', 'phantom'], 'c')).toBe(false)
    expect(ids(items)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('preserves object identity (splice, not copies)', () => {
    const items = panes()
    const a = items[0]
    const b = items[1]
    reorderBatchByIds(items, ['a', 'b'], 'd')
    expect(items).toContain(a)
    expect(items).toContain(b)
  })

  it('handles a batch that spans the whole list without losing items', () => {
    const items = panes()
    expect(reorderBatchByIds(items, ['a', 'b', 'c', 'd'], 'c')).toBe(false)
    expect(ids(items)).toEqual(['a', 'b', 'c', 'd'])
  })
})
