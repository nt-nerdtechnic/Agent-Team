import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { app, ipcMain, BrowserWindow } from 'electron'
import {
  createUpdaterService,
  DEFAULT_DOWNLOAD_RETRY_DELAYS_MS,
  type RestoredUpdateState,
  type UpdaterService,
} from './updater-service'
import { readUpdaterSettings, writeUpdaterSettings } from './updater-settings'
import { readUpdaterState, writeUpdaterState } from './updater-state-store'
import type { UpdateSettingsResult, UpdaterSettings, UpdateState, UpdateStatus } from '../shared/updater'

let service: UpdaterService | null = null
let settings: UpdaterSettings | null = null
let settingsFile = ''
let stateFile = ''
let persistedState = ''
let periodicTimer: ReturnType<typeof setInterval> | null = null

// Re-check for updates every 30 minutes in addition to the one-shot startup
// check, so a release published while the app is already running is picked up
// without waiting hours. Both are silent so a transient feed/network error
// never pops an error badge.
const PERIODIC_CHECK_MS = 30 * 60 * 1000

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

// Mirror the durable slice of the state to disk. Only the fields that outlive a
// session are written, and only when they actually change — download-progress
// alone publishes a new state several times a second.
function persistState(state: UpdateState): void {
  if (!stateFile) return
  const durable: RestoredUpdateState = {
    // checkedAt is absent from most statuses ('checking', 'downloading', …),
    // so carry the last known value forward rather than erasing it.
    checkedAt: state.checkedAt ?? readLastCheckedAt(),
    lastCheckFailure: state.lastCheckFailure,
  }
  const encoded = JSON.stringify(durable)
  if (encoded === persistedState) return
  persistedState = encoded
  writeUpdaterState(stateFile, durable)
}

function readLastCheckedAt(): string | undefined {
  if (!persistedState) return undefined
  try {
    return (JSON.parse(persistedState) as RestoredUpdateState).checkedAt
  } catch {
    return undefined
  }
}

function publishState(state: UpdateState): void {
  broadcast('updater:state-changed', state)
  persistState(state)
  if (state.status === 'error') console.error('[updater]', state.message)
  // Background auto-download: once an update is detected, kick off the download
  // without user action when enabled. download() is idempotent and only
  // proceeds from the 'available'/'error' states, so it self-guards against
  // double-download once it has moved the state to 'downloading'.
  // Only patch releases download silently; minor/major updates stay at
  // 'available' so the renderer can ask the user first.
  if (state.status === 'available' && state.severity === 'patch' && settings?.autoDownload) {
    queueMicrotask(() => {
      // Don't discard the result: a silent auto-download that fails otherwise
      // leaves no trace beyond the 'error' state. The service retries transient
      // failures itself; once it gives up, the next periodic check republishes
      // 'available' and this handler starts a fresh attempt.
      void service?.download().then((result) => {
        if (!result.ok) {
          console.warn('[updater] auto-download failed, will retry after the next check:', result.error)
        }
      })
    })
  }
}

// Turn the user's retry count into a backoff schedule. Retries disabled means
// an empty schedule; counts past the base schedule repeat its last delay.
function retryDelaysFor(current: UpdaterSettings | null): readonly number[] {
  if (!current?.retryDownload) return []
  const base = DEFAULT_DOWNLOAD_RETRY_DELAYS_MS
  return Array.from(
    { length: current.downloadRetryCount },
    (_, index) => base[Math.min(index, base.length - 1)],
  )
}

function applyChannel(next: UpdaterSettings): void {
  // NOTE: CI does not publish a beta feed yet; wiring the App side keeps it
  // ready. 'latest' is electron-updater's stable channel.
  autoUpdater.channel = next.channel === 'beta' ? 'beta' : 'latest'
  autoUpdater.allowPrerelease = next.channel === 'beta'
}

function startPeriodicCheck(): void {
  if (periodicTimer) return
  periodicTimer = setInterval(() => { void service?.check({ silent: true }) }, PERIODIC_CHECK_MS)
}

function stopPeriodicCheck(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer)
    periodicTimer = null
  }
}

/**
 * Updater states in which the download cache still holds a payload the app
 * needs: the transfer in flight, the finished installer waiting for the user
 * to restart, and the install already running. Updater state is purely
 * in-memory in the updater service, so this is the single source of truth —
 * callers that delete the updater cache must check it first.
 */
const CACHE_BUSY_STATUSES: readonly UpdateStatus[] = ['downloading', 'downloaded', 'installing']

/**
 * The updater status that currently owns the download cache, or `null` when
 * the cache is free to delete.
 */
export function updaterCacheBusyStatus(): UpdateStatus | null {
  const status = service?.getState().status
  return status && CACHE_BUSY_STATUSES.includes(status) ? status : null
}

export function initUpdater(options: {
  enabled: boolean
  currentVersion: string
  checkDelayMs?: number
}): void {
  if (service) return

  settingsFile = join(app.getPath('userData'), 'updater-settings.json')
  settings = readUpdaterSettings(settingsFile)
  stateFile = join(app.getPath('userData'), 'updater-state.json')
  const restored = readUpdaterState(stateFile)
  persistedState = JSON.stringify(restored)

  service = createUpdaterService(
    autoUpdater,
    options.currentVersion,
    options.enabled,
    publishState,
    {
      // Read through to `settings` on use, so changing either preference takes
      // effect without rebuilding the service.
      installTimeoutMs: () => (settings?.installTimeoutSeconds ?? 20) * 1000,
      downloadRetryDelaysMs: () => retryDelaysFor(settings),
      restored,
    },
  )

  if (options.enabled) {
    applyChannel(settings)
    service.setAutoInstallOnQuit(settings.autoInstallOnQuit)
  }

  ipcMain.handle('updater:get-state', () => service!.getState())
  ipcMain.handle('updater:check', () => service!.check())
  ipcMain.handle('updater:download', () => service!.download())
  ipcMain.handle('updater:install', () => service!.install())
  ipcMain.handle('updater:get-settings', (): UpdaterSettings => settings!)
  ipcMain.handle('updater:set-settings', (_event, patch: Partial<UpdaterSettings>): UpdateSettingsResult => {
    try {
      const wasAutoCheck = settings?.autoCheck ?? false
      settings = writeUpdaterSettings(settingsFile, patch ?? {})
      if (options.enabled) {
        applyChannel(settings)
        // Applies to the update already sitting in the cache too — turning the
        // switch on should not require re-downloading anything.
        service!.setAutoInstallOnQuit(settings.autoInstallOnQuit)
        if (settings.autoCheck) {
          startPeriodicCheck()
          // Turned on at runtime: check right away instead of waiting for the
          // next periodic tick, so ticking the box feels like it does something.
          if (!wasAutoCheck) void service!.check({ silent: true })
        } else {
          stopPeriodicCheck()
        }
        // If auto-download was just enabled and a patch update is already
        // waiting, start it now rather than waiting for the next check.
        // Minor/major updates always wait for the user's decision.
        const current = service!.getState()
        if (settings.autoDownload && current.status === 'available' && current.severity === 'patch') {
          queueMicrotask(() => { void service?.download() })
        }
      }
      return { ok: true, settings }
    } catch (error) {
      return {
        ok: false,
        settings: settings ?? readUpdaterSettings(settingsFile),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  app.on('will-quit', stopPeriodicCheck)

  if (options.enabled && settings.autoCheck) {
    setTimeout(() => { void service?.check({ silent: true }) }, options.checkDelayMs ?? 5000)
    startPeriodicCheck()
  }
}
