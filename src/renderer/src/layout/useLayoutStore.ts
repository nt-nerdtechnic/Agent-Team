// The single source of truth for the shell's slot layout.
//
// Module-level state, not a per-component ref: every window renders one shell,
// and Settings has to drive the same object the shell reads. Persistence goes
// through ui_settings, which already replicates to the other windows, so a
// change made here shows up everywhere without a restart.
import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import {
  LAYOUT_SETTINGS_KEY,
  SLOT_IDS,
  clampSlotSize,
  LAYOUT_PRESETS,
  createDefaultLayout,
  isSlotEmpty,
  type LayoutState,
  type SlotId,
  type SlotState,
} from './slots'
import { canPlace, isMovable, reconcileOccupancy, viewById } from './viewRegistry'

/**
 * Pre-refactor keys, read once so an existing install keeps the widths and the
 * collapsed right panel it already had. Phase G removes them; until then this
 * is what makes "the shell looks exactly the same after upgrading" true.
 */
const LEGACY_KEYS = {
  leftWidth: 'agentTeam.leftWidth',
  rightWidth: 'agentTeam.rightWidth',
  rightCollapsed: 'agentTeam.tokenPanel.expanded',
} as const

function readLegacyInto(layout: LayoutState): LayoutState {
  const left = parseInt(settingsGet(LEGACY_KEYS.leftWidth, ''), 10)
  if (Number.isFinite(left)) layout.slots.left.size = clampSlotSize('left', left)

  const right = parseInt(settingsGet(LEGACY_KEYS.rightWidth, ''), 10)
  if (Number.isFinite(right)) layout.slots.right.size = clampSlotSize('right', right)

  // Stored as '1' when expanded; anything else (including "never set") means
  // collapsed, which is what the shell has always defaulted to.
  const expanded = settingsGet<string | null>(LEGACY_KEYS.rightCollapsed, null)
  layout.slots.right.collapsed = expanded !== '1'
  return layout
}

function isSlotShaped(v: unknown): v is SlotState {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<SlotState>
  return Array.isArray(s.views) && typeof s.size === 'number' && typeof s.collapsed === 'boolean'
}

/**
 * Reads the stored layout, falling back to the shipped arrangement.
 *
 * Anything unrecognised is discarded rather than patched: a half-understood
 * layout renders as a broken shell with no way to tell why, whereas falling
 * back is visible, correct, and one "reset layout" away from what the user
 * wanted. Slots are validated individually so one bad entry cannot take the
 * others down with it.
 */
function load(): LayoutState {
  const base = createDefaultLayout()
  const raw = settingsGet<string>(LAYOUT_SETTINGS_KEY, '')
  if (!raw) return readLegacyInto(base)

  try {
    const parsed = JSON.parse(raw) as Partial<LayoutState>
    if (parsed?.version !== 1) return readLegacyInto(base)

    if (parsed.chrome && typeof parsed.chrome === 'object') {
      base.chrome.titlebar = parsed.chrome.titlebar !== false
      base.chrome.statusbar = parsed.chrome.statusbar !== false
    }
    if (Array.isArray(parsed.hidden)) {
      base.hidden = parsed.hidden.filter((v) => typeof v === 'string' && !!viewById(v))
    }
    for (const id of SLOT_IDS) {
      const stored = parsed.slots?.[id]
      if (!isSlotShaped(stored)) continue
      base.slots[id] = {
        views: stored.views.filter((v) => typeof v === 'string'),
        active: typeof stored.active === 'string' ? stored.active : null,
        size: clampSlotSize(id, stored.size),
        collapsed: stored.collapsed,
        ...(stored.spanMode ? { spanMode: stored.spanMode } : {}),
      }
    }
    // One pass over all four slots at once: the singleton invariant and the
    // re-homing of anything that fell out are both cross-slot decisions and
    // cannot be made a slot at a time.
    const occupancy = reconcileOccupancy(
      SLOT_IDS.map((id) => [id, base.slots[id].views]),
      base.hidden
    )
    for (const id of SLOT_IDS) {
      const slot = base.slots[id]
      slot.views = occupancy[id]
      // An active view that is no longer in the slot would render nothing.
      if (slot.active && !slot.views.includes(slot.active)) slot.active = slot.views[0] ?? null
      if (!slot.active && slot.views.length) slot.active = slot.views[0]
      if (!slot.views.length) slot.active = null
    }
    return base
  } catch {
    return readLegacyInto(base)
  }
}

const state = ref<LayoutState>(load())

/**
 * Last value written or accepted, as JSON.
 *
 * Guards the echo without a flag: applying a remote change updates this, so the
 * write that the change triggers compares equal and stops there. A boolean
 * would have to survive Vue's async watch flush; a value comparison does not
 * care when it runs.
 */
let lastSynced = JSON.stringify(state.value)

function persist(): void {
  const json = JSON.stringify(state.value)
  if (json === lastSynced) return
  lastSynced = json
  settingsSet(LAYOUT_SETTINGS_KEY, json)
}

let subscribed = false
function subscribeToRemote(): void {
  if (subscribed) return
  subscribed = true
  onSettingsChanged((keys) => {
    if (!keys.includes(LAYOUT_SETTINGS_KEY)) return
    const incoming = settingsGet<string>(LAYOUT_SETTINGS_KEY, '')
    if (incoming === lastSynced) return
    lastSynced = incoming
    state.value = load()
  })
}

