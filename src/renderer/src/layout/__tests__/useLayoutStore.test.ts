// The layout store: what it reads on startup, what it writes, and what it
// refuses to write back.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// A stand-in for ui_settings. The real module debounces to the backend; here it
// is a map plus the one listener the store subscribes with, which is enough to
// drive both the "another window changed it" path and the echo guard.
const store = new Map<string, unknown>()
let listener: ((keys: string[]) => void) | null = null

vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: <T,>(key: string, fallback: T): T =>
    (store.has(key) ? (store.get(key) as T) : fallback),
  settingsSet: (key: string, value: unknown): void => { store.set(key, value) },
  onSettingsChanged: (cb: (keys: string[]) => void) => { listener = cb; return () => { listener = null } },
}))

const { useLayoutStore, _resetLayoutStoreForTest } = await import('../useLayoutStore')
const { LAYOUT_SETTINGS_KEY, RAIL_SIZE, SLOT_LIMITS } = await import('../slots')

function reset(seed: Record<string, unknown> = {}): void {
  store.clear()
  listener = null
  for (const [k, v] of Object.entries(seed)) store.set(k, v)
  _resetLayoutStoreForTest()
}

describe('startup: carrying over the pre-refactor shell', () => {
  it('adopts the widths and collapsed state the user already had', () => {
    reset({
      'agentTeam.leftWidth': '420',
      'agentTeam.rightWidth': '260',
      'agentTeam.tokenPanel.expanded': '1',
    })
    const { layout } = useLayoutStore()
    expect(layout.value.slots.left.size).toBe(420)
    expect(layout.value.slots.right.size).toBe(260)
    expect(layout.value.slots.right.collapsed).toBe(false)
  })

  it('treats a never-set right panel as collapsed, matching the shipped default', () => {
    reset()
    expect(useLayoutStore().layout.value.slots.right.collapsed).toBe(true)
  })

  it('clamps a legacy width that no longer fits its range', () => {
    reset({ 'agentTeam.leftWidth': '9999' })
    expect(useLayoutStore().layout.value.slots.left.size).toBe(SLOT_LIMITS.left.max)
  })

  it('prefers the new key once one exists', () => {
    const saved = { version: 1, chrome: { titlebar: true, statusbar: true },
      slots: { left: { views: ['agents'], active: 'agents', size: 300, collapsed: true },
               right: { views: [], active: null, size: 300, collapsed: false },
               up: { views: [], active: null, size: 180, collapsed: false },
               down: { views: [], active: null, size: 220, collapsed: false } } }
    reset({ 'agentTeam.leftWidth': '420', [LAYOUT_SETTINGS_KEY]: JSON.stringify(saved) })
    const { layout } = useLayoutStore()
    expect(layout.value.slots.left.size).toBe(300)
    expect(layout.value.slots.left.collapsed).toBe(true)
  })
})

describe('startup: refusing to trust a broken value', () => {
  it('falls back when the JSON does not parse', () => {
    reset({ [LAYOUT_SETTINGS_KEY]: '{not json' })
    expect(useLayoutStore().layout.value.slots.left.views.length).toBeGreaterThan(0)
  })

  it('falls back on an unknown version rather than guessing its shape', () => {
    reset({ [LAYOUT_SETTINGS_KEY]: JSON.stringify({ version: 99, slots: {} }) })
    expect(useLayoutStore().layout.value.slots.left.views.length).toBeGreaterThan(0)
  })

  it('drops only the malformed slot, not the whole layout', () => {
    const saved = { version: 1, chrome: { titlebar: true, statusbar: true },
      slots: { left: { views: ['agents'], active: 'agents', size: 300, collapsed: false },
               right: 'nonsense' } }
    reset({ [LAYOUT_SETTINGS_KEY]: JSON.stringify(saved) })
    const { layout } = useLayoutStore()
    expect(layout.value.slots.left.size).toBe(300)          // honoured
    expect(layout.value.slots.right.views.length).toBeGreaterThan(0) // defaulted
  })

  it('repairs an active view that is no longer in the slot', () => {
    const saved = { version: 1, chrome: { titlebar: true, statusbar: true },
      slots: { left: { views: ['agents', 'git'], active: 'gone', size: 300, collapsed: false } } }
    reset({ [LAYOUT_SETTINGS_KEY]: JSON.stringify(saved) })
    expect(useLayoutStore().layout.value.slots.left.active).toBe('agents')
  })
})

