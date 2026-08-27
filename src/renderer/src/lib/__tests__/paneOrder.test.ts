import { describe, it, expect } from 'vitest'
import { reorderStrings, reorderByIds, sortByIdOrder } from '../paneOrder'

const panes = (): { id: string }[] => [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

const ids = (items: { id: string }[]): string[] => items.map((it) => it.id)

describe('reorderStrings', () => {
  it('moves an item onto another position', () => {
    const list = ['a', 'b', 'c']
    expect(reorderStrings(list, 'c', 'a')).toBe(true)
    expect(list).toEqual(['c', 'a', 'b'])
  })

  it('reports no move when dropped on itself', () => {
    // The caller skips persisting on false — a drop on the row you picked up
    // should not write the same order back.
    const list = ['a', 'b']
    expect(reorderStrings(list, 'a', 'a')).toBe(false)
    expect(list).toEqual(['a', 'b'])
  })

  it('reports no move when either item is unknown', () => {
    const list = ['a', 'b']
    expect(reorderStrings(list, 'a', 'zz')).toBe(false)
    expect(reorderStrings(list, 'zz', 'a')).toBe(false)
    expect(list).toEqual(['a', 'b'])
  })

  it('moves later items backwards, not just forwards', () => {
    const list = ['a', 'b', 'c', 'd']
    expect(reorderStrings(list, 'a', 'd')).toBe(true)
    expect(list).toEqual(['b', 'c', 'd', 'a'])
  })
})

describe('reorderByIds', () => {
  it('moves an earlier item onto a later target (dragged item takes the target index)', () => {
    const items = panes()
    expect(reorderByIds(items, 'a', 'c')).toBe(true)
    expect(ids(items)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves a later item onto an earlier target', () => {
    const items = panes()
    expect(reorderByIds(items, 'd', 'b')).toBe(true)
    expect(ids(items)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('swaps adjacent items in both directions', () => {
    const forward = panes()
    reorderByIds(forward, 'a', 'b')
    expect(ids(forward)).toEqual(['b', 'a', 'c', 'd'])

    const backward = panes()
    reorderByIds(backward, 'b', 'a')
    expect(ids(backward)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('is a no-op when fromId === toId', () => {
    const items = panes()
    expect(reorderByIds(items, 'b', 'b')).toBe(false)
    expect(ids(items)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is a no-op when fromId does not exist', () => {
    const items = panes()
    expect(reorderByIds(items, 'nope', 'b')).toBe(false)
    expect(ids(items)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is a no-op when toId does not exist', () => {
    const items = panes()
    expect(reorderByIds(items, 'b', 'nope')).toBe(false)
    expect(ids(items)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is a no-op on an empty array', () => {
    const items: { id: string }[] = []
    expect(reorderByIds(items, 'a', 'b')).toBe(false)
    expect(items).toEqual([])
  })

  it('preserves the moved object identity (splice, not copy)', () => {
    const items = panes()
    const moved = items[0]
    reorderByIds(items, 'a', 'd')
    expect(items[3]).toBe(moved)
  })
})

describe('sortByIdOrder', () => {
  it('re-sorts items to match the id order', () => {
    const items = panes()
    expect(sortByIdOrder(items, ['c', 'a', 'd', 'b'])).toBe(true)
    expect(ids(items)).toEqual(['c', 'a', 'd', 'b'])
  })

  it('permutes only listed items — unlisted ones keep their slots', () => {
    const items = panes()
    expect(sortByIdOrder(items, ['c', 'a'])).toBe(true)
    // a (index 0) and c (index 2) swap within their slots; b and d stay put.
    expect(ids(items)).toEqual(['c', 'b', 'a', 'd'])
  })

  it('ignores ids with no matching item', () => {
    const items = panes()
    expect(sortByIdOrder(items, ['ghost', 'b', 'a'])).toBe(true)
    expect(ids(items)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('returns false when the items are already in order', () => {
    const items = panes()
    expect(sortByIdOrder(items, ['a', 'b', 'c', 'd'])).toBe(false)
    expect(ids(items)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is a no-op for an empty id order or empty items', () => {
    const items = panes()
    expect(sortByIdOrder(items, [])).toBe(false)
    expect(ids(items)).toEqual(['a', 'b', 'c', 'd'])

    const empty: { id: string }[] = []
    expect(sortByIdOrder(empty, ['a'])).toBe(false)
    expect(empty).toEqual([])
  })

  it('preserves object identity (splice replacement, not copies)', () => {
    const items = panes()
    const a = items[0]
    sortByIdOrder(items, ['d', 'c', 'b', 'a'])
    expect(items[3]).toBe(a)
  })
})
