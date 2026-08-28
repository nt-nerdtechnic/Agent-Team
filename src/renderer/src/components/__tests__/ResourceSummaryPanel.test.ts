// @vitest-environment happy-dom
// ResourceSummaryPanel (the status-bar CPU + memory card) — what it shows, what
// it refuses to claim when a measurement is missing, and the two actions.
//
// It replaced two popovers, so the assertions that mattered in each are here:
// the memory panel's "never print a zero you did not measure", and the agent
// list's status vocabulary and jump.
import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ResourceSummaryPanel, { type ResourceSummaryRow } from '../ResourceSummaryPanel.vue'
import { useStatusBarPopover } from '../../composables/useStatusBarPopover'

const MB = 1024 * 1024

function rows(...over: Array<Partial<ResourceSummaryRow>>): ResourceSummaryRow[] {
  return over.map((o, i) => ({
    paneId: `pane-${i}`,
    measuredKey: `sess-${i}`,
    name: `Pane ${i}`,
    vendor: '',
    foreignWorkspace: '',
    status: 'idle' as const,
    bytes: 100 * MB,
    cpuPercent: 1,
    reclaimable: false,
    ...o,
  }))
}

function mountPanel(
  props: Partial<{
    rows: ResourceSummaryRow[]
    measured: boolean
    available: boolean
    cpuAvailable: boolean
    cpuShare: number | null
    memoryShare: number | null
    totalBytes: number
    totalCpuPercent: number | null
  }> = {}
): VueWrapper {
  return mount(ResourceSummaryPanel, {
    props: {
      rows: rows({}, {}),
      measured: true,
      available: true,
      cpuAvailable: true,
      cpuShare: 10,
      memoryShare: 20,
      totalBytes: 200 * MB,
      totalCpuPercent: 40,
      ...props,
    },
    global: { plugins: [i18n] },
  })
}

