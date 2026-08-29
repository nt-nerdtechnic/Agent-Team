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

  it('reports the first snapshot failure and retries without waiting for a reconnect', async () => {
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
    await expect(settings.settingsReady()).rejects.toThrow('snapshot unavailable')
    expect(settings.settingsReadiness).toMatchObject({ status: 'failed' })
    await settings.retrySettings()
    expect(backend.getAll).toHaveBeenCalledTimes(2)
    expect(settings.settingsGet('agentTeam.gitTabRepo', '')).toBe('/workspace/sub')
    expect(settings.settingsReadiness).toMatchObject({ status: 'ready' })
  })

  it('rejects an obsolete settingsReady waiter when the connection is replaced', async () => {
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
    const earlyReady = settings.settingsReady()

    status.value = 'connected'
    await nextTick()
    status.value = 'disconnected'
    await nextTick()
    await expect(earlyReady).rejects.toThrow('settings backend disconnected')
  })

  it('does not flush queued writes until the authoritative snapshot succeeds', async () => {
    vi.useFakeTimers()
    try {
      window.history.replaceState({}, '', '/?v2=1')
      vi.resetModules()
      const settings = await import('./settings')
      const status = ref<'connected' | 'disconnected'>('disconnected')
      const setMany = vi.fn(async () => undefined)
      let resolveSnapshot!: (value: Record<string, unknown>) => void
      const backend = {
        status,
        ownedKeys: ['agentTeam.git.logScope'],
        getAll: vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
          resolveSnapshot = resolve
        })),
        setMany,
        onChanged: () => () => undefined,
      }

      settings.initSettingsBackend(backend)
      settings.settingsSet('agentTeam.git.logScope', 'queued')
      status.value = 'connected'
      await nextTick()
      await Promise.resolve()

      expect(setMany).not.toHaveBeenCalled()
      resolveSnapshot({ 'agentTeam.git.logScope': 'server' })
      await settings.settingsReady()
      expect(setMany).toHaveBeenCalledWith({ 'agentTeam.git.logScope': 'queued' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a backend that declares no ownedKeys write anything', async () => {
    // The residual risk behind the "plugin surfaces never pass a backend
    // fallback to loadTheme" convention: `canWriteKey` is unconditional when a
    // surface declares no ownedKeys, so a future surface that skips the
    // declaration loses the barrier that stops a theme write-back loop. Pinned
    // so the behaviour is a decision rather than an accident.
    window.history.replaceState({}, '', '/?v2=1')
    vi.resetModules()
    const settings = await import('./settings')
    const status = ref<'connected' | 'disconnected'>('connected')
    const setMany = vi.fn(async () => undefined)
    settings.initSettingsBackend({
      status,
      // No ownedKeys and no readOnlyKeys declared.
      getAll: vi.fn(async () => ({})),
      setMany,
      onChanged: () => () => undefined,
    })
    await settings.settingsReady()

    settings.settingsSet('agent-team:theme', JSON.stringify('light'))
    expect(settings.settingsGet('agent-team:theme', null)).toBe(JSON.stringify('light'))
  })
})
