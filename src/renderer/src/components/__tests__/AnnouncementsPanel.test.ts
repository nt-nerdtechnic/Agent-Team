// @vitest-environment happy-dom
// AnnouncementsPanel (the status-bar announcements popover) — row ordering,
// expansion marking an item read, the status-dependent update actions, the
// empty state and the dismissal paths. The feed is a prop, so every assertion
// is on what the component renders and emits.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import AnnouncementsPanel from '../AnnouncementsPanel.vue'
import type { Announcement } from '../../composables/useAnnouncements'
import { i18n } from '../../i18n'

function release(version: string, read = false): Announcement {
  return {
    id: `release:${version}`,
    kind: 'release',
    version,
    title: `Release ${version}`,
    highlights: [`highlight for ${version}`],
    note: `note for ${version}`,
    read,
  }
}

function update(action?: 'download' | 'install'): Announcement {
  return {
    id: 'update:0.1.78',
    kind: 'update',
    version: '0.1.78',
    title: 'A new version is available',
    highlights: ['Fixes things'],
    createdAt: Date.parse('2026-08-07T10:00:00.000Z'),
    read: false,
    action,
  }
}

function mountPanel(items: Announcement[]): VueWrapper {
  return mount(AnnouncementsPanel, { props: { items }, global: { plugins: [i18n] } })
}

function rowIds(wrapper: VueWrapper): (string | undefined)[] {
  return wrapper.findAll('[data-ann-id]').map((el) => el.attributes('data-ann-id'))
}

