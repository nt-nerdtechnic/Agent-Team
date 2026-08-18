// @vitest-environment happy-dom
// AgentOverviewPanel (the status-bar "N agents" popover) — one row per pane,
// the status variants it renders, the jump it emits, and the single-open rule
// the status bar follows.
//
// The row that matters most is the unrealized cold-restore placeholder: it
// still renders and still emits a jump (App.vue's handler routes it through
// selectPane(userInitiated) so the placeholder is realized). Dropping it, or
// rendering it as a no-op row, is the failure mode this pins.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '../../i18n'
import AgentOverviewPanel, { type AgentOverviewRow } from '../AgentOverviewPanel.vue'
import { useStatusBarPopover } from '../../composables/useStatusBarPopover'

function makeRow(overrides: Partial<AgentOverviewRow> = {}): AgentOverviewRow {
  return {
    paneId: 'pane-1',
    name: 'Architect',
    vendor: 'Claude Code',
    status: 'idle',
    foreignWorkspace: '',
    ...overrides,
  }
}

function mountPanel(rows: AgentOverviewRow[]): VueWrapper {
  return mount(AgentOverviewPanel, { props: { rows }, global: { plugins: [i18n] } })
}

// Listed by hand so the assertions stay readable, then checked against the
// union below — this list used to silently omit 'awaiting', so the coverage
// test claimed to render "every status variant" while two went unchecked and,
// in the i18n test, unverified for translation.
const ALL_STATUSES = [
  'running',
  'idle',
  'awaiting',
  'starting',
  'stopped',
  'exited',
  'error',
  'waiting',
  'disconnected',
] as const satisfies readonly AgentOverviewRow['status'][]

// Compile-time exhaustiveness: a new status that is not listed above makes
// `Missing` that literal instead of never, and `true` stops being assignable —
// the build fails naming exactly what was forgotten.
type MissingStatus = Exclude<AgentOverviewRow['status'], (typeof ALL_STATUSES)[number]>
const _allStatusesCovered: MissingStatus extends never ? true : MissingStatus = true

