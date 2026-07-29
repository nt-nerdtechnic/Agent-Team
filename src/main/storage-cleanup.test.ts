import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  assertInsideRoot,
  clearElectronCaches,
  isUpdaterCacheEntry,
  resolveOsCacheRoot,
  REMOVABLE_CACHE_DIRS,
  type StorageCleanupDeps
} from './storage-cleanup'

const USER_DATA = '/Users/tester/Library/Application Support/Agent-Team'
const CACHE_ROOT = '/Users/tester/Library/Caches'

function makeDeps(overrides: Partial<StorageCleanupDeps> = {}): StorageCleanupDeps {
  return {
    userData: USER_DATA,
    cacheRoot: CACHE_ROOT,
    appNames: ['agent-team', 'Navide'],
    appId: 'com.nerdtechnic.agent-team',
    dirSize: () => 0,
    removeDir: vi.fn(),
    listDir: () => [],
    clearSessionCaches: vi.fn(async () => {}),
    isUpdateDownloading: () => false,
    ...overrides
  }
}

describe('assertInsideRoot', () => {
  it('accepts a path strictly inside an allowed root', () => {
    expect(assertInsideRoot(join(USER_DATA, 'GPUCache'), [USER_DATA])).toBe(join(USER_DATA, 'GPUCache'))
  })

  it('refuses a path outside the allowed root', () => {
    expect(() => assertInsideRoot('/etc/passwd', [USER_DATA])).toThrow(/outside the allowed roots/)
  })

  it('refuses traversal that escapes the root', () => {
    expect(() => assertInsideRoot(join(USER_DATA, '..', '..', 'Secrets'), [USER_DATA])).toThrow(
      /outside the allowed roots/
    )
  })

  it('refuses the root itself, so userData is never deleted wholesale', () => {
    expect(() => assertInsideRoot(USER_DATA, [USER_DATA])).toThrow(/outside the allowed roots/)
  })
})

describe('resolveOsCacheRoot', () => {
  it('derives the cache root per platform rather than assuming macOS', () => {
    expect(resolveOsCacheRoot('darwin', '/Users/tester', {})).toBe('/Users/tester/Library/Caches')
    expect(resolveOsCacheRoot('linux', '/home/tester', {})).toBe('/home/tester/.cache')
    expect(resolveOsCacheRoot('linux', '/home/tester', { XDG_CACHE_HOME: '/xdg' })).toBe('/xdg')
    expect(resolveOsCacheRoot('win32', 'C:\\Users\\t', { LOCALAPPDATA: 'C:\\local' })).toBe('C:\\local')
  })
})

describe('isUpdaterCacheEntry', () => {
  const names = ['agent-team', 'Navide']
  const appId = 'com.nerdtechnic.agent-team'

  it('matches the electron-updater download cache', () => {
    expect(isUpdaterCacheEntry('agent-team-updater', names, appId)).toBe(true)
  })

  it('matches appId-namespaced caches such as Squirrel ShipIt', () => {
    expect(isUpdaterCacheEntry('com.nerdtechnic.agent-team', names, appId)).toBe(true)
    expect(isUpdaterCacheEntry('com.nerdtechnic.agent-team.ShipIt', names, appId)).toBe(true)
  })

  it('ignores unrelated cache entries', () => {
    expect(isUpdaterCacheEntry('com.apple.Safari', names, appId)).toBe(false)
    expect(isUpdaterCacheEntry('some-other-app-updater', names, appId)).toBe(false)
  })
})

describe('clearElectronCaches', () => {
  it('refuses to clear the updater cache while a download is in progress', async () => {
    const removeDir = vi.fn()
    const result = await clearElectronCaches(
      { chromium: false, updater: true },
      makeDeps({
        isUpdateDownloading: () => true,
        listDir: () => ['agent-team-updater'],
        dirSize: () => 5_000,
        removeDir
      })
    )

    expect(removeDir).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.freedBytes).toBe(0)
    expect(result.error).toMatch(/update download is in progress/i)
  })

  it('clears the updater cache when idle and reports measured bytes', async () => {
    const removed: string[] = []
    const sizes = new Map<string, number>([[join(CACHE_ROOT, 'agent-team-updater'), 4_096]])
    const result = await clearElectronCaches(
      { chromium: false, updater: true },
      makeDeps({
        listDir: () => ['agent-team-updater', 'com.apple.Safari'],
        dirSize: (path) => sizes.get(path) ?? 0,
        removeDir: (path) => {
          removed.push(path)
          sizes.set(path, 0)
        }
      })
    )

    expect(removed).toEqual([join(CACHE_ROOT, 'agent-team-updater')])
    expect(result).toEqual({ ok: true, freedBytes: 4_096, error: null })
  })

  it('clears GPU caches via removal and HTTP cache via the session API', async () => {
    const removed: string[] = []
    const sizes = new Map<string, number>([
      [join(USER_DATA, 'Cache'), 10_000],
      [join(USER_DATA, 'GPUCache'), 2_000]
    ])
    const clearSessionCaches = vi.fn(async () => {
      sizes.set(join(USER_DATA, 'Cache'), 0)
    })

    const result = await clearElectronCaches(
      { chromium: true, updater: false },
      makeDeps({
        clearSessionCaches,
        dirSize: (path) => sizes.get(path) ?? 0,
        removeDir: (path) => {
          removed.push(path)
          sizes.set(path, 0)
        }
      })
    )

    expect(clearSessionCaches).toHaveBeenCalledOnce()
    // Chromium holds open fds on Cache/ — it must never be removed directly.
    expect(removed).not.toContain(join(USER_DATA, 'Cache'))
    expect(removed).toEqual(REMOVABLE_CACHE_DIRS.map((dir) => join(USER_DATA, dir)))
    expect(result).toEqual({ ok: true, freedBytes: 12_000, error: null })
  })

  it('never touches directories that hold user state', async () => {
    const removed: string[] = []
    await clearElectronCaches(
      { chromium: true, updater: true },
      makeDeps({
        listDir: () => ['Local Storage', 'Cookies', 'agent-team-updater'],
        removeDir: (path) => removed.push(path)
      })
    )

    for (const stateful of ['Local Storage', 'Session Storage', 'Cookies', 'blob_storage']) {
      expect(removed.some((path) => path.includes(stateful))).toBe(false)
    }
  })

  it('returns the error instead of throwing when a dependency fails', async () => {
    const result = await clearElectronCaches(
      { chromium: true, updater: false },
      makeDeps({
        clearSessionCaches: async () => {
          throw new Error('session unavailable')
        }
      })
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe('session unavailable')
  })
})
