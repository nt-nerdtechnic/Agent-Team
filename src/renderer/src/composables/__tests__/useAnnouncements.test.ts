// @vitest-environment happy-dom
// Announcements centre feed: how the two sources (curated release notes and the
// live updater state) merge, how read state is persisted and bounded, and how a
// fresh install is baselined so it isn't greeted by every historical entry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { UpdateState } from '../../../../shared/updater'

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock('../../lib/settings', () => ({
  settingsGet: (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback),
  settingsSet: (key: string, value: unknown) => {
    store.set(key, value)
  },
}))

const READ_IDS_KEY = 'agentTeam.announcements.readIds'

/** Fresh module graph per test — the composable is a module-level singleton. */
async function load() {
  vi.resetModules()
  const mod = await import('../useAnnouncements')
  const { i18n } = await import('../../i18n')
  return { ...mod, i18n }
}

function updateState(patch: Partial<UpdateState> = {}) {
  return ref<UpdateState>({ status: 'idle', currentVersion: '0.1.77', ...patch })
}

describe('useAnnouncements', () => {
  beforeEach(() => {
    store.clear()
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { version: '0.1.77' }
  })

  afterEach(() => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  it('lists every shipped release note, newest version first', async () => {
    store.set(READ_IDS_KEY, [])
    const { useAnnouncements } = await load()
    const a = useAnnouncements()

    expect(a.items.value.map((i) => i.version)).toEqual([
      '0.1.77', '0.1.76', '0.1.75', '0.1.74', '0.1.73',
      '0.1.72', '0.1.71', '0.1.70', '0.1.68', '0.1.65',
    ])
    expect(a.items.value.every((i) => i.kind === 'release')).toBe(true)
    expect(a.items.value[0].id).toBe('release:0.1.77')
    expect(a.items.value[0].highlights.length).toBeGreaterThan(0)
    // No real timestamp exists for a curated entry, so none is invented.
    expect(a.items.value[0].createdAt).toBeUndefined()
  })

  it('hides release notes authored for versions the app has not reached', async () => {
    store.set(READ_IDS_KEY, [])
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { version: '0.1.70' }
    const { useAnnouncements } = await load()

    expect(useAnnouncements().items.value.map((i) => i.version)).toEqual([
      '0.1.70', '0.1.68', '0.1.65',
    ])
  })

  it('baselines a fresh install: everything present starts read', async () => {
    const { useAnnouncements } = await load()
    const a = useAnnouncements()

    expect(a.unreadCount.value).toBe(0)
    expect(a.items.value.every((i) => i.read)).toBe(true)
    expect(store.get(READ_IDS_KEY)).toEqual(a.items.value.map((i) => i.id))
  })

  it('counts stored-but-unseen entries as unread and marks them read', async () => {
    store.set(READ_IDS_KEY, ['release:0.1.65'])
    const { useAnnouncements } = await load()
    const a = useAnnouncements()

    expect(a.unreadCount.value).toBe(9)

    a.markRead('release:0.1.77')
    expect(a.unreadCount.value).toBe(8)
    expect(store.get(READ_IDS_KEY)).toEqual(['release:0.1.65', 'release:0.1.77'])

    // Marking the same id again is a no-op, not a duplicate.
    a.markRead('release:0.1.77')
    expect(store.get(READ_IDS_KEY)).toEqual(['release:0.1.65', 'release:0.1.77'])

    a.markAllRead()
    expect(a.unreadCount.value).toBe(0)
    expect((store.get(READ_IDS_KEY) as string[]).length).toBe(10)
  })

  it('caps the persisted read set so the shared settings document stays small', async () => {
    store.set(READ_IDS_KEY, Array.from({ length: 100 }, (_, i) => `old:${i}`))
    const { useAnnouncements } = await load()
    const a = useAnnouncements()

    a.markRead('release:0.1.77')
    const ids = store.get(READ_IDS_KEY) as string[]
    expect(ids).toHaveLength(100)
    expect(ids[0]).toBe('old:1')
    expect(ids[99]).toBe('release:0.1.77')
  })

  it('re-localizes the feed when the locale changes', async () => {
    store.set(READ_IDS_KEY, [])
    const { useAnnouncements, i18n } = await load()
    const a = useAnnouncements()

    i18n.global.locale.value = 'zh-TW'
    const zh = a.items.value[0].title
    i18n.global.locale.value = 'en-US'
    const en = a.items.value[0].title

    expect(zh).not.toBe('')
    expect(en).not.toBe('')
    expect(en).not.toBe(zh)
  })

  it('tracks the updater through its status transitions', async () => {
    store.set(READ_IDS_KEY, [])
    const { useAnnouncements } = await load()
    const a = useAnnouncements()
    const state = updateState()
    a.setUpdateSource(state)

    // An idle updater contributes nothing.
    expect(a.items.value.every((i) => i.kind === 'release')).toBe(true)

    state.value = {
      status: 'available',
      currentVersion: '0.1.77',
      availableVersion: '0.1.78',
      releaseNotes: 'Fixes things',
      checkedAt: '2026-08-07T10:00:00.000Z',
    }
    let top = a.items.value[0]
    expect(top.id).toBe('update:0.1.78')
    expect(top.kind).toBe('update')
    expect(top.action).toBe('download')
    expect(top.highlights).toEqual(['Fixes things'])
    expect(top.createdAt).toBe(Date.parse('2026-08-07T10:00:00.000Z'))
    expect(top.read).toBe(false)

    state.value = { ...state.value, status: 'downloading', percent: 42 }
    top = a.items.value[0]
    expect(top.id).toBe('update:0.1.78')
    expect(top.action).toBeUndefined()
    expect(top.title).toContain('42')

    state.value = { ...state.value, status: 'downloaded', quitInstallArmed: true }
    top = a.items.value[0]
    expect(top.action).toBe('install')
    expect(top.note).toBeTruthy()

    // Read state is keyed on the version, so it survives those transitions.
    a.markRead('update:0.1.78')
    expect(a.items.value[0].read).toBe(true)
  })

  it('gives a run of failed background checks its own item', async () => {
    store.set(READ_IDS_KEY, [])
    const { useAnnouncements } = await load()
    const a = useAnnouncements()
    a.setUpdateSource(
      updateState({
        lastCheckFailure: { message: 'network down', count: 3, at: '2026-08-07T09:00:00.000Z' },
      })
    )

    const top = a.items.value[0]
    expect(top.id).toBe('update-failed')
    expect(top.kind).toBe('update')
    expect(top.highlights[0]).toContain('network down')
    expect(top.createdAt).toBe(Date.parse('2026-08-07T09:00:00.000Z'))
  })

  it('exposes the release id used by the What is New modal', async () => {
    const { releaseAnnouncementId } = await load()
    expect(releaseAnnouncementId('0.1.77')).toBe('release:0.1.77')
  })
})
