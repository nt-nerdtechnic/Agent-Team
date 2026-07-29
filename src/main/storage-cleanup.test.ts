import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  assertInsideRoot,
  clearElectronCaches,
  clearSessionCaches,
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
    dirSize: () => 0,
    removeDir: vi.fn(),
    listDir: () => [],
    clearSessionCaches: vi.fn(async () => {}),
    updaterCacheBusyStatus: () => null,
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

  it('matches the electron-updater download cache', () => {
    expect(isUpdaterCacheEntry('agent-team-updater', names)).toBe(true)
    expect(isUpdaterCacheEntry('Navide-updater', names)).toBe(true)
  })

  // <appId>/ is the live CFNetwork HTTP cache (open SQLite + -wal/-shm), and
  // <appId>.ShipIt/ is Squirrel install state a pending update still needs.
  it('never matches the appId-namespaced caches', () => {
    expect(isUpdaterCacheEntry('com.nerdtechnic.agent-team', names)).toBe(false)
    expect(isUpdaterCacheEntry('com.nerdtechnic.agent-team.ShipIt', names)).toBe(false)
    expect(isUpdaterCacheEntry('com.nerdtechnic.agent-team-Crashes', names)).toBe(false)
  })

  it('ignores unrelated cache entries', () => {
    expect(isUpdaterCacheEntry('com.apple.Safari', names)).toBe(false)
    expect(isUpdaterCacheEntry('some-other-app-updater', names)).toBe(false)
  })
})

describe('clearSessionCaches', () => {
  it('awaits clearCodeCaches so its bytes land before the after-measurement', async () => {
    const done: string[] = []
    await clearSessionCaches({
      clearCache: async () => {
        done.push('cache')
      },
      clearCodeCaches: async () => {
        await Promise.resolve()
        done.push('code-cache')
      }
    })

    expect(done).toEqual(['cache', 'code-cache'])
  })

  it('rejects instead of leaking an unhandled rejection when clearCodeCaches fails', async () => {
    await expect(
      clearSessionCaches({
        clearCache: async () => {},
        clearCodeCaches: async () => {
          throw new Error('code cache unavailable')
        }
      })
    ).rejects.toThrow('code cache unavailable')
  })

  it('still clears the HTTP cache on runtimes without clearCodeCaches', async () => {
    const clearCache = vi.fn(async () => {})
    await clearSessionCaches({ clearCache })
    expect(clearCache).toHaveBeenCalledOnce()
  })
})

describe('clearElectronCaches', () => {
  it('refuses to clear the updater cache while a download is in progress', async () => {
    const removeDir = vi.fn()
    const result = await clearElectronCaches(
      { chromium: false, updater: true },
      makeDeps({
        updaterCacheBusyStatus: () => 'downloading',
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

  // The installer sits in the updater cache from the moment the download
  // resolves until the app relaunches; deleting it then breaks the install the
  // renderer is still offering.
  it('refuses to clear the updater cache while an update is downloaded or installing', async () => {
    for (const [status, pattern] of [
      ['downloaded', /waiting to install/i],
      ['installing', /update is installing/i]
    ] as const) {
      const removeDir = vi.fn()
      const result = await clearElectronCaches(
        { chromium: false, updater: true },
        makeDeps({
          updaterCacheBusyStatus: () => status,
          listDir: () => ['agent-team-updater'],
          dirSize: () => 5_000,
          removeDir
        })
      )

      expect(removeDir).not.toHaveBeenCalled()
      expect(result.ok).toBe(false)
      expect(result.freedBytes).toBe(0)
      expect(result.error).toMatch(pattern)
      expect(result.error).toMatch(/updater cache was left untouched/i)
    }
  })

  it('leaves the appId-namespaced caches alone while still clearing the updater cache', async () => {
    const removed: string[] = []
    const result = await clearElectronCaches(
      { chromium: false, updater: true },
      makeDeps({
        listDir: () => [
          'agent-team-updater',
          'com.nerdtechnic.agent-team',
          'com.nerdtechnic.agent-team.ShipIt'
        ],
        removeDir: (path) => removed.push(path)
      })
    )

    expect(removed).toEqual([join(CACHE_ROOT, 'agent-team-updater')])
    expect(result.ok).toBe(true)
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

  it('counts Code Cache bytes, which only land once clearCodeCaches is awaited', async () => {
    const sizes = new Map<string, number>([
      [join(USER_DATA, 'Cache'), 10_000],
      [join(USER_DATA, 'Code Cache'), 7_000]
    ])
    const fakeSession = {
      clearCache: async () => {
        sizes.set(join(USER_DATA, 'Cache'), 0)
      },
      clearCodeCaches: async () => {
        // Resolves a macrotask later, as the real IPC does: an unawaited call
        // has not run by the time the after-sum is taken.
        await new Promise((r) => setTimeout(r, 0))
        sizes.set(join(USER_DATA, 'Code Cache'), 0)
      }
    }

    const result = await clearElectronCaches(
      { chromium: true, updater: false },
      makeDeps({
        clearSessionCaches: () => clearSessionCaches(fakeSession),
        dirSize: (path) => sizes.get(path) ?? 0
      })
    )

    expect(result).toEqual({ ok: true, freedBytes: 17_000, error: null })
  })

  it('surfaces a failing cache dir without discarding freed bytes or skipping the rest', async () => {
    const removed: string[] = []
    const sizes = new Map<string, number>([
      [join(USER_DATA, 'Cache'), 10_000],
      [join(USER_DATA, REMOVABLE_CACHE_DIRS[0]), 2_000],
      [join(USER_DATA, REMOVABLE_CACHE_DIRS[1]), 3_000]
    ])

    const result = await clearElectronCaches(
      { chromium: true, updater: false },
      makeDeps({
        clearSessionCaches: async () => {
          sizes.set(join(USER_DATA, 'Cache'), 0)
        },
        dirSize: (path) => sizes.get(path) ?? 0,
        removeDir: (path) => {
          if (path === join(USER_DATA, REMOVABLE_CACHE_DIRS[0])) {
            throw new Error(`EBUSY: resource busy or locked, rmdir '${path}'`)
          }
          removed.push(path)
          sizes.set(path, 0)
        }
      })
    )

    // The locked dir aborts nothing: later dirs are still removed and the
    // bytes clearCache() already reclaimed are still reported.
    expect(removed).toEqual(REMOVABLE_CACHE_DIRS.slice(1).map((dir) => join(USER_DATA, dir)))
    expect(result.freedBytes).toBe(13_000)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/EBUSY/)
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