describe('collapsing', () => {
  beforeEach(() => reset())

  it('keeps the expanded size, so reopening returns where the user left off', () => {
    const { layout, setSlotSize, setSlotCollapsed } = useLayoutStore()
    setSlotSize('left', 480)
    setSlotCollapsed('left', true)
    expect(layout.value.slots.left.size).toBe(480)
    setSlotCollapsed('left', false)
    expect(layout.value.slots.left.size).toBe(480)
  })

  it('reports the rail as the track while collapsed', () => {
    const { slotTracks, setSlotCollapsed } = useLayoutStore()
    setSlotCollapsed('left', true)
    expect(slotTracks.value.left).toBe('var(--rail-size)')
    expect(RAIL_SIZE).toBe(36)
  })

  it('refuses to collapse an empty slot — there would be no way back', () => {
    const { layout, setSlotCollapsed, canCollapse } = useLayoutStore()
    expect(canCollapse('up')).toBe(false)
    setSlotCollapsed('up', true)
    expect(layout.value.slots.up.collapsed).toBe(false)
  })

  it('an empty slot takes no space even so', () => {
    expect(useLayoutStore().slotTracks.value.up).toBe('0px')
  })
})

describe('persistence and cross-window sync', () => {
  beforeEach(() => reset())

  it('writes through on a size change', () => {
    useLayoutStore().setSlotSize('left', 400)
    expect(JSON.parse(String(store.get(LAYOUT_SETTINGS_KEY))).slots.left.size).toBe(400)
  })

  it('adopts a layout another window saved', () => {
    const { layout } = useLayoutStore()
    const remote = JSON.parse(JSON.stringify(layout.value))
    remote.slots.left.size = 512
    store.set(LAYOUT_SETTINGS_KEY, JSON.stringify(remote))
    listener?.([LAYOUT_SETTINGS_KEY])
    expect(layout.value.slots.left.size).toBe(512)
  })

  it('does not write the value it just accepted back out', () => {
    const { layout } = useLayoutStore()
    const remote = JSON.parse(JSON.stringify(layout.value))
    remote.slots.left.size = 333
    const incoming = JSON.stringify(remote)
    store.set(LAYOUT_SETTINGS_KEY, incoming)
    listener?.([LAYOUT_SETTINGS_KEY])
    // Byte-identical to what arrived: no echo went back to the other window.
    expect(store.get(LAYOUT_SETTINGS_KEY)).toBe(incoming)
  })

  it('ignores changes to unrelated settings keys', () => {
    const { layout } = useLayoutStore()
    const before = layout.value.slots.left.size
    store.set('agentTeam.somethingElse', 'x')
    listener?.(['agentTeam.somethingElse'])
    expect(layout.value.slots.left.size).toBe(before)
  })

  it('skips the write when a set changes nothing', () => {
    const { setSlotSize, layout } = useLayoutStore()
    const size = layout.value.slots.left.size
    store.delete(LAYOUT_SETTINGS_KEY)
    setSlotSize('left', size)
    expect(store.has(LAYOUT_SETTINGS_KEY)).toBe(false)
  })
})

