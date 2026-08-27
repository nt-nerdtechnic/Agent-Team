// @vitest-environment happy-dom
// Shell-slot collapse wiring in App.vue.
//
// Collapsing either side slot moves the main column by hundreds of pixels.
// Per-pane ResizeObservers coalesce that transition away often enough to leave
// terminals rendering at a stale width, and the right panel shipped without a
// refit for exactly that reason. These are drift guards: they fail if either
// toggle is ever rewired back to a bare setSlotCollapsed.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend, terminal, settings, and onboarding lifecycles;
// keep these checks narrow source-text assertions like the other App tests.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

describe('App shell grid', () => {
  it('declares a track for each slot, and a row for each horizontal one', () => {
    const at = appSource.indexOf('.app {')
    const block = appSource.slice(at, appSource.indexOf('}', at))
    expect(block).toContain('minmax(0, var(--left-width, 360px))')
    expect(block).toContain('minmax(0, var(--token-panel-width, 36px))')
    expect(block).toContain('minmax(0, var(--up-height, 0px))')
    expect(block).toContain('minmax(0, var(--down-height, 0px))')
  })

  it('lets the side panels give ground rather than pushing the stage off-screen', () => {
    // A bare `360px` track keeps its width even when the window is narrower
    // than the panels put together: the stage collapses to zero, the grid
    // overflows, and `overflow: hidden` clips the right column away — together
    // with the handle that would have let the user shrink the panel again.
    // Every fixed track must therefore be a minmax with a zero floor, and the
    // stage must hold a floor of its own so the terminal never vanishes.
    const at = appSource.indexOf('.app {')
    const block = appSource.slice(at, appSource.indexOf('\n}', at))
    expect(block).toContain('minmax(var(--stage-min-width, 220px), 1fr)')
    expect(block).toContain('minmax(var(--stage-min-height, 140px), 1fr)')
    // No bare fixed track survives: each var-driven track carries a 0 floor.
    for (const v of ['--left-width', '--token-panel-width', '--up-height', '--down-height']) {
      expect(block, v).not.toMatch(new RegExp(`(?<!minmax\\(0, )var\\(${v}`))
    }
  })

  it('places every in-flow grid item explicitly', () => {
    // With explicit rows, auto-placement drops the sidebar into the 0px `up`
    // strip; with none it opens an implicit second row and parks the handles
    // off-screen. Both failures are silent, so these placements are the guard.
    const styles = appSource.slice(appSource.indexOf('<style scoped>'))
    for (const [sel, row, col] of [
      ['.sidebar', 'grid-row: 1 / 4', 'grid-column: 1'],
      ['.token-panel', 'grid-row: 1 / 4', 'grid-column: 3'],
      ['.stage', 'grid-row: 2', 'grid-column: 2'],
      ['.slot--up', 'grid-row: 1', 'grid-column: 2'],
      ['.slot--down', 'grid-row: 3', 'grid-column: 2'],
      ['.resize-handle-left', 'grid-row: 1 / 4', 'grid-column: 1'],
      ['.resize-handle-right', 'grid-row: 1 / 4', 'grid-column: 3'],
    ] as const) {
      const at = styles.indexOf(`${sel} {`)
      expect(at, `${sel} has no rule`).toBeGreaterThan(-1)
      const rule = styles.slice(at, styles.indexOf('}', at))
      expect(rule, sel).toContain(row)
      expect(rule, sel).toContain(col)
    }
  })

  it('renders both horizontal slots through the shared container', () => {
    for (const id of ['up', 'down']) {
      const at = appSource.indexOf(`slot-id="${id}"`)
      expect(at, id).toBeGreaterThan(-1)
      const block = appSource.slice(at, appSource.indexOf('</SlotContainer>', at))
      expect(block).toContain(`:views="shellLayout.slots.${id}.views"`)
      expect(block).toContain(`setActiveView('${id}', v)`)
      expect(block).toContain(`setSlotCollapsedAndRefit('${id}', v)`)
    }
  })

  it('drops the status bar row when the layout hides it', () => {
    expect(appSource).toContain('<div v-if="shellLayout.chrome.statusbar" class="statusbar">')
    expect(appSource).toContain("'--chrome-bottom': shellLayout.chrome.statusbar ? '24px' : '0px'")
  })
})

