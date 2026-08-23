// Slot geometry: the rules that decide how wide a track is and when a stored
// value is safe to trust.
import { describe, it, expect } from 'vitest'
import {
  RAIL_SIZE,
  SLOT_IDS,
  SLOT_LIMITS,
  clampSlotSize,
  createDefaultLayout,
  isSlotEmpty,
  slotAxis,
  slotTrackSize,
} from '../slots'

describe('slot axes', () => {
  it('sizes the side slots by width and the horizontal ones by height', () => {
    expect(slotAxis('left')).toBe('width')
    expect(slotAxis('right')).toBe('width')
    expect(slotAxis('up')).toBe('height')
    expect(slotAxis('down')).toBe('height')
  })
})

describe('clampSlotSize', () => {
  it('holds each slot inside its own range', () => {
    expect(clampSlotSize('left', 10)).toBe(SLOT_LIMITS.left.min)
    expect(clampSlotSize('left', 9999)).toBe(SLOT_LIMITS.left.max)
    expect(clampSlotSize('right', 10)).toBe(SLOT_LIMITS.right.min)
  })

  it('keeps the shipped left/right limits, so a stored width still fits', () => {
    // These are the values the three-column shell dragged between; changing
    // them would move panels on upgrade for anyone sitting at an extreme.
    expect(SLOT_LIMITS.left).toMatchObject({ min: 240, max: 560, initial: 360 })
    expect(SLOT_LIMITS.right).toMatchObject({ min: 180, max: 520, initial: 300 })
  })

  it('rounds, so a track never carries sub-pixel drift from a drag', () => {
    expect(clampSlotSize('left', 360.4)).toBe(360)
  })
})

describe('slotTrackSize', () => {
  const base = createDefaultLayout()

  it('gives an empty slot no space at all', () => {
    expect(isSlotEmpty(base.slots.up)).toBe(true)
    expect(slotTrackSize(base.slots.up)).toBe('0px')
  })

  it('gives a collapsed slot the rail, not zero — it must stay clickable', () => {
    expect(slotTrackSize({ ...base.slots.left, collapsed: true })).toBe(`${RAIL_SIZE}px`)
  })

  it('an expanded slot reports its own size', () => {
    expect(slotTrackSize(base.slots.left)).toBe(`${base.slots.left.size}px`)
  })

  it('empty beats collapsed: nothing to click means nothing to show', () => {
    expect(slotTrackSize({ ...base.slots.up, collapsed: true })).toBe('0px')
  })
})

describe('createDefaultLayout', () => {
  it('reproduces the shipped arrangement', () => {
    const l = createDefaultLayout()
    expect(l.slots.left.views.length).toBeGreaterThan(0)
    expect(l.slots.right.views.length).toBeGreaterThan(0)
    // The right panel has always started collapsed to its rail.
    expect(l.slots.right.collapsed).toBe(true)
    // ...and the two new slots start empty, so the shell looks unchanged.
    expect(l.slots.up.views).toEqual([])
    expect(l.slots.down.views).toEqual([])
  })

  it('covers every slot id', () => {
    const l = createDefaultLayout()
    for (const id of SLOT_IDS) expect(l.slots[id]).toBeDefined()
  })

  it('starts each slot on an active view it actually contains', () => {
    const l = createDefaultLayout()
    for (const id of SLOT_IDS) {
      const slot = l.slots[id]
      if (slot.views.length) expect(slot.views).toContain(slot.active)
      else expect(slot.active).toBeNull()
    }
  })
})