describe('ResourceSummaryPanel', () => {
  it('headlines the totals for both metrics', () => {
    const w = mountPanel({ totalCpuPercent: 42.1, totalBytes: 4_200 * MB })
    expect(w.get('[data-card="cpu"] [data-part="value"]').text()).toBe('42.1%')
    expect(w.get('[data-card="memory"] [data-part="value"]').text()).toBe('4.1 GB')
    w.unmount()
  })

  // The per-pane figure is relative to one core; the card answers the other
  // question — how much of this machine.
  it('states the machine share next to each total', () => {
    const w = mountPanel({ cpuShare: 4.2, memoryShare: 26 })
    expect(w.get('[data-card="cpu"]').text()).toContain('4.2%')
    expect(w.get('[data-card="memory"]').text()).toContain('26%')
    w.unmount()
  })

  it('says the share is unknown rather than drawing a made-up bar', () => {
    const w = mountPanel({ cpuShare: null, memoryShare: null })
    expect(w.get('[data-card="cpu"]').text()).toContain(
      i18n.global.t('resource.machine-share-unknown')
    )
    expect(w.get('[data-card="cpu"] .rs-bar i').attributes('style')).toContain('width: 0%')
    w.unmount()
  })

  // The card exists to surface the outlier, so the busiest pane is on top and a
  // pane whose CPU is not yet known is not mistaken for a quiet one.
  it('lists the busiest three, unknown CPU last', () => {
    const w = mountPanel({
      rows: rows(
        { name: 'Quiet', cpuPercent: 0.2 },
        { name: 'Unknown', cpuPercent: null },
        { name: 'Busy', cpuPercent: 42 },
        { name: 'Middling', cpuPercent: 5 }
      ),
    })
    const names = w.findAll('[data-row="pane"] .rs-name').map((n) => n.text())
    expect(names).toEqual(['Busy', 'Middling', 'Quiet'])
    w.unmount()
  })

  // Showing an unmeasured pane as 0 reads as "this one is free", which is the
  // opposite of what a failed sweep means.
  it('hides sizes and says so when the platform cannot measure', () => {
    const w = mountPanel({ available: false })
    expect(w.get('[data-card="memory"] [data-part="value"]').text()).toBe('—')
    expect(w.text()).toContain(i18n.global.t('resource.unavailable'))
    w.unmount()
  })

  it('dashes the CPU column when CPU cannot be measured', () => {
    const w = mountPanel({ cpuAvailable: false })
    expect(w.get('[data-card="cpu"] [data-part="value"]').text()).toBe('—')
    expect(w.get('[data-row="pane"] [data-part="cpu"]').text()).toBe('—')
    w.unmount()
  })

  // The first tick after opening has nothing to difference against.
  it('dashes a pane whose CPU is not knowable yet', () => {
    const w = mountPanel({ rows: rows({ cpuPercent: null }) })
    expect(w.get('[data-row="pane"] [data-part="cpu"]').text()).toBe('—')
    w.unmount()
  })

  it('shows a placeholder instead of a size while the first sweep is in flight', () => {
    const w = mountPanel({ measured: false })
    expect(w.get('[data-card="memory"] [data-part="value"]').text()).toBe('…')
    w.unmount()
  })

  it('carries the status vocabulary the agent list used', () => {
    const w = mountPanel({
      rows: rows({ status: 'running' }, { status: 'awaiting' }, { status: 'waiting' }),
    })
    const statuses = w.findAll('[data-row="pane"]').map((r) => r.attributes('data-status'))
    expect(statuses).toEqual(['running', 'awaiting', 'waiting'])
    w.unmount()
  })

  // Two panes named the same in two projects are indistinguishable without it.
  it('puts the vendor and foreign workspace in the row title', () => {
    const w = mountPanel({
      rows: rows({ name: 'Fix the build', vendor: 'Codex', foreignWorkspace: 'other-repo' }),
    })
    const title = w.get('[data-row="pane"]').attributes('title') ?? ''
    expect(title).toContain('Fix the build')
    expect(title).toContain('Codex')
    expect(title).toContain('other-repo')
    w.unmount()
  })

  it('names the count on the reclaim button and emits on click', async () => {
    const w = mountPanel({ rows: rows({ reclaimable: true }, { reclaimable: true }, {}) })
    const btn = w.get('[data-act="reclaim"]')
    expect(btn.text()).toContain('2')
    await btn.trigger('click')
    expect(w.emitted('reclaim')).toHaveLength(1)
    w.unmount()
  })

  it('disables the reclaim button when nothing qualifies', () => {
    const w = mountPanel({ rows: rows({}, {}) })
    expect(w.get('[data-act="reclaim"]').attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('opens the full window from its own button', async () => {
    const w = mountPanel()
    await w.get('[data-act="open-window"]').trigger('click')
    expect(w.emitted('openWindow')).toHaveLength(1)
    w.unmount()
  })

  it('jumps to a pane when its row is clicked', async () => {
    const w = mountPanel({ rows: rows({ paneId: 'pane-x' }) })
    await w.get('[data-row="pane"]').trigger('click')
    expect(w.emitted('jump')?.[0]).toEqual(['pane-x'])
    w.unmount()
  })

  it('says so when the window has no live CLI', () => {
    const w = mountPanel({ rows: [] })
    expect(w.get('[data-row="empty"]').text()).toBe(i18n.global.t('resource.no-panes'))
    w.unmount()
  })

  it('closes on Escape, the backdrop and the close button', async () => {
    const w = mountPanel()
    await w.get('.rs-backdrop').trigger('click')
    await w.get('[data-act="close"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toHaveLength(3)
    w.unmount()
  })

  it('stops listening for Escape once unmounted', () => {
    const w = mountPanel()
    w.unmount()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toBeUndefined()
  })

  it('renders no untranslated i18n keys in either locale', () => {
    for (const locale of ['zh-TW', 'en-US'] as const) {
      i18n.global.locale.value = locale
      const w = mountPanel({ rows: rows({ reclaimable: true }) })
      expect(w.text()).not.toMatch(/resource\.[a-z-]+/)
      w.unmount()
    }
    i18n.global.locale.value = 'en-US'
  })
})

// The pill lives on the left of the status bar; a card that opens on the far
// side of the screen from what was clicked reads as a different control
// answering.
describe('ResourceSummaryPanel anchoring', () => {
  it('opens against the left edge, where its trigger is', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/renderer/src/components/ResourceSummaryPanel.vue', 'utf8')
    )
    const card = source.slice(source.indexOf('.rs-pop {'), source.indexOf('.rs-head {'))
    expect(card).toContain('left: 8px')
    expect(card).not.toContain('right: 8px')
  })
})

describe('useStatusBarPopover — the resource popover joins the exclusive set', () => {
  it('closes whichever popover was open when the resource one opens', () => {
    const { openPopover, toggle, close } = useStatusBarPopover()

    toggle('clock')
    expect(openPopover.value).toBe('clock')

    toggle('resource')
    expect(openPopover.value).toBe('resource')

    // …and opening another one closes the resource popover in turn.
    toggle('announcements')
    expect(openPopover.value).toBe('announcements')

    toggle('resource')
    toggle('resource')
    expect(openPopover.value).toBeNull()

    toggle('resource')
    close()
    expect(openPopover.value).toBeNull()
  })
})
