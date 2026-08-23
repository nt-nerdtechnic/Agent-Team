// @vitest-environment happy-dom
// MemoryPanel (the status-bar memory popover) — what it shows, what it refuses
// to claim when the measurement is missing, and the reclaim button's states.
import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '../../i18n'
import MemoryPanel, { type MemoryPaneRow } from '../MemoryPanel.vue'

const MB = 1024 * 1024

function rows(...over: Array<Partial<MemoryPaneRow>>): MemoryPaneRow[] {
  return over.map((o, i) => ({
    paneId: `pane-${i}`,
    title: `Pane ${i}`,
    bytes: 100 * MB,
    reclaimable: false,
    ...o,
  }))
}

function mountPanel(props: Partial<{
  rows: MemoryPaneRow[]
  measured: boolean
  available: boolean
}> = {}): VueWrapper {
  return mount(MemoryPanel, {
    props: {
      rows: rows({}, {}),
      measured: true,
      available: true,
      ...props,
    },
    global: { plugins: [i18n] },
  })
}

describe('MemoryPanel', () => {
  it('lists every pane with its measured size', () => {
    const w = mountPanel({ rows: rows({ title: 'Alpha', bytes: 300 * MB }, { title: 'Beta', bytes: 150 * MB }) })
    const text = w.text()
    expect(text).toContain('Alpha')
    expect(text).toContain('300 MB')
    expect(text).toContain('Beta')
    expect(text).toContain('150 MB')
    w.unmount()
  })

  // The list is a place to look for what to reclaim, and the order that serves
  // is by what it would give back.
  it('sorts biggest first', () => {
    const w = mountPanel({
      rows: rows({ title: 'Small', bytes: 50 * MB }, { title: 'Huge', bytes: 900 * MB }),
    })
    const names = w.findAll('.mem-name').map((n) => n.text())
    expect(names).toEqual(['Huge', 'Small'])
    w.unmount()
  })

  it('totals the panes it was given', () => {
    const w = mountPanel({ rows: rows({ bytes: 200 * MB }, { bytes: 300 * MB }) })
    expect(w.find('[data-row="total"]').text()).toContain('500 MB')
    w.unmount()
  })

  it('counts and sizes only the reclaimable ones on its own row', () => {
    const w = mountPanel({
      rows: rows(
        { bytes: 400 * MB, reclaimable: false },
        { bytes: 250 * MB, reclaimable: true },
      ),
    })
    const line = w.find('[data-row="reclaimable"]').text()
    expect(line).toContain('1')
    expect(line).toContain('250 MB')
    w.unmount()
  })

  // Showing an unmeasured pane as "0 B" reads as "this one is free", which is
  // the opposite of true — it is the one we could not measure.
  it('shows a placeholder instead of a size while the sweep is in flight', () => {
    const w = mountPanel({ measured: false })
    expect(w.find('[data-row="total"]').text()).toContain('…')
    expect(w.text()).not.toContain('0 B')
    w.unmount()
  })

  it('hides sizes and says so when the platform cannot measure', () => {
    const w = mountPanel({ available: false })
    expect(w.find('[data-row="total"]').text()).toContain('—')
    expect(w.text()).toContain(i18n.global.t('memory.unavailable'))
    w.unmount()
  })

  it('disables the reclaim button when nothing qualifies', () => {
    const w = mountPanel({ rows: rows({ reclaimable: false }) })
    const btn = w.find('.mem-reclaim')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.text()).toBe(i18n.global.t('memory.reclaim-action-empty'))
    w.unmount()
  })

  // The button has to say what it is about to do: "reclaim" alone does not tell
  // you whether pressing it costs one pane or a dozen.
  it('names the count on the reclaim button and emits on click', async () => {
    const w = mountPanel({ rows: rows({ reclaimable: true }, { reclaimable: true }, { reclaimable: false }) })
    const btn = w.find('.mem-reclaim')
    expect(btn.text()).toContain('2')
    await btn.trigger('click')
    expect(w.emitted('reclaim')).toHaveLength(1)
    w.unmount()
  })

  it('marks which rows are reclaimable', () => {
    const w = mountPanel({ rows: rows({ reclaimable: true }, { reclaimable: false }) })
    const flags = w.findAll('li').map((li) => li.attributes('data-reclaimable'))
    expect(flags).toContain('true')
    expect(flags).toContain('false')
    w.unmount()
  })

  it('jumps to a pane when its row is clicked', async () => {
    const w = mountPanel({ rows: rows({ paneId: 'pane-x' }) })
    await w.find('.mem-jump').trigger('click')
    expect(w.emitted('jump')?.[0]).toEqual(['pane-x'])
    w.unmount()
  })

  it('closes on Escape and on the backdrop', async () => {
    const w = mountPanel()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toHaveLength(1)
    await w.find('.mem-backdrop').trigger('click')
    expect(w.emitted('close')).toHaveLength(2)
    w.unmount()
  })

  it('says so when the window has no live CLI', () => {
    const w = mountPanel({ rows: [] })
    expect(w.text()).toContain(i18n.global.t('memory.no-panes'))
    expect(w.find('.mem-reclaim').attributes('disabled')).toBeDefined()
    w.unmount()
  })
})
