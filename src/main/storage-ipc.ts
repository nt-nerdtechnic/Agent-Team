import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { app, ipcMain, session } from 'electron'
import {
  resolveOsCacheRoot,
  clearElectronCaches,
  type ClearElectronCachesOptions,
  type ClearElectronCachesResult,
  type StorageCleanupDeps
} from './storage-cleanup'
import { isUpdateDownloading } from './updater'

/** electron-builder `build.appId`; namespaces the OS-level cache directories. */
const APP_ID = 'com.nerdtechnic.agent-team'
/** package.json `name` — electron-updater names its cache `<name>-updater`. */
const PACKAGE_NAME = 'agent-team'

/** Recursive size in bytes. Missing paths and symlinks count as 0. */
function dirSize(path: string): number {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return 0
  }
  if (stat.isSymbolicLink()) return 0
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return 0
  let total = 0
  for (const entry of listDir(path)) total += dirSize(join(path, entry))
  return total
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

async function clearSessionCaches(): Promise<void> {
  const current = session.defaultSession
  await current.clearCache()
  // Present since Electron 22 but guarded so an older runtime still clears the
  // HTTP cache instead of failing the whole operation.
  if (typeof current.clearCodeCaches === 'function') current.clearCodeCaches({})
}

function storageDeps(): StorageCleanupDeps {
  return {
    userData: app.getPath('userData'),
    cacheRoot: resolveOsCacheRoot(process.platform, homedir()),
    appNames: [PACKAGE_NAME, app.getName()],
    appId: APP_ID,
    dirSize,
    removeDir,
    listDir,
    clearSessionCaches,
    isUpdateDownloading
  }
}

/** Register the `storage:*` handlers exactly once. */
export function registerStorageIpc(): void {
  ipcMain.handle(
    'storage:clear-electron-caches',
    async (_event, options: ClearElectronCachesOptions): Promise<ClearElectronCachesResult> => {
      try {
        return await clearElectronCaches(
          { chromium: Boolean(options?.chromium), updater: Boolean(options?.updater) },
          storageDeps()
        )
      } catch (e) {
        return { ok: false, freedBytes: 0, error: String(e) }
      }
    }
  )
}
