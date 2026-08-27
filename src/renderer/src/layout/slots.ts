// Slot geometry and the shape of the persisted layout.
//
// The shell has five slots but only four of them are configurable: `main` holds
// the CLI stage, cannot be collapsed, resized or emptied, and is deliberately
// absent from `LayoutState.slots` so the type system rejects the operations that
// do not apply to it rather than leaving them to a runtime guard.

import { defaultViewsFor } from './viewRegistry'

export type SlotId = 'left' | 'right' | 'up' | 'down'

/** Declaration order doubles as the auto-collapse order when space runs out. */
export const SLOT_IDS: readonly SlotId[] = ['right', 'up', 'down', 'left']

/** Vertical slots size along their width; horizontal ones along their height. */
export type SlotAxis = 'width' | 'height'

export function slotAxis(id: SlotId): SlotAxis {
  return id === 'left' || id === 'right' ? 'width' : 'height'
}

/**
 * A collapsed slot shows this much of itself — wide for the vertical rails,
 * tall for the horizontal ones. One constant for both axes: the rail is the
 * same strip turned ninety degrees, and two numbers would drift apart.
 *
 * 36 matches the right panel's shipped rail, so nothing moves on upgrade.
 */
export const RAIL_SIZE = 36

export interface SlotLimits {
  min: number
  max: number
  /** Applied when a slot is first populated, and by "reset layout". */
  initial: number
}

/**
 * Drag limits per slot. left/right carry the values the shell already shipped
 * with, so restoring a stored width can never land outside its own range.
 */
export const SLOT_LIMITS: Record<SlotId, SlotLimits> = {
  left: { min: 240, max: 560, initial: 360 },
  right: { min: 180, max: 520, initial: 300 },
  up: { min: 80, max: 480, initial: 180 },
  down: { min: 80, max: 480, initial: 220 },
}

export function clampSlotSize(id: SlotId, px: number): number {
  const { min, max } = SLOT_LIMITS[id]
  return Math.max(min, Math.min(max, Math.round(px)))
}

export interface SlotState {
  /** View ids, in tab order. Empty means the slot takes no space at all. */
  views: string[]
  /** Which view is showing; null only while `views` is empty. */
  active: string | null
  /** Expanded size in px along the slot's axis. Kept while collapsed so
   *  reopening returns to where the user left it, not to `initial`. */
  size: number
  collapsed: boolean
  /** Horizontal slots only: whether they span under/over the vertical ones. */
  spanMode?: 'inner' | 'full'
}

export interface LayoutState {
  version: 1
  chrome: { titlebar: boolean; statusbar: boolean }
  slots: Record<SlotId, SlotState>
  /**
   * Views the user took off the layout entirely.
   *
   * Needed because reconciliation re-homes any known view it finds in no slot,
   * which is what stops a narrowed whitelist from losing a panel — but that
   * same rule would undo a deliberate removal on the next launch. Listing them
   * is how "gone" is told apart from "fell out".
   */
  hidden: string[]
}

/** The key `LayoutState` lives under in ui_settings. */
export const LAYOUT_SETTINGS_KEY = 'agentTeam.layout'

/**
 * The shipped arrangement: the three panels the shell has always had, with the
 * two new slots present but empty. An empty slot occupies no space, so this
 * renders pixel-identical to the pre-refactor three-column shell.
 */
export function createDefaultLayout(): LayoutState {
  return {
    version: 1,
    chrome: { titlebar: true, statusbar: true },
    hidden: [],
    slots: {
      left: {
        views: defaultViewsFor('left'),
        active: defaultViewsFor('left')[0] ?? null,
        size: SLOT_LIMITS.left.initial,
        collapsed: false,
      },
      right: {
        views: defaultViewsFor('right'),
        active: defaultViewsFor('right')[0] ?? null,
        size: SLOT_LIMITS.right.initial,
        collapsed: true, // shipped default: the right panel starts as a rail
      },
      up: { views: [], active: null, size: SLOT_LIMITS.up.initial, collapsed: false, spanMode: 'inner' },
      down: { views: [], active: null, size: SLOT_LIMITS.down.initial, collapsed: false, spanMode: 'inner' },
    },
  }
}

/**
 * Named starting points, offered in Settings beside the reset.
 *
 * Each one builds a whole state rather than patching the current one, so
 * picking a preset always lands in the same place no matter what the layout
 * was before — which is the only thing that makes a preset worth having.
 */
export interface LayoutPreset {
  id: string
  labelKey: string
  build: () => LayoutState
}

export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  { id: 'default', labelKey: 'layout.preset.default', build: createDefaultLayout },
  {
    // Everything folded to a rail: the CLI stage gets the whole window, and
    // one click on either rail brings a panel back.
    id: 'focus',
    labelKey: 'layout.preset.focus',
    build: () => {
      const l = createDefaultLayout()
      l.slots.left.collapsed = true
      l.slots.right.collapsed = true
      return l
    },
  },
  {
    // The bottom strip carries the panels you watch rather than drive, in the
    // place an IDE usually puts them.
    id: 'bottom-panel',
    labelKey: 'layout.preset.bottom-panel',
    build: () => {
      const l = createDefaultLayout()
      const moved = ['history', 'messages']
      l.slots.right.views = l.slots.right.views.filter((v) => !moved.includes(v))
      l.slots.right.active = l.slots.right.views[0] ?? null
      l.slots.down.views = moved
      l.slots.down.active = moved[0]
      return l
    },
  },
]

/** True when a slot renders nothing and should take no space. */
export function isSlotEmpty(slot: SlotState): boolean {
  return slot.views.length === 0
}

/**
 * The CSS length for a slot's grid track.
 *
 * Empty and collapsed both make a slot narrow, but they are different states:
 * empty means "no view lives here" (0, invisible, restored by assigning a view)
 * while collapsed means "the user folded it away" (a rail they can click back).
 */
export function slotTrackSize(slot: SlotState): string {
  if (isSlotEmpty(slot)) return '0px'
  return slot.collapsed ? `${RAIL_SIZE}px` : `${slot.size}px`
}
