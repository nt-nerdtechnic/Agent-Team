import { join, resolve, sep } from 'node:path'

/**
 * Clearing Electron-owned caches. Kept electron-free so it runs under Vitest;
 * `index.ts` supplies the electron-backed deps (userData path, OS cache dir,
 * session cache clearing, updater download state).
 *
 * Safety model: nothing here deletes a path it has not first resolved and
 * proven to live *strictly inside* an allowed root. User state (Local Storage,
 * Session Storage, Cookies, blob_storage, ...) is never a target — on macOS
 * userData is also the Python backend's data dir, so only the explicitly
 * named cache subdirectories below are ever removed.
 */

export interface ClearElectronCachesOptions {
  chromium: boolean
  updater: boolean
}

export interface ClearElectronCachesResult {
  ok: boolean
  freedBytes: number
  error: string | null
}

/**
 * GPU/shader caches under userData that `session.clearCache()` does not cover.
 * Chromium regenerates these, and it does not hold them open the way it holds
 * `Cache/`, so removing the directories outright is safe.
 */
export const REMOVABLE_CACHE_DIRS = ['GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']

/**
 * Measured but never removed: Chromium keeps open fds on these. They are
 * emptied through `clearCache()` / `clearCodeCaches()` instead.
 */
export const SESSION_MANAGED_CACHE_DIRS = ['Cache', 'Code Cache']

/**
 * Platform-appropriate OS cache root, where electron-updater keeps its
 * download cache. `app.getPath('cache')` is not in this Electron version's
 * typings, so derive it the same way electron-updater does.
 */
export function resolveOsCacheRoot(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Caches')
  if (platform === 'win32') return env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  return env.XDG_CACHE_HOME || join(home, '.cache')
}

export interface StorageCleanupDeps {
  /** `app.getPath('userData')`. */
  userData: string
  /** Platform-appropriate OS cache root (see `resolveOsCacheRoot`). */
  cacheRoot: string
  /** App name candidates used by electron-updater for `<name>-updater`. */
  appNames: string[]
  /** electron-builder appId, e.g. `com.nerdtechnic.agent-team`. */
  appId: string
  /** Recursive size in bytes; 0 when the path is missing. */
  dirSize(path: string): number
  /** Recursive delete; no-op when the path is missing. */
  removeDir(path: string): void
  /** Entry names in a directory; empty when the path is missing. */
  listDir(path: string): string[]
  /** `session.defaultSession.clearCache()` + `clearCodeCaches({})`. */
  clearSessionCaches(): Promise<void>
  /** True while electron-updater is downloading an update. */
  isUpdateDownloading(): boolean
}

/**
 * Resolve `target` and prove it is strictly inside one of `roots`. Equality
 * with a root is refused too — that would delete userData or the whole OS
 * cache directory.
 */
export function assertInsideRoot(target: string, roots: string[]): string {
  const resolved = resolve(target)
  const allowed = roots.some((root) => {
    const base = resolve(root)
    return resolved !== base && resolved.startsWith(base + sep)
  })
  if (!allowed) {
    throw new Error(`Refusing to remove a path outside the allowed roots: ${resolved}`)
  }
  return resolved
}

/**
 * Whether a cache-root entry belongs to electron-updater / Squirrel. Matches
 * `<appName>-updater` and anything namespaced under the appId (e.g.
 * `com.nerdtechnic.agent-team.ShipIt`).
 */
export function isUpdaterCacheEntry(name: string, appNames: string[], appId: string): boolean {
  if (appNames.some((appName) => name === `${appName}-updater`)) return true
  return name === appId || name.startsWith(`${appId}.`) || name.startsWith(`${appId}-`)
}

async function clearChromiumCaches(deps: StorageCleanupDeps): Promise<number> {
  const measured = [
    ...SESSION_MANAGED_CACHE_DIRS.map((dir) => join(deps.userData, dir)),
    ...REMOVABLE_CACHE_DIRS.map((dir) => join(deps.userData, dir))
  ]
  const sizeOfAll = (): number => measured.reduce((total, dir) => total + deps.dirSize(dir), 0)

  const before = sizeOfAll()
  await deps.clearSessionCaches()
  for (const dir of REMOVABLE_CACHE_DIRS) {
    deps.removeDir(assertInsideRoot(join(deps.userData, dir), [deps.userData]))
  }
  return Math.max(0, before - sizeOfAll())
}

function clearUpdaterCache(deps: StorageCleanupDeps): number {
  if (deps.isUpdateDownloading()) {
    throw new Error('An update download is in progress — the updater cache was left untouched.')
  }
  let freed = 0
  for (const name of deps.listDir(deps.cacheRoot)) {
    if (!isUpdaterCacheEntry(name, deps.appNames, deps.appId)) continue
    const target = assertInsideRoot(join(deps.cacheRoot, name), [deps.cacheRoot])
    const before = deps.dirSize(target)
    deps.removeDir(target)
    freed += Math.max(0, before - deps.dirSize(target))
  }
  return freed
}

/**
 * Clear the requested Electron-owned caches. Never throws: failures land in
 * `error`. `freedBytes` is always measured (before/after), never estimated,
 * and stays accurate even for the parts that did succeed.
 */
export async function clearElectronCaches(
  options: ClearElectronCachesOptions,
  deps: StorageCleanupDeps
): Promise<ClearElectronCachesResult> {
  const errors: string[] = []
  let freedBytes = 0

  if (options.chromium) {
    try {
      freedBytes += await clearChromiumCaches(deps)
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }

  if (options.updater) {
    try {
      freedBytes += clearUpdaterCache(deps)
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }

  return {
    ok: errors.length === 0,
    freedBytes,
    error: errors.length ? errors.join(' ') : null
  }
}
