import { describe, expect, it } from 'vitest'
import { computeRangeSelection } from '../paneSelection'

// Behavior coverage for Shift-click range selection. App.vue resolves the
// anchor as lastClickPaneId ?? focusPaneId and passes the clicked surface's
// render order, so these cases exercise exactly what rangeSelectPanes runs.

const order = ['a', 'b', 'c', 'd', 'e']

describe('computeRangeSelection', () => {
  it('selects the inclusive range from anchor to target', () => {
    expect(computeRangeSelection(order, 'b', 'd')).toEqual(new Set(['b', 'c', 'd']))
  })

  it('selects the same inclusive range when the anchor is after the target', () => {
    expect(computeRangeSelection(order, 'd', 'b')).toEqual(new Set(['b', 'c', 'd']))
  })

  it('selects only the target when anchor === target', () => {
    expect(computeRangeSelection(order, 'c', 'c')).toEqual(new Set(['c']))
  })

  it('falls back to the target when the anchor is not in the surface order', () => {
    // e.g. the anchor pane is minimized or on another grid page/tab.
    expect(computeRangeSelection(order, 'zz', 'c')).toEqual(new Set(['c']))
  })

  it('falls back to the target when there is no anchor at all', () => {
    // Caller resolves lastClickPaneId ?? focusPaneId; null means neither exists.
    expect(computeRangeSelection(order, null, 'c')).toEqual(new Set(['c']))
  })

  it('supports the focus-pane fallback anchor like any other anchor', () => {
    // First shift-click of a session: caller passes focusPaneId as the anchor.
    expect(computeRangeSelection(order, 'a', 'c')).toEqual(new Set(['a', 'b', 'c']))
  })

  it('selects only the target when the target itself is not in the order', () => {
    expect(computeRangeSelection(order, 'b', 'zz')).toEqual(new Set(['zz']))
  })
})