describe('moving views between slots', () => {
  beforeEach(() => reset())

  it('moves a view and leaves exactly one copy', () => {
    const s = useLayoutStore()
    expect(s.moveView('history', 'down')).toBe(true)
    expect(s.layout.value.slots.right.views).not.toContain('history')
    expect(s.layout.value.slots.down.views).toEqual(['history'])
    expect(s.slotOf('history')).toBe('down')
  })

  it('makes the moved view active in its new slot', () => {
    const s = useLayoutStore()
    s.moveView('history', 'down')
    expect(s.layout.value.slots.down.active).toBe('history')
  })

  it('expands a slot a view is moved into', () => {
    // right ships collapsed; a move into a folded slot would otherwise look
    // like nothing happened.
    const s = useLayoutStore()
    s.setSlotCollapsed('down', false)
    s.moveView('history', 'down')
    s.setSlotCollapsed('down', true)
    s.moveView('tasker', 'down')
    expect(s.layout.value.slots.down.collapsed).toBe(false)
  })

  it('refuses a destination the view cannot be rendered in', () => {
    const s = useLayoutStore()
    // agents is inline in ControlPane — `left` is the only slot that draws it.
    expect(s.moveView('agents', 'down')).toBe(false)
    expect(s.slotOf('agents')).toBe('left')
  })

  it('repairs the source slot when the active view leaves', () => {
    const s = useLayoutStore()
    s.setActiveView('right', 'tasker')
    s.moveView('tasker', 'down')
    expect(s.layout.value.slots.right.active).not.toBe('tasker')
    expect(s.layout.value.slots.right.views).toContain(s.layout.value.slots.right.active!)
  })

  it('clears the collapsed flag when a slot empties out', () => {
    // Otherwise the next view to land there arrives folded, for no reason the
    // user can see.
    const s = useLayoutStore()
    s.moveView('history', 'down')
    s.setSlotCollapsed('down', true)
    s.moveView('history', 'right')
    expect(s.layout.value.slots.down.views).toEqual([])
    expect(s.layout.value.slots.down.collapsed).toBe(false)
    expect(s.layout.value.slots.down.active).toBeNull()
  })

  it('hides a view and keeps it hidden across a reload', () => {
    const s = useLayoutStore()
    expect(s.hideView('plans')).toBe(true)
    expect(s.slotOf('plans')).toBeNull()
    expect(s.layout.value.hidden).toContain('plans')
    _resetLayoutStoreForTest()  // re-reads the same settings store
    // Reconciliation re-homes views that fell out; a deliberate removal must
    // not be undone by that rule.
    expect(useLayoutStore().slotOf('plans')).toBeNull()
  })

  it('restores a hidden view to the slot it ships in', () => {
    const s = useLayoutStore()
    s.hideView('plans')
    expect(s.showView('plans')).toBe(true)
    expect(s.slotOf('plans')).toBe('left')
    expect(s.layout.value.hidden).not.toContain('plans')
  })

  it('will not hide a view that has nowhere else to be', () => {
    const s = useLayoutStore()
    expect(s.hideView('cli-stage')).toBe(false)
  })

  it('reset puts every view back and drops the hidden list', () => {
    const s = useLayoutStore()
    s.hideView('plans')
    s.moveView('history', 'down')
    s.setSlotSize('left', 500)
    s.resetLayout()
    expect(s.layout.value.hidden).toEqual([])
    expect(s.slotOf('plans')).toBe('left')
    expect(s.slotOf('history')).toBe('right')
    expect(s.layout.value.slots.left.size).toBe(360)
  })

  it('applies a preset as a whole state, not as a patch', () => {
    // Whatever the layout was before, a preset must land in the same place.
    const s = useLayoutStore()
    s.moveView('history', 'down')
    s.setSlotSize('right', 500)
    expect(s.applyPreset('focus')).toBe(true)
    expect(s.layout.value.slots.left.collapsed).toBe(true)
    expect(s.layout.value.slots.right.collapsed).toBe(true)
    expect(s.slotOf('history')).toBe('right')
    expect(s.layout.value.slots.right.size).toBe(300)
  })

  it('the bottom-panel preset moves views rather than copying them', () => {
    const s = useLayoutStore()
    s.applyPreset('bottom-panel')
    expect(s.layout.value.slots.down.views).toEqual(['history', 'messages'])
    expect(s.layout.value.slots.right.views).toEqual(['tokens', 'tasker', 'preview'])
    expect(s.layout.value.slots.right.active).toBe('tokens')
    expect(s.slotOf('history')).toBe('down')
  })

  it('ignores an unknown preset instead of blanking the layout', () => {
    const s = useLayoutStore()
    s.setSlotSize('left', 500)
    expect(s.applyPreset('no-such-preset')).toBe(false)
    expect(s.layout.value.slots.left.size).toBe(500)
  })

  it('every preset survives a reload unchanged', () => {
    // Presets are written through the same path as any other edit, so one that
    // reconciliation would rewrite is a preset that silently does not stick.
    for (const id of ['default', 'focus', 'bottom-panel']) {
      reset()
      const s = useLayoutStore()
      s.applyPreset(id)
      const before = JSON.stringify(s.layout.value)
      _resetLayoutStoreForTest()
      expect(JSON.stringify(useLayoutStore().layout.value), id).toBe(before)
    }
  })

  it('toggles the chrome parts independently', () => {
    const s = useLayoutStore()
    s.setChrome('statusbar', false)
    expect(s.layout.value.chrome).toEqual({ titlebar: true, statusbar: false })
  })
})
