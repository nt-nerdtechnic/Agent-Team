// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

const originalUrl = window.location.href

afterEach(() => {
  window.history.replaceState({}, '', originalUrl)
  vi.resetModules()
})

describe('Manifest v2 settings origin', () => {
  it('keeps legacy localStorage seeds read-only until the owning seam promotes them', async () => {
    window.history.replaceState({}, '', '/?v2=1')
    localStorage.setItem('agentTeam.git.logScope', 'current')

    vi.resetModules()
    const settings = await import('./settings')

    expect(settings.settingsGet('agentTeam.git.logScope', null)).toBeNull()
    expect(localStorage.getItem('agentTeam.git.logScope')).toBe('current')
  })

  it('keeps Host-owned writes out of the plugin cache and accepts typed events', async () => {
    window.history.replaceState({}, '', '/?v2=1')
    vi.resetModules()
    const settings = await import('./settings')
    const status = ref<'connected' | 'disconnected'>('connected')
    let emitChanged = (_payload: unknown): void => undefined
    const setMany = vi.fn(async () => undefined)
    const backend = {
      status,
      ownedKeys: ['agentTeam.git.logScope'],
      readOnlyKeys: ['agentTeam.yolo'],
      getAll: vi.fn(async () => ({ 'agentTeam.git.logScope': 'server' })),
      setMany,
      onChanged: (callback: (payload: unknown) => void) => {
        emitChanged = callback
        return () => { emitChanged = () => undefined }
      },
    }

    settings.initSettingsBackend(backend)
    await settings.settingsReady()
    settings.settingsSet('agentTeam.yolo', '0')
    expect(settings.settingsGet('agentTeam.yolo', 'missing')).toBe('missing')
    expect(setMany).not.toHaveBeenCalled()

    emitChanged({
      source: 'host',
      settings: { 'agentTeam.yolo': '0', 'unknown.setting': 'ignored' },
    })
    expect(settings.settingsGet('agentTeam.yolo', '')).toBe('0')
    emitChanged({ source: 'plugin-storage', settings: { 'agentTeam.yolo': '1' } })
    expect(settings.settingsGet('agentTeam.yolo', '')).toBe('0')
  })

  it('keeps settingsReady pending after a failed snapshot and retries on reconnect', async () => {
    window.history.replaceState({}, '', '/?v2=1')
    vi.resetModules()
    const settings = await import('./settings')
    const status = ref<'connected' | 'disconnected'>('connected')
    let attempt = 0
    const backend = {
      status,
      ownedKeys: ['agentTeam.gitTabRepo'],
      getAll: vi.fn(async () => {
        attempt += 1
        if (attempt === 1) throw new Error('snapshot unavailable')
        return { 'agentTeam.gitTabRepo': '/workspace/sub' }
      }),
      setMany: vi.fn(async () => undefined),
      onChanged: () => () => undefined,
    }

    settings.initSettingsBackend(backend)
    let ready = false
    void settings.settingsReady().then(() => { ready = true })
    await nextTick()
    await Promise.resolve()
    expect(ready).toBe(false)

    status.value = 'disconnected'
    await nextTick()
    status.value = 'connected'
    await nextTick()
    await settings.settingsReady()
    expect(backend.getAll).toHaveBeenCalledTimes(2)
    expect(settings.settingsGet('agentTeam.gitTabRepo', '')).toBe('/workspace/sub')
  })

  it('resolves an early settingsReady waiter after a connection flap', async () => {
    window.history.replaceState({}, '', '/?v2=1')
    vi.resetModules()
    const settings = await import('./settings')
    const status = ref<'connected' | 'disconnected'>('disconnected')
    let resolveSnapshot!: (value: Record<string, unknown>) => void
    const backend = {
      status,
      ownedKeys: ['agentTeam.gitTabRepo'],
      getAll: vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
        resolveSnapshot = resolve
      })),
      setMany: vi.fn(async () => undefined),
      onChanged: () => () => undefined,
    }

    settings.initSettingsBackend(backend)
    let earlyReady = false
    void settings.settingsReady().then(() => { earlyReady = true })

    status.value = 'connected'
    await nextTick()
    status.value = 'disconnected'
    await nextTick()
    status.value = 'connected'
    await nextTick()
    resolveSnapshot({ 'agentTeam.gitTabRepo': '/workspace/sub' })
    await settings.settingsReady()
    await Promise.resolve()

    expect(earlyReady).toBe(true)
  })

  it('flushes queued writes when reconciliation fails', async () => {
    vi.useFakeTimers()
    try {
      window.history.replaceState({}, '', '/?v2=1')
      vi.resetModules()
      const settings = await import('./settings')
      const status = ref<'connected' | 'disconnected'>('disconnected')
      const setMany = vi.fn(async () => undefined)
      const backend = {
        status,
        ownedKeys: ['agentTeam.git.logScope'],
        getAll: vi.fn(async () => { throw new Error('snapshot unavailable') }),
        setMany,
        onChanged: () => () => undefined,
      }

      settings.initSettingsBackend(backend)
      settings.settingsSet('agentTeam.git.logScope', 'queued')
      status.value = 'connected'
      await nextTick()
      await Promise.resolve()

      expect(setMany).toHaveBeenCalledWith({ 'agentTeam.git.logScope': 'queued' })
    } finally {
      vi.useRealTimers()
    }
  })
})
