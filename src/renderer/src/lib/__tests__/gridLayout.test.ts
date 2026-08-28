import { describe, expect, it } from 'vitest'
import {
  gridPageCount,
  gridPageOf,
  gridPageSlice,
  gridPresetDims,
  parseGridPreset,
} from '../gridLayout'

describe('parseGridPreset', () => {
  it('accepts any CxR preset with cols/rows 1-9', () => {
    expect(parseGridPreset('2x1')).toBe('2x1')
    expect(parseGridPreset('2x2')).toBe('2x2')
    expect(parseGridPreset('3x3')).toBe('3x3')
    expect(parseGridPreset('4x2')).toBe('4x2')
    expect(parseGridPreset('9x9')).toBe('9x9')
  })

  it('falls back to auto for anything else', () => {
    expect(parseGridPreset('auto')).toBe('auto')
    expect(parseGridPreset('0x2')).toBe('auto')
    expect(parseGridPreset('10x2')).toBe('auto')
    expect(parseGridPreset('2x')).toBe('auto')
    expect(parseGridPreset('')).toBe('auto')
    expect(parseGridPreset(null)).toBe('auto')
    expect(parseGridPreset(undefined)).toBe('auto')
  })
})

describe('gridPresetDims', () => {
  it('returns null for auto and parsed dims otherwise', () => {
    expect(gridPresetDims('auto')).toBeNull()
    expect(gridPresetDims('2x1')).toEqual({ cols: 2, rows: 1 })
    expect(gridPresetDims('3x3')).toEqual({ cols: 3, rows: 3 })
    expect(gridPresetDims('4x2')).toEqual({ cols: 4, rows: 2 })
  })
})

describe('gridPageCount', () => {
  it('is always 1 for auto (unlimited panes on one page)', () => {
    expect(gridPageCount(0, 'auto')).toBe(1)
    expect(gridPageCount(12, 'auto')).toBe(1)
  })

  it('divides panes by page capacity, rounding up', () => {
    expect(gridPageCount(4, '2x2')).toBe(1)
    expect(gridPageCount(5, '2x2')).toBe(2)
    expect(gridPageCount(7, '2x1')).toBe(4)
    expect(gridPageCount(9, '3x3')).toBe(1)
    expect(gridPageCount(10, '3x3')).toBe(2)
  })

  it('never returns less than 1', () => {
    expect(gridPageCount(0, '2x2')).toBe(1)
  })
})

describe('gridPageOf', () => {
  it('is page 0 for auto, which pages nothing', () => {
    expect(gridPageOf(0, 'auto')).toBe(0)
    expect(gridPageOf(11, 'auto')).toBe(0)
  })

  it('divides the index by page capacity', () => {
    expect(gridPageOf(0, '2x2')).toBe(0)
    expect(gridPageOf(3, '2x2')).toBe(0)
    expect(gridPageOf(4, '2x2')).toBe(1)
    expect(gridPageOf(7, '2x2')).toBe(1)
    expect(gridPageOf(8, '2x2')).toBe(2)
    expect(gridPageOf(5, '2x1')).toBe(2)
  })

  it('turns the page exactly at the capacity boundary', () => {
    // A full page keeps its last index; the next one opens the next page.
    expect(gridPageOf(8, '3x3')).toBe(0)
    expect(gridPageOf(9, '3x3')).toBe(1)
    expect(gridPageOf(17, '3x3')).toBe(1)
    expect(gridPageOf(18, '3x3')).toBe(2)
  })

  it('is page 0 for an index the list does not hold', () => {
    // findIndex answers -1 for a pane that is not on the paged list; page 0 is
    // the harmless answer, and the caller skips the jump on that -1 anyway.
    expect(gridPageOf(-1, '2x2')).toBe(0)
    expect(gridPageOf(-1, 'auto')).toBe(0)
  })

  it('agrees with gridPageSlice about where a pane lands', () => {
    // The pairing that matters: jumping to gridPageOf's page has to be the
    // page the stage then draws the pane on.
    const panes = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    for (const preset of ['2x2', '2x1', '3x1', 'auto']) {
      panes.forEach((p, i) => {
        expect(gridPageSlice(panes, preset, gridPageOf(i, preset)), `${preset}#${i}`).toContain(p)
      })
    }
  })
})

describe('gridPageSlice', () => {
  const panes = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

  it('returns all panes for auto regardless of page', () => {
    expect(gridPageSlice(panes, 'auto', 0)).toEqual(panes)
    expect(gridPageSlice(panes, 'auto', 3)).toEqual(panes)
  })

  it('slices fixed presets into capacity-sized pages', () => {
    expect(gridPageSlice(panes, '2x2', 0)).toEqual(['a', 'b', 'c', 'd'])
    expect(gridPageSlice(panes, '2x2', 1)).toEqual(['e', 'f', 'g'])
    expect(gridPageSlice(panes, '2x1', 2)).toEqual(['e', 'f'])
  })

  it('clamps out-of-range pages instead of returning empty', () => {
    expect(gridPageSlice(panes, '2x2', 5)).toEqual(['e', 'f', 'g'])
    expect(gridPageSlice(panes, '2x2', -1)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('handles an empty pane list', () => {
    expect(gridPageSlice([], '3x3', 0)).toEqual([])
  })
})
