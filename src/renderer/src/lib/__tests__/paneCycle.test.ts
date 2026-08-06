import { describe, it, expect } from 'vitest'
import { nextPaneId, planPaneCycle } from '../paneCycle'

const order = ['a', 'b', 'c', 'd']

describe('nextPaneId', () => {
  it('walks forward', () => {
    expect(nextPaneId(order, 'a', 1)).toBe('b')
    expect(nextPaneId(order, 'c', 1)).toBe('d')
  })

  it('walks backward', () => {
    expect(nextPaneId(order, 'd', -1)).toBe('c')
    expect(nextPaneId(order, 'b', -1)).toBe('a')
  })

  it('wraps around at both ends', () => {
    expect(nextPaneId(order, 'd', 1)).toBe('a')
    expect(nextPaneId(order, 'a', -1)).toBe('d')
  })

  it('starts from the leading edge when nothing is focused', () => {
    expect(nextPaneId(order, null, 1)).toBe('a')
    expect(nextPaneId(order, null, -1)).toBe('d')
  })

  it('starts from the leading edge when the current pane is not in the list', () => {
    expect(nextPaneId(order, 'gone', 1)).toBe('a')
    expect(nextPaneId(order, 'gone', -1)).toBe('d')
  })

  it('returns null for an empty list', () => {
    expect(nextPaneId([], 'a', 1)).toBeNull()
    expect(nextPaneId([], null, -1)).toBeNull()
  })

  it('stays put with a single pane', () => {
    expect(nextPaneId(['only'], 'only', 1)).toBe('only')
    expect(nextPaneId(['only'], 'only', -1)).toBe('only')
  })
})

describe('planPaneCycle', () => {
  const base = { orderedIds: order, currentId: 'a', direction: 1 as const, gridDims: null, currentPage: 0 }

  it('targets the next pane and asks for no page change without a fixed grid', () => {
    expect(planPaneCycle(base)).toEqual({ targetId: 'b', page: null })
  })

  it('is a no-op when the cycle lands back on the current pane', () => {
    expect(planPaneCycle({ ...base, orderedIds: ['only'], currentId: 'only' })).toBeNull()
  })

  it('is a no-op when there are no panes', () => {
    expect(planPaneCycle({ ...base, orderedIds: [], currentId: null })).toBeNull()
  })

  it('stays on the page when the target is already visible', () => {
    // 2x2 grid: a,b,c,d on page 0..1 — a→b are both on page 0.
    expect(planPaneCycle({ ...base, gridDims: { cols: 2, rows: 2 } })).toEqual({
      targetId: 'b',
      page: null,
    })
  })

  it('turns the page when the target sits on the next one', () => {
    // 2x2 grid over 5 panes: e is index 4 → page 1.
    expect(
      planPaneCycle({
        orderedIds: ['a', 'b', 'c', 'd', 'e'],
        currentId: 'd',
        direction: 1,
        gridDims: { cols: 2, rows: 2 },
        currentPage: 0,
      }),
    ).toEqual({ targetId: 'e', page: 1 })
  })

  it('turns back when wrapping from the last page to the first', () => {
    expect(
      planPaneCycle({
        orderedIds: ['a', 'b', 'c', 'd', 'e'],
        currentId: 'e',
        direction: 1,
        gridDims: { cols: 2, rows: 2 },
        currentPage: 1,
      }),
    ).toEqual({ targetId: 'a', page: 0 })
  })

  it('turns the page walking backward past the page boundary', () => {
    expect(
      planPaneCycle({
        orderedIds: ['a', 'b', 'c', 'd', 'e'],
        currentId: 'e',
        direction: -1,
        gridDims: { cols: 2, rows: 2 },
        currentPage: 1,
      }),
    ).toEqual({ targetId: 'd', page: 0 })
  })

  it('handles a 1x1 grid where every pane is its own page', () => {
    expect(
      planPaneCycle({
        orderedIds: order,
        currentId: 'c',
        direction: 1,
        gridDims: { cols: 1, rows: 1 },
        currentPage: 2,
      }),
    ).toEqual({ targetId: 'd', page: 3 })
  })

  it('never asks for a page change in non-grid layouts', () => {
    // gridDims is null for sidebar/spotlight/fullscreen — the stage follows
    // focusPaneId alone, so a page hop would be meaningless.
    expect(
      planPaneCycle({
        orderedIds: ['a', 'b', 'c', 'd', 'e'],
        currentId: 'd',
        direction: 1,
        gridDims: null,
        currentPage: 0,
      }),
    ).toEqual({ targetId: 'e', page: null })
  })
})
