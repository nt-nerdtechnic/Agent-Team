// @vitest-environment happy-dom
// Ancestry in the pane lists — the one list each main-window mode renders:
// the Auto sidebar's cards, the Spotlight strip, the fullscreen PiP rows.
//
// Mounting App starts backend, terminal and onboarding lifecycles, so — like
// the other App.*.test.ts files — the wiring is asserted against its source.
// The behaviour underneath runs for real in lib/__tests__/paneListView.test.ts
// and lib/__tests__/paneLineage.test.ts.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function bodyOf(declaration: string): string {
  const at = appSource.indexOf(declaration)
  expect(at, `${declaration} should exist`).toBeGreaterThan(-1)
  const closes = [appSource.indexOf('\n)', at), appSource.indexOf('\n}', at)].filter((i) => i > -1)
  return appSource.slice(at, Math.min(...closes))
}

describe('all three pane lists read one list', () => {
  it('renders every mode from the same computed', () => {
    // Auto sidebar, Spotlight strip, fullscreen PiP. Three shapes, one list —
    // otherwise ancestry has to be threaded through three places and they
    // drift.
    const uses = appSource.match(/v-for="p in auxiliaryListPanes"/g) ?? []
    expect(uses).toHaveLength(3)
    expect(appSource).not.toContain(
      'v-for="p in paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id))"'
    )
  })

  it('walks the same list for shift-range as it renders', () => {
    // These used to be two sequences: flat pane order on screen, lineage order
    // for the range. What the eye saw and what a range covered disagreed.
    expect(appSource).toContain(
      'const auxiliaryListOrderedIds = computed<string[]>(() => auxiliaryListPanes.value.map((v) => v.id))'
    )
  })

  it('counts the empty state from the same list too', () => {
    expect(appSource).toContain('v-if="auxiliaryListPanes.length === 0"')
  })
})

describe('the tree these lists read', () => {
  it('has nothing folded away', () => {
    // The sidebar tree drops a folded family's children — that is what makes a
    // range there skip what the eye cannot see. These lists have no caret, so
    // borrowing that copy would let folding a family in the sidebar erase its
    // panes from a surface with no way to bring them back.
    expect(appSource).toContain('const paneListLineage = computed<PaneLineageRow[]>(() =>')
    expect(appSource).toContain('buildPaneLineage(panes.value, NOTHING_FOLDED)')
    expect(bodyOf('const paneListLineage = computed<PaneLineageRow[]>(() =>')).not.toContain('collapsedPanes')
  })

  it('is structure only — no live status in it', () => {
    // Reading paneViews here would rebuild the tree on every 400ms status sync.
    expect(bodyOf('const paneListLineage = computed<PaneLineageRow[]>(() =>')).not.toContain('paneViews')
  })
})

describe('closing a family in place', () => {
  it('starts with every family open', () => {
    // A pane you cannot see is a pane you forget is running, and for some
    // modes this list is the only place one shows at all.
    expect(appSource).toContain('const paneListCollapsed = ref(new Set<string>())')
  })

  it('keeps what is closed in the window, not on disk', () => {
    // Pane ids are reissued on every restart, so a stored one points at nobody.
    expect(bodyOf('const paneListCollapsed = ref(new Set<string>())')).not.toContain('settingsSet')
  })

  it('hides a row when anything above it has been closed', () => {
    // Closing a parent takes its whole subtree with it, one level at a time.
    const body = bodyOf('const auxiliaryListPanes = computed(() => {')
    expect(body).toContain('r.ancestors.some((id) => closed.has(id))')
  })

  it('replaces the Set rather than mutating it', () => {
    // Vue does not track adds and deletes on a Set held in a ref, so mutating
    // would leave the lists showing the old shape.
    const body = bodyOf('function togglePaneFamily(rootId: string): void {')
    expect(body).toContain('const next = new Set(paneListCollapsed.value)')
    expect(body).toContain('paneListCollapsed.value = next')
  })
})

describe('what a card shows', () => {
  it('spells out ancestry instead of indenting it', () => {
    expect(appSource).toContain('class="pane-list-src"')
    expect(appSource).toContain('↳ {{ paneListTrail(p.ancestors) }}')
  })

  it('gives the open/close control its own click target', () => {
    // The card itself still focuses the pane; only this control opens a family.
    expect(appSource).toContain('@click.stop="togglePaneFamily(p.id)"')
  })

  it('shows the count as a number, with the wording on hover', () => {
    // "3 descendants" wraps a narrow card and pushes the status badge off the
    // row. The control's title still spells it out.
    expect(appSource).toContain('<span class="pane-list-kids-count">{{ p.descendantCount }}</span>')
    expect(appSource).toContain(":title=\"$t('label.descendant-count', { count: p.descendantCount })\"")
  })

  it('shows the dots only while the family is closed', () => {
    // Open — the default — the children are right underneath, so dots would
    // only repeat them. Closed, they are what stands in for the hidden rows.
    expect(appSource).toContain('<template v-if="!p.expanded">')
    expect(appSource).toContain("{{ p.expanded ? '▾' : '▸' }}")
  })

  it('keeps the strip from acting as a reorder drop zone', () => {
    // The whole card is a drop target; without this the strip would light up
    // as a place to drop a pane, which it is not.
    const strip = appSource.slice(appSource.indexOf('class="pane-list-kids"'))
    expect(strip.slice(0, 600)).toContain('@dragover.stop')
  })

  it('orders the dots by the tree, never by status', () => {
    // Sorting by status would make the strip rearrange itself every time a
    // pane started or stopped.
    const body = bodyOf('function paneListFamilyDots(rootId: string)')
    expect(body).toContain('for (const row of paneListLineage.value)')
    expect(body).not.toContain('.sort(')
  })
})
