import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateSettingsResult, UpdaterSettings, UpdateState } from '../shared/updater'

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

// Derive the signature from the module so a new option never needs restating.
async function loadInitUpdater(): Promise<typeof import('./updater').initUpdater> {
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

  it('leaves quit-time installs off until the user asks for them', async () => {
    // Downloading and installing are separate decisions: an app that upgraded
    // into this feature must not start applying updates on quit by itself.
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })

    expect(h.ipcHandlers.get('updater:get-settings')!()).toMatchObject({ autoInstallOnQuit: false })
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('hands quit-time installs to electron-updater once enabled', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })

    const setSettings = h.ipcHandlers.get('updater:set-settings')!
    await setSettings({}, { autoInstallOnQuit: true } as Partial<UpdaterSettings>)
    expect(h.ipcHandlers.get('updater:get-settings')!()).toMatchObject({ autoInstallOnQuit: true })
    // And back off again — the switch has to be reversible without a restart.
    await setSettings({}, { autoInstallOnQuit: false } as Partial<UpdaterSettings>)
    expect(h.ipcHandlers.get('updater:get-settings')!()).toMatchObject({ autoInstallOnQuit: false })
  })

  it('restores a stored quit-time install preference on the next launch', async () => {
    const first = await loadInitUpdater()
    first({ enabled: true, currentVersion: '1.0.0' })
    await h.ipcHandlers.get('updater:set-settings')!({}, { autoInstallOnQuit: true } as Partial<UpdaterSettings>)

    const second = await loadInitUpdater()
    second({ enabled: true, currentVersion: '1.0.0' })
    expect(h.ipcHandlers.get('updater:get-settings')!()).toMatchObject({ autoInstallOnQuit: true })
  })

  it('arms the quit-time install only once the download has landed', async () => {
    // End-to-end for the timing that matters: electron-updater reads
    // autoInstallOnAppQuit when a download finishes, so it must be off during
    // the transfer and on afterwards — not simply mirror the setting.
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })
    await h.ipcHandlers.get('updater:set-settings')!({}, { autoInstallOnQuit: true } as Partial<UpdaterSettings>)

    emit('update-available', { version: '1.0.1' })
    await flush()
    expect(h.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false)

    emit('update-downloaded', { version: '1.0.1' })
    await flush()
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(true)
    expect(h.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('waives the quit confirmation before an install takes the app down', async () => {
    // quitAndInstall quits the app, which would otherwise raise the "Quit?"
    // dialog on top of the confirmation the user just answered — and cancelling
    // that dialog does not un-stage the update, so the question would be a lie.
    const onInstallStarting = vi.fn()
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0', onInstallStarting })

    emit('update-available', { version: '1.0.1' })
    await flush()
    emit('update-downloaded', { version: '1.0.1' })
    await flush()
    expect(onInstallStarting).not.toHaveBeenCalled()

    await h.ipcHandlers.get('updater:install')!()

    expect(onInstallStarting).toHaveBeenCalledOnce()
    expect(h.autoUpdater.quitAndInstall).toHaveBeenCalled()
    // Order matters: quitAndInstall can take the app down synchronously.
    expect(onInstallStarting.mock.invocationCallOrder[0])
      .toBeLessThan(h.autoUpdater.quitAndInstall.mock.invocationCallOrder[0])
  })

  it('hands back the waived quit confirmation when the install is refused outright', async () => {
    // Nothing downloaded: install() rejects its precondition and the app stays
    // up. Without the rollback, every later Cmd+Q would skip the user's
    // "confirm before quit" dialog for the rest of the run.
    const onInstallStarting = vi.fn()
    const onInstallAbandoned = vi.fn()
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0', onInstallStarting, onInstallAbandoned })

    await h.ipcHandlers.get('updater:install')!()

    expect(onInstallStarting).toHaveBeenCalledOnce()
    expect(onInstallAbandoned).toHaveBeenCalledOnce()
  })

  it('hands back the waived quit confirmation when a stuck install times out', async () => {
    const onInstallAbandoned = vi.fn()
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0', onInstallAbandoned })
    await h.ipcHandlers.get('updater:set-settings')!({}, { installTimeoutSeconds: 5 } as Partial<UpdaterSettings>)

    emit('update-downloaded', { version: '1.0.1' })
    h.ipcHandlers.get('updater:install')!()
    expect(onInstallAbandoned).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5000)
    expect(onInstallAbandoned).toHaveBeenCalledOnce()
  })

  it('hands back the waived quit confirmation when quitAndInstall throws', async () => {
    const onInstallAbandoned = vi.fn()
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0', onInstallAbandoned })
    h.autoUpdater.quitAndInstall.mockImplementation(() => { throw new Error('spawn failed') })

    emit('update-downloaded', { version: '1.0.1' })
    await h.ipcHandlers.get('updater:install')!()

    expect(onInstallAbandoned).toHaveBeenCalledOnce()
  })

  it('never arms a quit-time install on an unsupported build', async () => {
    // Nothing was ever downloaded there, so promising one would be a lie.
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: false, currentVersion: '1.0.0' })

    await h.ipcHandlers.get('updater:set-settings')!({}, { autoInstallOnQuit: true } as Partial<UpdaterSettings>)
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('does not retry a failed download when retries are switched off', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })
    await h.ipcHandlers.get('updater:set-settings')!({}, { retryDownload: false } as Partial<UpdaterSettings>)

    h.autoUpdater.downloadUpdate.mockRejectedValue(new Error('ECONNRESET'))
    emit('update-available', { version: '1.0.1' })
    await flush()
    await flush()
    expect(h.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('retries a failed download as many times as the user asked for', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })
    await h.ipcHandlers.get('updater:set-settings')!({}, { downloadRetryCount: 1 } as Partial<UpdaterSettings>)

    h.autoUpdater.downloadUpdate.mockRejectedValue(new Error('ECONNRESET'))
    emit('update-available', { version: '1.0.1' })
    await flush()
    expect(h.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(h.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
    // One retry was all that was asked for.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('uses the configured install timeout to release a stuck install', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater({ enabled: true, currentVersion: '1.0.0' })
    await h.ipcHandlers.get('updater:set-settings')!({}, { installTimeoutSeconds: 5 } as Partial<UpdaterSettings>)
    const getState = (): UpdateState => h.ipcHandlers.get('updater:get-state')!() as UpdateState

    emit('update-downloaded', { version: '1.0.1' })
    h.ipcHandlers.get('updater:install')!()
    expect(getState().status).toBe('installing')

    await vi.advanceTimersByTimeAsync(5000)
    expect(getState().status).toBe('downloaded')
  })

  it('carries the last successful check across a restart', async () => {
    const first = await loadInitUpdater()
    first({ enabled: true, currentVersion: '1.0.0' })
    emit('update-not-available', {})
    const checkedAt = (h.ipcHandlers.get('updater:get-state')!() as UpdateState).checkedAt
    expect(checkedAt).toBeTruthy()

    const second = await loadInitUpdater()
    second({ enabled: true, currentVersion: '1.0.0' })
    expect(h.ipcHandlers.get('updater:get-state')!()).toMatchObject({ status: 'idle', checkedAt })
  })

  it('carries a run of failed background checks across a restart', async () => {
    h.autoUpdater.checkForUpdates.mockRejectedValue(new Error('feed unavailable'))
    const first = await loadInitUpdater()
    first({ enabled: true, currentVersion: '1.0.0' })

    // The startup check is silent, so only the failure counter records it.
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.ipcHandlers.get('updater:get-state')!()).toMatchObject({
      lastCheckFailure: { count: 1, message: 'feed unavailable' },
    })

    const second = await loadInitUpdater()
    second({ enabled: true, currentVersion: '1.0.0' })
    expect(h.ipcHandlers.get('updater:get-state')!()).toMatchObject({
      lastCheckFailure: { count: 1, message: 'feed unavailable' },
    })
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