describe('AnnouncementsPanel', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('renders the feed in the order it is given, unread rows flagged', () => {
    wrapper = mountPanel([update('download'), release('0.1.77'), release('0.1.76', true)])

    expect(rowIds(wrapper)).toEqual(['update:0.1.78', 'release:0.1.77', 'release:0.1.76'])
    // The unread dot is per row: the read one has none.
    expect(wrapper.findAll('.an-dot')).toHaveLength(2)
    expect(wrapper.get('[data-ann-id="release:0.1.76"]').classes()).not.toContain('unread')
    expect(wrapper.get('[data-ann-id="update:0.1.78"]').attributes('data-ann-kind')).toBe('update')
  })

  it('expands a row to show its highlights and note, and marks it read', async () => {
    wrapper = mountPanel([release('0.1.77'), release('0.1.76')])

    expect(wrapper.findAll('.an-detail')).toHaveLength(0)

    await wrapper.get('[data-ann-id="release:0.1.77"]').trigger('click')
    const detail = wrapper.get('[data-ann-id="release:0.1.77"] .an-detail')
    expect(detail.text()).toContain('highlight for 0.1.77')
    expect(detail.text()).toContain('note for 0.1.77')
    expect(wrapper.emitted('read')).toEqual([['release:0.1.77']])

    // Only one row expands at a time, and collapsing doesn't re-emit.
    await wrapper.get('[data-ann-id="release:0.1.76"]').trigger('click')
    expect(rowIds(wrapper)).toHaveLength(2)
    expect(wrapper.findAll('.an-detail')).toHaveLength(1)
    await wrapper.get('[data-ann-id="release:0.1.76"]').trigger('click')
    expect(wrapper.findAll('.an-detail')).toHaveLength(0)
    expect(wrapper.emitted('read')).toEqual([['release:0.1.77'], ['release:0.1.76']])
  })

  it('does not re-emit read for an already-read row', async () => {
    wrapper = mountPanel([release('0.1.77', true)])

    await wrapper.get('[data-ann-id="release:0.1.77"]').trigger('click')
    expect(wrapper.findAll('.an-detail')).toHaveLength(1)
    expect(wrapper.emitted('read')).toBeUndefined()
  })

  it('offers the update action matching the status, and only for update rows', async () => {
    wrapper = mountPanel([update('download'), release('0.1.77')])
    expect(wrapper.findAll('[data-act="install"]')).toHaveLength(0)
    await wrapper.get('[data-act="download"]').trigger('click')
    expect(wrapper.emitted('download')).toHaveLength(1)
    // Acting on the row must not also toggle it open.
    expect(wrapper.findAll('.an-detail')).toHaveLength(0)

    wrapper.unmount()
    wrapper = mountPanel([update('install')])
    expect(wrapper.findAll('[data-act="download"]')).toHaveLength(0)
    await wrapper.get('[data-act="install"]').trigger('click')
    expect(wrapper.emitted('install')).toHaveLength(1)

    wrapper.unmount()
    wrapper = mountPanel([update()])
    expect(wrapper.findAll('.an-acts')).toHaveLength(0)
  })

  it('pages the feed behind a load-more button instead of rendering it all', async () => {
    // 20 releases: the first page shows 8, then each click reveals 8 more.
    const feed = Array.from({ length: 20 }, (_, i) => release(`0.1.${80 - i}`))
    wrapper = mountPanel(feed)

    expect(rowIds(wrapper)).toHaveLength(8)
    expect(rowIds(wrapper)[0]).toBe('release:0.1.80')
    // The label carries the remaining count, and is a real translation.
    expect(wrapper.get('[data-act="load-more"]').text()).toBe(
      i18n.global.t('announce.load-more', { count: 12 }),
    )
    expect(wrapper.get('[data-act="load-more"]').text()).not.toContain('announce.')

    await wrapper.get('[data-act="load-more"]').trigger('click')
    expect(rowIds(wrapper)).toHaveLength(16)

    await wrapper.get('[data-act="load-more"]').trigger('click')
    expect(rowIds(wrapper)).toHaveLength(20)
    // Nothing left to reveal, so the button goes away.
    expect(wrapper.findAll('[data-act="load-more"]')).toHaveLength(0)
  })

  it('loading more is not a row interaction and leaves the open row open', async () => {
    const feed = Array.from({ length: 12 }, (_, i) => release(`0.1.${80 - i}`))
    wrapper = mountPanel(feed)

    await wrapper.get('[data-ann-id="release:0.1.80"]').trigger('click')
    await wrapper.get('[data-act="load-more"]').trigger('click')

    // Revealing the rest neither collapses the open row nor marks anything read.
    expect(wrapper.findAll('.an-detail')).toHaveLength(1)
    expect(wrapper.findAll('[data-ann-id="release:0.1.80"] .an-detail')).toHaveLength(1)
    expect(wrapper.emitted('read')).toEqual([['release:0.1.80']])
  })

  it('offers no load-more button when the whole feed already fits', () => {
    wrapper = mountPanel([release('0.1.77'), release('0.1.76')])

    expect(wrapper.findAll('[data-act="load-more"]')).toHaveLength(0)
  })

  it('shows an empty state when there is nothing to announce', () => {
    wrapper = mountPanel([])

    expect(rowIds(wrapper)).toEqual([])
    expect(wrapper.get('.an-empty').text()).toBe(i18n.global.t('announce.empty'))
  })

  it('closes from the backdrop, the close button and Escape', async () => {
    wrapper = mountPanel([release('0.1.77')])

    await wrapper.get('.an-backdrop').trigger('click')
    await wrapper.get('[data-act="close"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toHaveLength(3)

    // Another key is not a close, and the listener goes away on unmount — the
    // captured array is the same instance emit() pushes into, so a leaked
    // window listener would still grow it after the component is gone.
    const closes = wrapper.emitted('close')!
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(closes).toHaveLength(3)
    wrapper.unmount()
    wrapper = undefined
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(closes).toHaveLength(3)
  })

  it('emits mark-all-read from the header action', async () => {
    wrapper = mountPanel([release('0.1.77')])

    await wrapper.get('[data-act="mark-all"]').trigger('click')
    expect(wrapper.emitted('mark-all-read')).toHaveLength(1)
  })

  it('renders no untranslated i18n keys, including an expanded update row', async () => {
    wrapper = mountPanel([update('install'), release('0.1.77')])

    await wrapper.get('[data-ann-id="update:0.1.78"]').trigger('click')
    expect(wrapper.text()).toContain(i18n.global.t('announce.title'))
    expect(wrapper.text()).toContain(i18n.global.t('updater.release-notes'))
    // vue-i18n renders the key itself when it is missing, so a typo would
    // otherwise sail through every structural assertion above.
    expect(wrapper.text()).not.toContain('announce.')
    // html() also covers the keys that only reach `title` attributes.
    expect(wrapper.html()).not.toContain('announce.')
  })
})