describe('Sidebar layout mode — the Active agents list', () => {
  // `sidebarLeftPx` is an absolute width dragged once and clamped against the
  // stage width at that moment. Anything that narrows the stage afterwards —
  // expanding the right panel, opening the left one, resizing the window —
  // used to leave the pane column at its stored px while the list was squeezed
  // to its min-width, making the row wider than the stage. `.stage` hides its
  // overflow, so the list was cut off at the stage's right edge rather than
  // shrunk, which reads as the right-hand panel covering it.
  it('lets the pane column give ground so the list is never cut off', () => {
    const at = appSource.indexOf("case 'sidebar': {")
    expect(at).toBeGreaterThan(-1)
    const block = appSource.slice(at, appSource.indexOf('\n    }', at))
    expect(block).toContain('minmax(0, ${sidebarLeftPx.value}px)')
    expect(block).toContain('minmax(0, ${dualFocusSplitPx.value}px)')
    expect(block).toContain('minmax(${MEETING_LIST_MIN_PX}px, 1fr)')
    // No bare px track survives in this mode.
    expect(block).not.toMatch(/`\$\{[a-zA-Z.]+\}px 1fr/)
  })

  it('keeps the split handle on the boundary the track actually renders', () => {
    // Positioning duplicated from a track definition drifts the moment the
    // track is clamped — the same hazard the shell's own handles once had.
    const at = appSource.indexOf('const sidebarHandlePos')
    const block = appSource.slice(at, appSource.indexOf('\n})', at))
    expect(block).toContain('min(${sidebarLeftPx.value}px, calc(100% - ${MEETING_LIST_MIN_PX}px))')
  })

  it('drives every copy of the list width from one constant', () => {
    // The track, the drag clamp, the stage-width arithmetic and the CSS floor
    // all encode the same two numbers; a literal left behind is a silent drift.
    expect(appSource).toContain('const MEETING_LIST_WIDTH_PX = 220')
    expect(appSource).toContain('const MEETING_LIST_MIN_PX = 140')
    expect(appSource).not.toContain("=== 'sidebar' ? 220 : 0")
    expect(appSource).not.toContain('_gSize - 140')
  })
})

describe('App shell slot collapse', () => {
  it('refits terminals when the right slot is toggled', () => {
    const at = appSource.indexOf('const tokenPanelExpanded')
    expect(at).toBeGreaterThan(-1)
    const block = appSource.slice(at, appSource.indexOf('})', at))
    expect(block).toContain("setSlotCollapsed('right', !v)")
    expect(block).toContain('refitAllTerminals()')
  })

  it('refits terminals when the left slot is toggled', () => {
    const at = appSource.indexOf('function setLeftCollapsed')
    expect(at).toBeGreaterThan(-1)
    const block = appSource.slice(at, appSource.indexOf('\n}', at))
    expect(block).toContain("setSlotCollapsed('left', v)")
    expect(block).toContain('refitAllTerminals()')
    // An empty slot has nothing to collapse into a rail.
    expect(block).toContain("canCollapse('left')")
  })

  it('drives ControlPane collapse through the layout store, not local state', () => {
    const at = appSource.indexOf('<ControlPane')
    const block = appSource.slice(at, appSource.indexOf('/>', at))
    expect(block).toContain(':collapsed="leftPanelCollapsed"')
    expect(block).toContain('@update:collapsed="setLeftCollapsed"')
  })

  it('refits on the layout paths that have no single call site', () => {
    // Settings edits, view moves, and another window's changes all land as a
    // new track value and nothing else.
    const at = appSource.indexOf('watch(slotTracks')
    expect(at).toBeGreaterThan(-1)
    const block = appSource.slice(at, appSource.indexOf('deep: true', at))
    expect(block).toContain('refitAllTerminals()')
    expect(block).toContain('clearTimeout(_slotTrackTimer)')
  })

  it('hides each side resize handle unless its slot has a track to drag', () => {
    // A collapsed slot is a 36px rail and an empty one is 0px: in both cases a
    // live handle sits against the window edge writing a size nothing shows.
    expect(appSource).toContain(
      '<div v-if="leftHandleVisible" class="resize-handle resize-handle-left"'
    )
    expect(appSource).toContain(
      '<div v-if="rightHandleVisible" class="resize-handle resize-handle-right"'
    )
    for (const [name, slot] of [['leftHandleVisible', 'left'], ['rightHandleVisible', 'right']]) {
      const at = appSource.indexOf(`const ${name} = computed(`)
      expect(at, name).toBeGreaterThan(-1)
      const block = appSource.slice(at, appSource.indexOf('\n)', at))
      expect(block, name).toContain(`slots.${slot}.collapsed`)
      expect(block, name).toContain(`slots.${slot}.views.length > 0`)
    }
  })

  it('gives a view the same inputs whichever slot draws it', () => {
    // HistoryPanel takes pipeline.workspacePath from the right panel; a copy in
    // up/down handed currentWorkspace instead would quietly point at a
    // different project while a pipeline is running.
    for (const id of ['up', 'down']) {
      const at = appSource.indexOf(`slot-id="${id}"`)
      const block = appSource.slice(at, appSource.indexOf('</SlotContainer>', at))
      expect(block, id).toContain(':workspace-path="pipeline.workspacePath"')
      expect(block, id).not.toContain(':workspace-path="currentWorkspace"')
    }
  })

  it('imports a body only for the views a horizontal slot may hold', () => {
    // Anything reachable by a shortcut or an agent push is pinned to the host
    // that knows how to reveal it, so no other slot can be asked to draw it.
    for (const dead of ['SlotExplorer', 'SlotPlans', 'SlotPreview', 'SlotGit']) {
      expect(appSource, dead).not.toContain(dead)
    }
    for (const live of ['SlotHistory', 'SlotTasker', 'SlotMessages']) {
      expect(appSource, live).toContain(`const ${live} = defineAsyncComponent(`)
    }
  })
})
