import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateSettingsResult, UpdaterSettings } from '../shared/updater'

// Shared, hoisted fakes for the electron / electron-updater module mocks.
const h = vi.hoisted(() => {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
  const appHandlers = new Map<string, () => void>()
  const autoUpdater = {
    channel: '' as string,
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn((event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  }
  return { listeners, ipcHandlers, appHandlers, autoUpdater, userData: { dir: '' } }
})

vi.mock('electron-updater', () => ({ autoUpdater: h.autoUpdater }))
vi.mock('electron', () => ({
  app: {
    getPath: () => h.userData.dir,
    on: (event: string, cb: () => void) => { h.appHandlers.set(event, cb) },
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { h.ipcHandlers.set(channel, fn) },
  },
  BrowserWindow: { getAllWindows: () => [] },
}))

const PERIODIC_MS = 30 * 60 * 1000

function emit(event: string, value?: unknown): void {
  for (const listener of h.listeners.get(event) ?? []) listener(value)
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1)
  await Promise.resolve()
}

async function loadInitUpdater(): Promise<(o: { enabled: boolean; currentVersion: string; checkDelayMs?: number }) => void> {
  vi.resetModules()
  return (await import('./updater')).initUpdater
}

describe('initUpdater lifecycle', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'updater-'))
    h.userData.dir = dir
    h.listeners.clear()
    h.ipcHandlers.clear()
    h.appHandlers.clear()
    h.autoUpdater.on.mockClear()
    h.autoUpdater.channel = ''
    h.autoUpdater.allowPrerelease = false
    h.autoUpdater.checkForUpdates.mockReset().mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '1.0.0' },
    })
    h.autoUpdater.downloadUpdate.mockReset().mockResolvedValue([])
    h.autoUpdater.quitAndInstall.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('applies the stable channel to autoUpdater on init', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })
    expect(h.autoUpdater.channel).toBe('latest')
    expect(h.autoUpdater.allowPrerelease).toBe(false)
  })

  it('runs a periodic silent check and stops it on will-quit', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })

    await vi.advanceTimersByTimeAsync(PERIODIC_MS)
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalled()

    const willQuit = h.appHandlers.get('will-quit')
    expect(willQuit).toBeTypeOf('function')
    willQuit!()

    h.autoUpdater.checkForUpdates.mockClear()
    await vi.advanceTimersByTimeAsync(PERIODIC_MS)
    expect(h.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('auto-downloads a patch update when autoDownload is on', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })

    emit('update-available', { version: '1.0.1' })
    await flush()
    expect(h.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not auto-download minor or major updates even with autoDownload on', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })

    emit('update-available', { version: '1.1.0' })
    await flush()
    emit('update-available', { version: '2.0.0' })
    await flush()
    expect(h.autoUpdater.downloadUpdate).not.toHaveBeenCalled()

    // The user can still start the download explicitly for any severity.
    const download = h.ipcHandlers.get('updater:download')!
    await download()
    expect(h.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not auto-download when autoDownload is disabled', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })

    const setSettings = h.ipcHandlers.get('updater:set-settings')!
    const result = (await setSettings({}, { autoDownload: false } as Partial<UpdaterSettings>)) as UpdateSettingsResult
    expect(result.ok).toBe(true)
    expect(result.settings.autoDownload).toBe(false)

    emit('update-available', { version: '1.0.1' })
    await flush()
    expect(h.autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('starts a waiting patch download when autoDownload is re-enabled, but not a major one', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })

    const setSettings = h.ipcHandlers.get('updater:set-settings')!
    await setSettings({}, { autoDownload: false } as Partial<UpdaterSettings>)

    emit('update-available', { version: '2.0.0' })
    await flush()
    await setSettings({}, { autoDownload: true } as Partial<UpdaterSettings>)
    await flush()
    expect(h.autoUpdater.downloadUpdate).not.toHaveBeenCalled()

    await setSettings({}, { autoDownload: false } as Partial<UpdaterSettings>)
    emit('update-available', { version: '1.0.1' })
    await flush()
    expect(h.autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    await setSettings({}, { autoDownload: true } as Partial<UpdaterSettings>)
    await flush()
    expect(h.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('checks immediately when autoCheck is switched on, but not when it was already on', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })
    const setSettings = h.ipcHandlers.get('updater:set-settings')!

    // A change that leaves autoCheck on (it starts on) must not re-check.
    await setSettings({}, { autoDownload: false } as Partial<UpdaterSettings>)
    await flush()
    expect(h.autoUpdater.checkForUpdates).not.toHaveBeenCalled()

    // Off, then on again → exactly one immediate check.
    await setSettings({}, { autoCheck: false } as Partial<UpdaterSettings>)
    await flush()
    h.autoUpdater.checkForUpdates.mockClear()
    await setSettings({}, { autoCheck: true } as Partial<UpdaterSettings>)
    await flush()
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('persists channel changes and re-applies them to autoUpdater', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })

    const getSettings = h.ipcHandlers.get('updater:get-settings')!
    expect(getSettings()).toMatchObject({ channel: 'stable', autoCheck: true, autoDownload: true })

    const setSettings = h.ipcHandlers.get('updater:set-settings')!
    await setSettings({}, { channel: 'beta' } as Partial<UpdaterSettings>)
    expect(h.autoUpdater.channel).toBe('beta')
    expect(h.autoUpdater.allowPrerelease).toBe(true)
    expect(getSettings()).toMatchObject({ channel: 'beta' })
  })
})
