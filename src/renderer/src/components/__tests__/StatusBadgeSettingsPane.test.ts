// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A real settings store, so the pane is exercised end to end: a click writes,
// the write comes back through the composable, and the row repaints. The only
// thing stubbed is the transport underneath.
const h = vi.hoisted(() => ({ store: new Map<string, unknown>() }))

vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) =>
    h.store.has(key) ? h.store.get(key) : fallback,
  settingsSet: (key: string, value: unknown) => {
    h.store.set(key, value)
  },
  onSettingsChanged: () => () => {},
}))

import { i18n } from '@navide/plugin-ui/foundation'

import StatusBadgeSettingsPane from '../StatusBadgeSettingsPane.vue'
import {
  DEFAULT_STATUS_COLORS,
  PANE_STATUS_ORDER,
  STATUS_COLOR_KEYS,
} from '../../lib/statusBadgePalette'
import {
  __reloadStatusBadgePrefsForTest,
  resetAllStatusBadgePrefs,
} from '../../composables/useStatusBadgePrefs'

// This is the one surface in the feature that cannot be checked by reading
// source: everything else is a CSS rule or a resolver. Mounting it is also the
// closest thing to the manual pass, which the user does by hand.
function mountPane(): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(StatusBadgeSettingsPane as any, { global: { plugins: [i18n] } })
}

describe('StatusBadgeSettingsPane', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    resetAllStatusBadgePrefs()
    h.store.clear()
    __reloadStatusBadgePrefsForTest()
  })

  it('lists every status, once', () => {
    wrapper = mountPane()
    expect(wrapper.findAll('.sb-row')).toHaveLength(PANE_STATUS_ORDER.length)
  })

  it('offers the whole palette on every row', () => {
    wrapper = mountPane()
    const row = wrapper.findAll('.sb-row')[0]
    expect(row.findAll('.sb-swatch')).toHaveLength(STATUS_COLOR_KEYS.length)
  })

  it('marks the current colour as the checked one', () => {
    wrapper = mountPane()
    const idleRow = wrapper.findAll('.sb-row')[PANE_STATUS_ORDER.indexOf('idle')]
    const on = idleRow.findAll('.sb-swatch').filter((s) => s.classes('is-on'))
    expect(on).toHaveLength(1)
    expect(on[0].attributes('title')).toBe(
      i18n.global.t(`statusBadges.color.${DEFAULT_STATUS_COLORS.idle}`)
    )
  })

  it('persists a colour pick and moves the selection', async () => {
    wrapper = mountPane()
    const idleIndex = PANE_STATUS_ORDER.indexOf('idle')
    const row = () => wrapper!.findAll('.sb-row')[idleIndex]
    const target = STATUS_COLOR_KEYS.indexOf('cyan')

    await row().findAll('.sb-swatch')[target].trigger('click')

    expect(JSON.parse(String(h.store.get('agentTeam.statusBadges')))).toEqual({
      idle: { color: 'cyan' },
    })
    expect(row().findAll('.sb-swatch')[target].classes()).toContain('is-on')
  })

  it('persists a renamed label per language', async () => {
    wrapper = mountPane()
    const row = wrapper.findAll('.sb-row')[PANE_STATUS_ORDER.indexOf('idle')]
    const [zh, en] = row.findAll('.sb-field input')

    await zh.setValue('待命')
    await zh.trigger('change')
    await en.setValue('Ready')
    await en.trigger('change')

    expect(JSON.parse(String(h.store.get('agentTeam.statusBadges')))).toEqual({
      idle: { labelZh: '待命', labelEn: 'Ready' },
    })
  })

  it('previews the row with the name the badge will actually show', async () => {
    wrapper = mountPane()
    const idleIndex = PANE_STATUS_ORDER.indexOf('idle')
    const row = () => wrapper!.findAll('.sb-row')[idleIndex]

    // Before: the shipped translation, which is what an untouched badge reads.
    expect(row().find('.sb-preview').text()).toBe(
      i18n.global.t('paneStatus.idle', {}, { locale: 'zh-TW' })
    )

    const zh = row().findAll('.sb-field input')[0]
    await zh.setValue('待命')
    await zh.trigger('change')
    expect(row().find('.sb-preview').text()).toBe('待命')
  })

  it('shows the placeholder as the translated default, so a blank field is not a blank badge', () => {
    wrapper = mountPane()
    const row = wrapper.findAll('.sb-row')[PANE_STATUS_ORDER.indexOf('idle')]
    const [zh, en] = row.findAll('.sb-field input')
    expect(zh.attributes('placeholder')).toBe(
      i18n.global.t('paneStatus.idle', {}, { locale: 'zh-TW' })
    )
    expect(en.attributes('placeholder')).toBe(
      i18n.global.t('paneStatus.idle', {}, { locale: 'en-US' })
    )
  })

  it('enables the per-row reset only for a customized row', async () => {
    wrapper = mountPane()
    const idleIndex = PANE_STATUS_ORDER.indexOf('idle')
    const row = () => wrapper!.findAll('.sb-row')[idleIndex]

    expect(row().find('.sb-reset').attributes('disabled')).toBeDefined()
    expect(row().attributes('data-customized')).toBe('no')

    await row().findAll('.sb-swatch')[STATUS_COLOR_KEYS.indexOf('pink')].trigger('click')
    expect(row().find('.sb-reset').attributes('disabled')).toBeUndefined()
    expect(row().attributes('data-customized')).toBe('yes')

    await row().find('.sb-reset').trigger('click')
    expect(row().attributes('data-customized')).toBe('no')
    expect(JSON.parse(String(h.store.get('agentTeam.statusBadges')))).toEqual({})
  })

  it('resets everything from the footer, and only offers it when there is something to reset', async () => {
    wrapper = mountPane()
    const all = () => wrapper!.find('.sb-reset-all')
    expect(all().attributes('disabled')).toBeDefined()

    const rows = wrapper.findAll('.sb-row')
    await rows[0].findAll('.sb-swatch')[STATUS_COLOR_KEYS.indexOf('pink')].trigger('click')
    await rows[2].findAll('.sb-swatch')[STATUS_COLOR_KEYS.indexOf('cyan')].trigger('click')
    expect(all().attributes('disabled')).toBeUndefined()

    await all().trigger('click')
    expect(wrapper.findAll('.sb-row[data-customized="yes"]')).toHaveLength(0)
    expect(all().attributes('disabled')).toBeDefined()
  })

  it('marks the two statuses a pane cannot report itself', () => {
    // Otherwise they read as badges the user will never see and cannot explain.
    wrapper = mountPane()
    const rows = wrapper.findAll('.sb-row')
    const flagged = rows.filter((r) => r.find('.sb-rowonly').exists())
    expect(flagged).toHaveLength(2)
    expect(rows[PANE_STATUS_ORDER.indexOf('waiting')].find('.sb-rowonly').exists()).toBe(true)
    expect(rows[PANE_STATUS_ORDER.indexOf('disconnected')].find('.sb-rowonly').exists()).toBe(true)
  })

  it('explains when every status appears', () => {
    wrapper = mountPane()
    for (const row of wrapper.findAll('.sb-row')) {
      expect(row.find('.sb-when').text().trim()).not.toBe('')
    }
  })
})
