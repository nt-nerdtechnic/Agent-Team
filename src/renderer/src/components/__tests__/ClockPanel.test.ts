// @vitest-environment happy-dom
// ClockPanel (the status-bar clock popover) — the five rows it renders, the
// duration/relative-time formatting behind two of them, the timezone offset
// string, and the single-open-popover rule the status bar now follows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '../../i18n'
import ClockPanel from '../ClockPanel.vue'
import { useStatusBarPopover } from '../../composables/useStatusBarPopover'

const NOW = Date.parse('2026-08-07T10:30:45.000Z')
const DAY_MS = 86_400_000
const BUILD_TAG = 'v0.1.77 @08/07 10:30'

function mountPanel(props: Partial<{
  now: number
  startedAt: number
  projectCreatedAt: string
  buildTag: string
}> = {}): VueWrapper {
  return mount(ClockPanel, {
    props: {
      now: NOW,
      startedAt: NOW - 3 * 3_600_000 - 21 * 60_000,
      projectCreatedAt: '2026-06-24T09:00:00.000Z',
      buildTag: BUILD_TAG,
      ...props,
    },
    global: { plugins: [i18n] },
  })
}

function row(wrapper: VueWrapper, name: string): string {
  return wrapper.get(`[data-row="${name}"] .ck-v`).text()
}

describe('ClockPanel', () => {
  let wrapper: VueWrapper | undefined
  const previousLocale = i18n.global.locale.value

  beforeEach(() => {
    // Pin the locale: the machine's navigator.language decides it otherwise,
    // and the Intl output asserted below is locale-specific.
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    i18n.global.locale.value = previousLocale
    vi.restoreAllMocks()
  })

  it('renders exactly the five information rows', () => {
    wrapper = mountPanel()

    expect(wrapper.findAll('.ck-row').map((el) => el.attributes('data-row'))).toEqual([
      'now',
      'timezone',
      'uptime',
      'project',
      'build',
    ])
    // The build stamp is labelled as a build time, not as another clock.
    expect(wrapper.get('[data-row="build"] .ck-k').text()).toBe(i18n.global.t('clock.build'))
    expect(row(wrapper, 'build')).toBe(BUILD_TAG)
  })

  it('shows the current time down to the second, and follows the parent tick', async () => {
    wrapper = mountPanel()
    const fmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'medium' })

    expect(row(wrapper, 'now')).toBe(fmt.format(new Date(NOW)))

    // No timer of its own: a new `now` prop is what advances the seconds.
    await wrapper.setProps({ now: NOW + 1000 })
    expect(row(wrapper, 'now')).toBe(fmt.format(new Date(NOW + 1000)))
  })

  it('names the timezone and its offset, including a negative one', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(300)
    wrapper = mountPanel()

    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(row(wrapper, 'timezone')).toBe(`${zone} (UTC-5)`)
  })

  it('keeps the minutes of a sub-hour negative offset', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(210)
    wrapper = mountPanel()

    expect(row(wrapper, 'timezone')).toContain('UTC-3:30')
  })

  it('renders a positive offset with a plus sign', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480)
    wrapper = mountPanel()

    expect(row(wrapper, 'timezone')).toContain('UTC+8')
  })

  it('formats uptime as hours and minutes', () => {
    wrapper = mountPanel()

    expect(row(wrapper, 'uptime')).toBe(
      `${i18n.global.t('clock.duration-hours', { count: 3 })} ${i18n.global.t('clock.duration-minutes', { count: 21 })}`
    )
  })

  it('says "less than a minute" instead of "0"', () => {
    wrapper = mountPanel({ startedAt: NOW - 59_000 })

    expect(row(wrapper, 'uptime')).toBe(i18n.global.t('clock.duration-less-than-minute'))
  })

  it('shows exactly one day as a bare day count', () => {
    wrapper = mountPanel({ startedAt: NOW - DAY_MS })

    expect(row(wrapper, 'uptime')).toBe(i18n.global.t('clock.duration-days', { count: 1 }))
  })

  it('drops minutes once the uptime is measured in days', () => {
    wrapper = mountPanel({ startedAt: NOW - DAY_MS - 5 * 3_600_000 - 30 * 60_000 })

    expect(row(wrapper, 'uptime')).toBe(
      `${i18n.global.t('clock.duration-days', { count: 1 })} ${i18n.global.t('clock.duration-hours', { count: 5 })}`
    )
  })

  it('pairs the project creation date with a relative form', () => {
    const created = new Date(NOW - 44 * DAY_MS)
    wrapper = mountPanel({ projectCreatedAt: created.toISOString() })

    const absolute = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(created)
    const relative = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' }).format(-44, 'day')
    expect(row(wrapper, 'project')).toBe(`${absolute} · ${relative}`)
  })

  it('says "today" rather than "0 days ago" for a project created today', () => {
    wrapper = mountPanel({ projectCreatedAt: new Date(NOW - 3_600_000).toISOString() })

    expect(row(wrapper, 'project')).toContain(
      new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' }).format(0, 'day')
    )
  })

  it('says no project is open instead of showing an invalid date', () => {
    wrapper = mountPanel({ projectCreatedAt: '' })

    expect(row(wrapper, 'project')).toBe(i18n.global.t('clock.project-unknown'))
    expect(row(wrapper, 'project')).not.toContain('Invalid')
  })

  it('closes on the backdrop, the close button and Escape', async () => {
    wrapper = mountPanel()

    await wrapper.get('.ck-backdrop').trigger('click')
    await wrapper.get('[data-act="close"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('close')).toHaveLength(3)
  })

  it('stops listening for Escape once unmounted', () => {
    wrapper = mountPanel()
    const panel = wrapper
    wrapper = undefined
    panel.unmount()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(panel.emitted('close')).toBeUndefined()
  })

  it('renders no untranslated i18n keys', () => {
    wrapper = mountPanel()

    expect(wrapper.text()).not.toContain('clock.')
    // html() also covers the keys that only reach `title` attributes.
    expect(wrapper.html()).not.toContain('clock.')
  })
})

describe('useStatusBarPopover', () => {
  it('opens one popover at a time', () => {
    const { openPopover, toggle, close } = useStatusBarPopover()

    expect(openPopover.value).toBeNull()

    toggle('backend')
    expect(openPopover.value).toBe('backend')

    // Opening another closes the first — the three status-bar popovers overlap.
    toggle('announcements')
    expect(openPopover.value).toBe('announcements')

    toggle('clock')
    expect(openPopover.value).toBe('clock')

    // Clicking the same trigger again is still a toggle.
    toggle('clock')
    expect(openPopover.value).toBeNull()

    toggle('backend')
    close()
    expect(openPopover.value).toBeNull()
  })
})
