import { describe, expect, it } from 'vitest'
import {
  clampUiScale,
  DEFAULT_UI_SCALE,
  formatUiScale,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  stepUiScale,
  UI_SCALE_STEPS
} from './uiScale'

describe('clampUiScale', () => {
  it('keeps an in-range factor', () => {
    expect(clampUiScale(1.25)).toBe(1.25)
  })

  it('clamps beyond the supported range instead of rejecting', () => {
    expect(clampUiScale(9)).toBe(MAX_UI_SCALE)
    expect(clampUiScale(0.1)).toBe(MIN_UI_SCALE)
  })

  it('falls back to 100% for a cleared input rather than clamping to the minimum', () => {
    // The Settings field can be emptied mid-edit; 0-clamped-to-MIN would shrink
    // the whole UI on a keystroke.
    expect(clampUiScale('')).toBe(DEFAULT_UI_SCALE)
    expect(clampUiScale(null)).toBe(DEFAULT_UI_SCALE)
    expect(clampUiScale(undefined)).toBe(DEFAULT_UI_SCALE)
  })

  it('falls back to 100% for values that would break setZoomFactor', () => {
    expect(clampUiScale('abc')).toBe(DEFAULT_UI_SCALE)
    expect(clampUiScale(NaN)).toBe(DEFAULT_UI_SCALE)
    expect(clampUiScale(Infinity)).toBe(DEFAULT_UI_SCALE)
    expect(clampUiScale(0)).toBe(DEFAULT_UI_SCALE)
    expect(clampUiScale(-1.2)).toBe(DEFAULT_UI_SCALE)
  })

  it('accepts a numeric string, as stored settings round-trip through JSON', () => {
    expect(clampUiScale('1.1')).toBe(1.1)
  })

  it('rounds to whole percent so repeated stepping cannot drift', () => {
    expect(clampUiScale(1.23456)).toBe(1.23)
  })
})

describe('stepUiScale', () => {
  it('walks up and down the published ladder', () => {
    expect(stepUiScale(1, 1)).toBe(1.1)
    expect(stepUiScale(1.1, 1)).toBe(1.25)
    expect(stepUiScale(1.25, -1)).toBe(1.1)
    expect(stepUiScale(1, -1)).toBe(0.9)
  })

  it('stops at each end instead of running past the range', () => {
    expect(stepUiScale(MAX_UI_SCALE, 1)).toBe(MAX_UI_SCALE)
    expect(stepUiScale(MIN_UI_SCALE, -1)).toBe(MIN_UI_SCALE)
  })

  it('moves off a value that sits between two steps', () => {
    // A hand-typed 1.05 must still visibly change on the next zoom press.
    expect(stepUiScale(1.05, 1)).toBe(1.1)
    expect(stepUiScale(1.05, -1)).toBe(1)
  })

  it('recovers from a corrupt stored value by stepping from 100%', () => {
    expect(stepUiScale('nonsense', 1)).toBe(1.1)
  })

  it('only produces values that are on the ladder', () => {
    let value = MIN_UI_SCALE
    for (let i = 0; i < UI_SCALE_STEPS.length + 2; i++) {
      value = stepUiScale(value, 1)
      expect(UI_SCALE_STEPS).toContain(value)
    }
  })
})

describe('formatUiScale', () => {
  it('renders a factor as whole percent', () => {
    expect(formatUiScale(1)).toBe('100%')
    expect(formatUiScale(1.25)).toBe('125%')
    expect(formatUiScale(0.8)).toBe('80%')
  })
})

describe('UI_SCALE_STEPS', () => {
  it('stays inside the clamp range, so no offered step is silently rewritten', () => {
    for (const step of UI_SCALE_STEPS) {
      expect(clampUiScale(step)).toBe(step)
    }
  })

  it('is sorted ascending — stepUiScale relies on find()/reverse() order', () => {
    expect([...UI_SCALE_STEPS]).toEqual([...UI_SCALE_STEPS].sort((a, b) => a - b))
  })

  it('includes the default so "reset" lands on a real step', () => {
    expect(UI_SCALE_STEPS).toContain(DEFAULT_UI_SCALE)
  })
})