export function useLayoutStore(): {
  layout: Ref<LayoutState>
  slotTracks: ComputedRef<Record<SlotId, string>>
  setSlotSize: (id: SlotId, px: number) => void
  setSlotCollapsed: (id: SlotId, collapsed: boolean) => void
  toggleSlotCollapsed: (id: SlotId) => void
  setActiveView: (id: SlotId, viewId: string) => void
  slotOf: (viewId: string) => SlotId | null
  moveView: (viewId: string, to: SlotId) => boolean
  hideView: (viewId: string) => boolean
  showView: (viewId: string, to?: SlotId) => boolean
  setChrome: (part: 'titlebar' | 'statusbar', visible: boolean) => void
  resetLayout: () => void
  applyPreset: (id: string) => boolean
  canCollapse: (id: SlotId) => boolean
} {
  subscribeToRemote()

  const slotTracks = computed(() => {
    const out = {} as Record<SlotId, string>
    for (const id of SLOT_IDS) {
      const slot = state.value.slots[id]
      out[id] = isSlotEmpty(slot) ? '0px' : slot.collapsed ? 'var(--rail-size)' : `${slot.size}px`
    }
    return out
  })

  /** Collapsing an empty slot would be a no-op the user cannot undo. */
  function canCollapse(id: SlotId): boolean {
    return !isSlotEmpty(state.value.slots[id])
  }

  function setSlotSize(id: SlotId, px: number): void {
    const slot = state.value.slots[id]
    const next = clampSlotSize(id, px)
    if (slot.size === next) return
    slot.size = next
    persist()
  }

  function setSlotCollapsed(id: SlotId, collapsed: boolean): void {
    const slot = state.value.slots[id]
    if (!canCollapse(id) || slot.collapsed === collapsed) return
    // `size` is deliberately left alone: it is the expanded width, and keeping
    // it is what lets reopening return to where the user left off.
    slot.collapsed = collapsed
    persist()
  }

  function toggleSlotCollapsed(id: SlotId): void {
    setSlotCollapsed(id, !state.value.slots[id].collapsed)
  }

  /** Which slot currently holds a view, or null if it is hidden. */
  function slotOf(viewId: string): SlotId | null {
    return SLOT_IDS.find((id) => state.value.slots[id].views.includes(viewId)) ?? null
  }

  /** Drops a view from wherever it is and repairs that slot's active tab. */
  function detach(viewId: string): SlotId | null {
    const from = slotOf(viewId)
    if (!from) return null
    const slot = state.value.slots[from]
    slot.views = slot.views.filter((v) => v !== viewId)
    if (slot.active === viewId) slot.active = slot.views[0] ?? null
    // A slot with nothing in it has no rail to click, so a collapsed flag left
    // behind would come back as a surprise the next time a view lands there.
    if (!slot.views.length) slot.collapsed = false
    return from
  }

  /**
   * Moves a view to another slot. Refuses destinations the view cannot be
   * rendered in — the move would otherwise succeed and leave a blank panel.
   */
  function moveView(viewId: string, to: SlotId): boolean {
    if (!canPlace(viewId, to)) return false
    const from = slotOf(viewId)
    if (from === to) return false
    detach(viewId)
    const slot = state.value.slots[to]
    slot.views = [...slot.views, viewId]
    slot.active = viewId
    // Landing a view in a folded slot would look like the move did nothing.
    slot.collapsed = false
    state.value.hidden = state.value.hidden.filter((v) => v !== viewId)
    persist()
    return true
  }

  /** Takes a view off the layout. Survives a restart; see `LayoutState.hidden`. */
  function hideView(viewId: string): boolean {
    if (!isMovable(viewId) || !slotOf(viewId)) return false
    detach(viewId)
    if (!state.value.hidden.includes(viewId)) state.value.hidden = [...state.value.hidden, viewId]
    persist()
    return true
  }

  /** Puts a hidden view back where it ships, or in the slot given. */
  function showView(viewId: string, to?: SlotId): boolean {
    const home = to ?? (viewById(viewId)?.defaultSlot as SlotId | undefined)
    if (!home || !canPlace(viewId, home)) return false
    state.value.hidden = state.value.hidden.filter((v) => v !== viewId)
    if (slotOf(viewId)) {
      persist()
      return true
    }
    const slot = state.value.slots[home]
    slot.views = [...slot.views, viewId]
    slot.active = viewId
    slot.collapsed = false
    persist()
    return true
  }

  function setChrome(part: 'titlebar' | 'statusbar', visible: boolean): void {
    if (state.value.chrome[part] === visible) return
    state.value.chrome[part] = visible
    persist()
  }

  /** Back to the shipped arrangement — the way out of any layout mistake. */
  function resetLayout(): void {
    state.value = createDefaultLayout()
    persist()
  }

  /** Replaces the whole layout with a named starting point. */
  function applyPreset(id: string): boolean {
    const preset = LAYOUT_PRESETS.find((p) => p.id === id)
    if (!preset) return false
    state.value = preset.build()
    persist()
    return true
  }

  function setActiveView(id: SlotId, viewId: string): void {
    const slot = state.value.slots[id]
    if (!slot.views.includes(viewId) || slot.active === viewId) return
    slot.active = viewId
    persist()
  }

  return {
    layout: state,
    slotTracks,
    setSlotSize,
    setSlotCollapsed,
    toggleSlotCollapsed,
    setActiveView,
    slotOf,
    moveView,
    hideView,
    showView,
    setChrome,
    resetLayout,
    applyPreset,
    canCollapse,
  }
}

/** Test seam: drops persisted state and re-reads from settings. */
export function _resetLayoutStoreForTest(): void {
  state.value = load()
  lastSynced = JSON.stringify(state.value)
  subscribed = false
}
