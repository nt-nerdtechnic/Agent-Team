// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import {
  settingsGet,
  settingsSet,
  settingsRemove,
  initSettingsBackend,
  onSettingsChanged,
  migrateLegacyLocalStorage,
  __resetSettingsForTest,
  SETTINGS_FLUSH_DEBOUNCE_MS,
  MIGRATED_LOCALSTORAGE_KEYS,
  PURGED_LOCALSTORAGE_KEYS,
} from '../settings'
import { readHostBootstrapSettings } from '../settingsBootstrap'

function stubBootstrap(raw: string | undefined): void {
  window.agentTeam = (raw === undefined
    ? undefined
    : { getBootstrapSettings: () => raw }) as unknown as typeof window.agentTeam
  const globalKey = globalThis as typeof globalThis & { __navideSettingsBootstrap?: Record<string, unknown> }
  if (raw === undefined) {
    delete globalKey.__navideSettingsBootstrap
  } else {
    globalKey.__navideSettingsBootstrap = readHostBootstrapSettings()
  }
}

/** Advance fake timers and let the awaited send() chains settle. */
async function settle(ms = 0): Promise<void> {
  await nextTick() // run vue watch callbacks (backend status changes)
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 5; i++) await Promise.resolve() // drain chained microtasks
}

describe('lib/settings', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stubBootstrap('{}')
    localStorage.clear()
    __resetSettingsForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    delete (globalThis as typeof globalThis & { __navideSettingsBootstrap?: unknown }).__navideSettingsBootstrap
  })

  describe('bootstrap seeding', () => {
    it('seeds the cache from getBootstrapSettings', () => {
      stubBootstrap('{"agent-team:theme":"dark","agentTeam.sidebarLeftPx":240}')
      __resetSettingsForTest()
      expect(settingsGet('agent-team:theme', 'light')).toBe('dark')
      expect(settingsGet('agentTeam.sidebarLeftPx', 0)).toBe(240)
    })

    it('returns the fallback for absent keys', () => {
      expect(settingsGet('missing', 'fb')).toBe('fb')
      expect(settingsGet<string | null>('missing', null)).toBeNull()
    })

    it('falls back to empty on malformed JSON', () => {
      stubBootstrap('{oops')
      __resetSettingsForTest()
      expect(settingsGet('any', 'fb')).toBe('fb')
    })

    it('falls back to empty on a non-object root', () => {
      stubBootstrap('[1,2]')
      __resetSettingsForTest()
      expect(settingsGet('0', 'fb')).toBe('fb')
    })

    it('falls back to empty when the preload bridge is unavailable', () => {
      stubBootstrap(undefined)
      __resetSettingsForTest()
      expect(settingsGet('any', 'fb')).toBe('fb')
    })
  })

  describe('set / remove', () => {
    it('updates the cache synchronously and flushes one debounced batch', async () => {
      const { backend, sent } = createMockBackend('connected')
      initSettingsBackend(backend)
      await settle()
      sent.length = 0 // drop the connect-time reconcile ui.settings.get

      settingsSet('a', 1)
      settingsSet('b', { nested: true })
      expect(settingsGet('a', 0)).toBe(1) // visible before any flush
      expect(sent).toHaveLength(0)

      await settle(SETTINGS_FLUSH_DEBOUNCE_MS)
      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('ui.settings.set')
      expect(sent[0].payload).toEqual({ updates: { a: 1, b: { nested: true } } })
    })

    it('resets the debounce window on each write (single batched flush)', async () => {
      const { backend, sent } = createMockBackend('connected')
      initSettingsBackend(backend)
      await settle()
      sent.length = 0

      settingsSet('a', 1)
      await settle(SETTINGS_FLUSH_DEBOUNCE_MS - 100)
      settingsSet('a', 2)
      settingsSet('b', 'x')
      await settle(SETTINGS_FLUSH_DEBOUNCE_MS - 100)
      expect(sent).toHaveLength(0) // still inside the re-armed window
      await settle(100)
      expect(sent).toHaveLength(1)
      expect(sent[0].payload).toEqual({ updates: { a: 2, b: 'x' } })
    })

    it('settingsRemove deletes locally and sends null on the wire', async () => {
      stubBootstrap('{"gone":"soon"}')
      __resetSettingsForTest()
      const { backend, sent } = createMockBackend('connected')
      initSettingsBackend(backend)
      await settle()
      sent.length = 0

      settingsRemove('gone')
      expect(settingsGet('gone', 'fb')).toBe('fb')
      await settle(SETTINGS_FLUSH_DEBOUNCE_MS)
      expect(sent).toHaveLength(1)
      expect(sent[0].payload).toEqual({ updates: { gone: null } })
    })

    it('settingsSet(key, null) is remove semantics', async () => {
      stubBootstrap('{"k":1}')
      __resetSettingsForTest()
      const { backend, sent } = createMockBackend('connected')
      initSettingsBackend(backend)
      await settle()
      sent.length = 0

      settingsSet('k', null)
      expect(settingsGet('k', 'fb')).toBe('fb')
      await settle(SETTINGS_FLUSH_DEBOUNCE_MS)
      expect(sent[0].payload).toEqual({ updates: { k: null } })
    })

    it('re-queues the batch when the backend rejects the set', async () => {
      const { backend, sent, setResponse } = createMockBackend('connected')
      setResponse('ui.settings.set', null, {
        ok: false,
        error: { code: 'x', message: 'boom' },
      })
      initSettingsBackend(backend)
      await settle()
      sent.length = 0

      settingsSet('a', 1)
      await settle(SETTINGS_FLUSH_DEBOUNCE_MS)
      expect(sent).toHaveLength(1) // failed attempt

      // A later write flushes the re-queued key along with the new one.
      setResponse('ui.settings.set', { ok: true })
      settingsSet('b', 2)
      await settle(SETTINGS_FLUSH_DEBOUNCE_MS)
      expect(sent).toHaveLength(2)
      expect(sent[1].payload).toEqual({ updates: { a: 1, b: 2 } })
    })
  })

  describe('offline queueing', () => {
    it('holds writes while disconnected and flushes them on connect', async () => {
      const { backend, status, sent, setResponse } = createMockBackend('disconnected')
      initSettingsBackend(backend)

      settingsSet('a', 1)
      settingsRemove('b')
      await settle(SETTINGS_FLUSH_DEBOUNCE_MS)
      expect(sent).toHaveLength(0) // nothing sent while offline
      expect(settingsGet('a', 0)).toBe(1) // cache already correct

      setResponse('ui.settings.get', { settings: {} })
      status.value = 'connected'
      await settle()
      expect(sent.map((s) => s.type)).toEqual(['ui.settings.get', 'ui.settings.set'])
      expect(sent[1].payload).toEqual({ updates: { a: 1, b: null } })
    })
  })

  describe('connect-time reconcile', () => {
    it('adopts the backend dict but keeps pending local writes', async () => {
      stubBootstrap('{"stale":"local","shared":"old"}')
      __resetSettingsForTest()
      const { backend, status, setResponse } = createMockBackend('disconnected')
      initSettingsBackend(backend)

      settingsSet('pendingKey', 'mine')
      setResponse('ui.settings.get', {
        settings: { shared: 'server', pendingKey: 'theirs' },
      })
      status.value = 'connected'
      await settle()

      expect(settingsGet('shared', '')).toBe('server') // server wins
      expect(settingsGet('stale', 'gone')).toBe('gone') // absent on server → dropped
      expect(settingsGet('pendingKey', '')).toBe('mine') // unflushed write wins
    })
  })

  describe('ui.settings_changed broadcasts', () => {
    it('merges the delta into the cache (null deletes)', async () => {
      stubBootstrap('{"b":"old"}')
      __resetSettingsForTest()
      const { backend, emit } = createMockBackend('connected')
      initSettingsBackend(backend)
      await settle()

      emit('ui.settings_changed', { settings: { a: 1, b: null } })
      expect(settingsGet('a', 0)).toBe(1)
      expect(settingsGet('b', 'fb')).toBe('fb')
    })

    it('does not clobber a locally pending write', async () => {
      const { backend, emit } = createMockBackend('connected')
      initSettingsBackend(backend)
      await settle()

      settingsSet('k', 'mine') // pending, not yet flushed
      emit('ui.settings_changed', { settings: { k: 'theirs', other: 2 } })
      expect(settingsGet('k', '')).toBe('mine')
      expect(settingsGet('other', 0)).toBe(2)
    })

    it('ignores malformed broadcast payloads', async () => {
      const { backend, emit } = createMockBackend('connected')
      initSettingsBackend(backend)
      await settle()

      emit('ui.settings_changed', null)
      emit('ui.settings_changed', { settings: 'nope' })
      expect(settingsGet('anything', 'fb')).toBe('fb')
    })

    it('notifies onSettingsChanged listeners with the changed keys', async () => {
      const { backend, emit } = createMockBackend('connected')
      initSettingsBackend(backend)
      await settle()

      const seen: string[][] = []
      const off = onSettingsChanged((keys) => seen.push(keys))
      emit('ui.settings_changed', { settings: { 'agent-team:theme': '"light"' } })
      expect(seen).toEqual([['agent-team:theme']])

      off()
      emit('ui.settings_changed', { settings: { other: 1 } })
      expect(seen).toHaveLength(1)
    })
  })

  describe('one-time localStorage migration', () => {
    const KEY = MIGRATED_LOCALSTORAGE_KEYS[0]
    const KEY2 = MIGRATED_LOCALSTORAGE_KEYS[1]

    it('copies legacy values into the store and deletes them only after ack', async () => {
      localStorage.setItem(KEY, 'legacy-value')
      migrateLegacyLocalStorage()

      // Visible synchronously, before any flush (no-flash startup reads).
      expect(settingsGet<string | null>(KEY, null)).toBe('legacy-value')
      expect(localStorage.getItem(KEY)).toBe('legacy-value') // not yet acked

      const { backend, sent } = createMockBackend('connected')
      initSettingsBackend(backend)
      // The connect-time reconcile flushes the queued migration batch.
      await settle(SETTINGS_FLUSH_DEBOUNCE_MS)

      const flush = sent.find((s) => s.type === 'ui.settings.set')
      expect(flush?.payload).toEqual({
        updates: { [KEY]: 'legacy-value', __migrated: true },
      })
      expect(localStorage.getItem(KEY)).toBeNull() // deleted after ack
    })

    it('an existing store value wins over the localStorage copy', async () => {
      stubBootstrap(JSON.stringify({ [KEY]: 'store-value' }))
      __resetSettingsForTest()
      localStorage.setItem(KEY, 'stale-local')
      localStorage.setItem(KEY2, 'fresh-local')
      migrateLegacyLocalStorage()

      expect(settingsGet<string | null>(KEY, null)).toBe('store-value')
      expect(settingsGet<string | null>(KEY2, null)).toBe('fresh-local')

      const { backend, sent } = createMockBackend('connected')
      initSettingsBackend(backend)
      await settle(SETTINGS_FLUSH_DEBOUNCE_MS)
      const flush = sent.find((s) => s.type === 'ui.settings.set')
      expect(flush?.payload).toEqual({
        updates: { [KEY2]: 'fresh-local', __migrated: true },
      })
      // Both local copies are cleaned up after the ack.
      expect(localStorage.getItem(KEY)).toBeNull()
      expect(localStorage.getItem(KEY2)).toBeNull()
    })

    it('is idempotent: with __migrated set it only cleans up leftover copies', async () => {
      stubBootstrap('{"__migrated":true}')
      __resetSettingsForTest()
      localStorage.setItem(KEY, 'leftover')
      migrateLegacyLocalStorage()

      expect(localStorage.getItem(KEY)).toBeNull() // removed immediately
      expect(settingsGet<string | null>(KEY, null)).toBeNull() // never re-uploaded

      const { backend, sent } = createMockBackend('connected')
      initSettingsBackend(backend)
      await settle(SETTINGS_FLUSH_DEBOUNCE_MS)
      expect(sent.filter((s) => s.type === 'ui.settings.set')).toHaveLength(0)
    })

    it('keeps localStorage when the flush fails, so migration retries', async () => {
      localStorage.setItem(KEY, 'legacy-value')
      migrateLegacyLocalStorage()

      const { backend, setResponse } = createMockBackend('connected')
      setResponse('ui.settings.set', null, {
        ok: false,
        error: { code: 'x', message: 'boom' },
      })
      initSettingsBackend(backend)
      await settle(SETTINGS_FLUSH_DEBOUNCE_MS)
      expect(localStorage.getItem(KEY)).toBe('legacy-value') // ack never came
    })

    it('purges dead legacy keys without copying them', () => {
      const purged = PURGED_LOCALSTORAGE_KEYS[0]
      localStorage.setItem(purged, 'stale')
      migrateLegacyLocalStorage()
      expect(localStorage.getItem(purged)).toBeNull()
      expect(settingsGet<string | null>(purged, null)).toBeNull()
    })

    it('purges workspace-prefixed retired AI-chat keys by prefix scan', () => {
      localStorage.setItem('ai-chat-threads:/ws/a', '[]')
      localStorage.setItem('ai-chat-notes:/ws/a', 'n')
      localStorage.setItem('ai-chat-notepads:/ws/b', '{}')
      localStorage.setItem('ai-chat-history:/ws/b', '[]')
      localStorage.setItem('unrelated:/ws/a', 'keep')
      migrateLegacyLocalStorage()
      expect(localStorage.getItem('ai-chat-threads:/ws/a')).toBeNull()
      expect(localStorage.getItem('ai-chat-notes:/ws/a')).toBeNull()
      expect(localStorage.getItem('ai-chat-notepads:/ws/b')).toBeNull()
      expect(localStorage.getItem('ai-chat-history:/ws/b')).toBeNull()
      expect(localStorage.getItem('unrelated:/ws/a')).toBe('keep')
    })
  })
})
