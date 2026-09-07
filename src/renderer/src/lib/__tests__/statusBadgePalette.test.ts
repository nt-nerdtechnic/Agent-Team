// @vitest-environment node
import { describe, expect, it } from 'vitest'

import type { PaneStatusValue } from '../paneStatusLabel'
import {
  DEFAULT_STATUS_COLORS,
  isPaneStatusValue,
  isStatusColorKey,
  PANE_STATUS_ORDER,
  STATUS_COLOR_KEYS,
  STATUS_COLOR_PALETTE,
} from '../statusBadgePalette'

// The palette is a lookup table, so what can go wrong with it is a table's
// failure modes: a status with no default, a colour in the picker with no
// definition, a definition that resolves to nothing at paint time. Each of
// those renders as a badge that silently vanishes into the header, which is
// exactly the class of bug the per-surface CSS had before this file existed.

describe('status colour palette', () => {
  it('offers every palette colour in the picker, and no others', () => {
    expect([...STATUS_COLOR_KEYS].sort()).toEqual(Object.keys(STATUS_COLOR_PALETTE).sort())
  })

  it('gives every colour both a background and a foreground', () => {
    for (const [key, spec] of Object.entries(STATUS_COLOR_PALETTE)) {
      expect(spec.bg, `${key} bg`).toBeTruthy()
      expect(spec.fg, `${key} fg`).toBeTruthy()
    }
  })

  it('resolves every colour through theme tokens, never a fixed hex', () => {
    // A literal colour is how 'stopped' ended up punching a black hole through
    // the light theme. Anything here is painted on five different backgrounds.
    for (const [key, spec] of Object.entries(STATUS_COLOR_PALETTE)) {
      expect(spec.bg, `${key} bg is a raw colour`).toContain('var(--')
      expect(spec.fg, `${key} fg is a raw colour`).toContain('var(--')
      expect(spec.bg, `${key} bg has a hex literal`).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(spec.fg, `${key} fg has a hex literal`).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    }
  })

  it('gives every status a default colour that exists', () => {
    for (const status of PANE_STATUS_ORDER) {
      const color = DEFAULT_STATUS_COLORS[status]
      expect(color, `${status} has no default`).toBeTruthy()
      expect(STATUS_COLOR_PALETTE[color], `${status} defaults to unknown ${color}`).toBeTruthy()
    }
  })

  it('lists every status exactly once, and defaults cover the same set', () => {
    expect(new Set(PANE_STATUS_ORDER).size).toBe(PANE_STATUS_ORDER.length)
    expect([...PANE_STATUS_ORDER].sort()).toEqual(Object.keys(DEFAULT_STATUS_COLORS).sort())
  })

  it('keeps "done" and "blocked on you" visually apart by default', () => {
    // idle means finished, awaiting means nothing moves until you act. They are
    // adjacent in the lifecycle and were the pair that motivated a shared
    // vocabulary in the first place; a default that paints them alike undoes it.
    expect(DEFAULT_STATUS_COLORS.idle).not.toBe(DEFAULT_STATUS_COLORS.awaiting)
  })

  it('ships the agreed default hue for the three statuses that were recoloured', () => {
    // These three moved together and only make sense together: 'starting' took
    // over the attention hue, 'idle' took the accent hue it left behind, and
    // 'disconnected' stopped sharing a colour with either. Pinning the literals
    // is the point — the per-surface CSS has to say the same thing, and nothing
    // else in this file would notice if one of the three drifted back.
    expect(DEFAULT_STATUS_COLORS.starting).toBe('yellow')
    expect(DEFAULT_STATUS_COLORS.idle).toBe('blue')
    expect(DEFAULT_STATUS_COLORS.disconnected).toBe('ink')
  })

  it('paints the "blue" swatch with the role token that carries blue', () => {
    // 'blue' used to borrow --status-starting-*, which was the blue role token
    // at the time. That token is the attention hue now, so a swatch left
    // pointing at it would render yellow in the picker and on every idle badge.
    expect(STATUS_COLOR_PALETTE.blue.bg).toContain('--status-idle-')
    expect(STATUS_COLOR_PALETTE.blue.fg).toContain('--status-idle-')
    expect(STATUS_COLOR_PALETTE.blue.bg).not.toContain('--status-starting-')
    expect(STATUS_COLOR_PALETTE.blue.fg).not.toContain('--status-starting-')
  })

  it('rejects colours and statuses it does not know', () => {
    // Guards a settings blob written by a newer build: an unknown value must
    // fall back to the default, not emit var(--undefined) and paint nothing.
    expect(isStatusColorKey('green')).toBe(true)
    expect(isStatusColorKey('chartreuse')).toBe(false)
    expect(isStatusColorKey(undefined)).toBe(false)
    expect(isPaneStatusValue('awaiting')).toBe(true)
    expect(isPaneStatusValue('question')).toBe(false) // retired, merged into awaiting
    expect(isPaneStatusValue(7)).toBe(false)
  })

  it('covers every status the label resolver can be handed', () => {
    // PaneStatusValue is the widest union any surface passes around; a member
    // missing here is a status the settings page cannot colour at all.
    const covered: Record<PaneStatusValue, true> = {
      starting: true,
      running: true,
      idle: true,
      awaiting: true,
      stopped: true,
      exited: true,
      error: true,
      waiting: true,
      disconnected: true,
    }
    expect([...PANE_STATUS_ORDER].sort()).toEqual(Object.keys(covered).sort())
  })
})