describe('AgentOverviewPanel', () => {
  let wrapper: VueWrapper | undefined
  const previousLocale = i18n.global.locale.value

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    i18n.global.locale.value = previousLocale
  })

  it('renders one row per pane, in order, with name and vendor', () => {
    wrapper = mountPanel([
      makeRow({ paneId: 'a', name: 'Architect', vendor: 'Claude Code' }),
      makeRow({ paneId: 'b', name: 'Reviewer', vendor: 'Codex' }),
    ])

    const rows = wrapper.findAll('[data-row="pane"]')
    expect(rows.map((el) => el.attributes('data-pane'))).toEqual(['a', 'b'])
    expect(rows[0].text()).toContain('Architect')
    expect(rows[0].text()).toContain('Claude Code')
    expect(rows[1].text()).toContain('Reviewer')
    expect(rows[1].text()).toContain('Codex')
  })

  it('renders every status variant with its own label and data-status', () => {
    const statuses = ALL_STATUSES
    expect(_allStatusesCovered).toBe(true)

    wrapper = mountPanel(statuses.map((status, i) => makeRow({ paneId: `p${i}`, status })))

    const rows = wrapper.findAll('[data-row="pane"]')
    expect(rows.map((el) => el.attributes('data-status'))).toEqual([...statuses])
    for (const [i, status] of statuses.entries()) {
      expect(rows[i].get('[data-part="status"]').text()).toBe(
        i18n.global.t(`agentOverview.status-${status}`)
      )
    }
  })

  it('emits the jump with the clicked pane id', async () => {
    wrapper = mountPanel([makeRow({ paneId: 'a' }), makeRow({ paneId: 'b' })])

    await wrapper.get('[data-pane="b"]').trigger('click')

    expect(wrapper.emitted('jump')).toEqual([['b']])
  })

  it('keeps an unrealized placeholder pane jumpable', async () => {
    wrapper = mountPanel([makeRow({ paneId: 'cold', status: 'waiting' })])

    const row = wrapper.get('[data-pane="cold"]')
    expect(row.attributes('disabled')).toBeUndefined()

    await row.trigger('click')
    expect(wrapper.emitted('jump')).toEqual([['cold']])
  })

  it('shows a foreign workspace only when the pane has one', () => {
    wrapper = mountPanel([
      makeRow({ paneId: 'a', foreignWorkspace: '' }),
      makeRow({ paneId: 'b', foreignWorkspace: 'other-repo' }),
    ])

    expect(wrapper.get('[data-pane="a"]').find('[data-part="workspace"]').exists()).toBe(false)
    expect(wrapper.get('[data-pane="b"]').get('[data-part="workspace"]').text()).toBe('other-repo')
  })

  // An unnamed pane's display name IS the vendor label (agentLabel is assigned
  // spec.label at creation), so App.vue blanks `vendor` on that path. Rendering
  // it anyway printed "Claude Code   Claude Code" on every default pane.
  it('omits the vendor when App.vue blanked it as a duplicate of the name', () => {
    wrapper = mountPanel([
      makeRow({ paneId: 'a', name: 'Claude Code', vendor: '' }),
      makeRow({ paneId: 'b', name: 'Reviewer', vendor: 'Codex' }),
    ])

    // Selected by class, not by the data-part hook: the hook is new, so a
    // data-part assertion would pass even against the unconditional span this
    // replaced. `.ao-vendor` existed before the fix (rendering an empty string),
    // so its absence is what actually discriminates.
    const unnamed = wrapper.get('[data-pane="a"]')
    expect(unnamed.find('.ao-vendor').exists()).toBe(false)
    expect(unnamed.text()).not.toMatch(/Claude Code[\s\S]*Claude Code/)
    expect(wrapper.get('[data-pane="b"]').get('.ao-vendor').text()).toBe('Codex')
  })

  it('says so when there are no panes', () => {
    wrapper = mountPanel([])

    expect(wrapper.findAll('[data-row="pane"]')).toHaveLength(0)
    expect(wrapper.get('[data-row="empty"]').text()).toBe(i18n.global.t('agentOverview.empty'))
  })

  it('closes on the backdrop, the close button and Escape', async () => {
    wrapper = mountPanel([makeRow()])

    await wrapper.get('.ao-backdrop').trigger('click')
    await wrapper.get('[data-act="close"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('close')).toHaveLength(3)
  })

  it('stops listening for Escape once unmounted', () => {
    wrapper = mountPanel([makeRow()])
    const panel = wrapper
    wrapper = undefined
    panel.unmount()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(panel.emitted('close')).toBeUndefined()
  })

  it('renders no untranslated i18n keys in either locale', () => {
    for (const locale of ['en-US', 'zh-TW'] as const) {
      i18n.global.locale.value = locale
      // Every status, not a sample: a status whose label key is missing falls
      // back to rendering the raw key, and that only shows if it is mounted.
      const panel = mountPanel(ALL_STATUSES.map((status, i) => makeRow({ paneId: `p${i}`, status })))
      expect(panel.text()).not.toContain('agentOverview.')
      // html() also covers the keys that only reach `title` attributes.
      expect(panel.html()).not.toContain('agentOverview.')
      panel.unmount()
    }
  })
})

describe('useStatusBarPopover — the agents popover joins the exclusive set', () => {
  it('closes whichever popover was open when the agents one opens', () => {
    const { openPopover, toggle, close } = useStatusBarPopover()

    toggle('clock')
    expect(openPopover.value).toBe('clock')

    toggle('agents')
    expect(openPopover.value).toBe('agents')

    // …and opening another one closes the agents popover in turn.
    toggle('announcements')
    expect(openPopover.value).toBe('announcements')

    toggle('agents')
    toggle('agents')
    expect(openPopover.value).toBeNull()

    toggle('agents')
    close()
    expect(openPopover.value).toBeNull()
  })
})
