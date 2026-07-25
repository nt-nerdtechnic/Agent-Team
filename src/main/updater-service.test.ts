import { describe, expect, it, vi } from 'vitest'
import { computeUpdateSeverity, createUpdaterService, type UpdaterClient } from './updater-service'
import type { UpdateState } from '../shared/updater'

type Listener = (...args: never[]) => void

function fakeClient() {
  const listeners = new Map<string, Listener[]>()
  const client = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    checkForUpdates: vi.fn().mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } }),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
  }
  const emit = (event: string, value?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(value as never)
  }
  return { client: client as unknown as UpdaterClient, raw: client, emit }
}

describe('computeUpdateSeverity', () => {
  it('classifies patch, minor, and major version jumps', () => {
    expect(computeUpdateSeverity('1.2.3', '1.2.4')).toBe('patch')
    expect(computeUpdateSeverity('1.2.3', '1.3.0')).toBe('minor')
    expect(computeUpdateSeverity('1.2.3', '2.0.0')).toBe('major')
  })

  it('tolerates a leading v prefix', () => {
    expect(computeUpdateSeverity('v1.2.3', 'v1.2.9')).toBe('patch')
  })

  it('treats unparsable versions as major so the user is asked', () => {
    expect(computeUpdateSeverity('garbage', '1.2.4')).toBe('major')
    expect(computeUpdateSeverity('1.2.3', 'nightly')).toBe('major')
    expect(computeUpdateSeverity('', '')).toBe('major')
  })
})

describe('createUpdaterService', () => {
  it('reports dev builds as unsupported without contacting a provider', async () => {
    const { client, raw } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', false, vi.fn())

    expect(service.getState().status).toBe('unsupported')
    expect((await service.check()).ok).toBe(false)
    expect(raw.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checks and falls back to a deterministic not-available state', async () => {
    const { client } = fakeClient()
    const states: UpdateState[] = []
    const service = createUpdaterService(client, '1.0.0', true, (state) => states.push(state))

    expect((await service.check()).ok).toBe(true)
    expect(service.getState().status).toBe('not-available')
    expect(states.map((state) => state.status)).toEqual(['checking', 'not-available'])
  })

  it('serializes checks and preserves the available version through download', async () => {
    const { client, raw, emit } = fakeClient()
    let resolveCheck!: (value: { isUpdateAvailable: boolean; updateInfo: { version: string } }) => void
    let resolveDownload!: (value: string[]) => void
    raw.checkForUpdates.mockReturnValue(new Promise((resolve) => { resolveCheck = resolve }))
    raw.downloadUpdate.mockReturnValue(new Promise((resolve) => { resolveDownload = resolve }))
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const first = service.check()
    const second = service.check()
    expect(raw.checkForUpdates).toHaveBeenCalledTimes(1)
    emit('update-available', { version: '1.1.0' })
    resolveCheck({ isUpdateAvailable: true, updateInfo: { version: '1.1.0' } })
    await Promise.all([first, second])

    const download = service.download()
    expect(raw.downloadUpdate).toHaveBeenCalledOnce()
    emit('download-progress', { percent: 42.4 })
    expect(service.getState()).toMatchObject({
      status: 'downloading', availableVersion: '1.1.0', percent: 42, severity: 'minor',
    })
    emit('update-downloaded', { version: '1.1.0' })
    resolveDownload([])
    expect((await download).ok).toBe(true)
    expect(service.getState()).toMatchObject({ status: 'downloaded', severity: 'minor' })
  })

  it('only installs a downloaded update', () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    expect(service.install().ok).toBe(false)
    emit('update-downloaded', { version: '1.1.0' })
    expect(service.install().ok).toBe(true)
    expect(raw.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(service.getState().status).toBe('installing')
  })

  it('turns provider failures into a retryable error state', async () => {
    const { client, raw } = fakeClient()
    raw.checkForUpdates.mockRejectedValue(new Error('feed unavailable'))
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const result = await service.check()
    expect(result).toMatchObject({ ok: false, error: 'feed unavailable' })
    expect(service.getState()).toMatchObject({ status: 'error', message: 'feed unavailable' })
  })

  it('returns failure when the provider emits an error but resolves the operation', async () => {
    const { client, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const check = service.check()
    emit('error', new Error('bad metadata'))
    await expect(check).resolves.toMatchObject({ ok: false, error: 'bad metadata' })
  })

  it('finishes downloading when a provider resolves without a downloaded event', async () => {
    const { client, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    emit('update-available', { version: '1.1.0' })

    await expect(service.download()).resolves.toMatchObject({ ok: true })
    expect(service.getState()).toMatchObject({
      status: 'downloaded', availableVersion: '1.1.0', percent: 100,
    })
  })

  it('captures and normalizes release notes from string and array shapes', () => {
    const { client, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    emit('update-available', { version: '1.1.0', releaseNotes: '  Fixes  ' })
    expect(service.getState().releaseNotes).toBe('  Fixes  ')

    emit('update-downloaded', {
      version: '1.1.0',
      releaseNotes: [{ version: '1.1.0', note: 'Line A' }, { version: '1.0.9', note: 'Line B' }],
    })
    expect(service.getState().releaseNotes).toBe('Line A\n\nLine B')
  })

  it('does not surface a provider error during a silent check', async () => {
    const { client, raw } = fakeClient()
    raw.checkForUpdates.mockRejectedValue(new Error('feed unavailable'))
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const result = await service.check({ silent: true })
    expect(result.ok).toBe(false)
    // Silent: state settles to not-available, never 'error'.
    expect(service.getState().status).toBe('not-available')
  })

  it('ignores an emitted error event while a silent check is in flight', async () => {
    const { client, raw, emit } = fakeClient()
    let resolveCheck!: (value: { isUpdateAvailable: boolean }) => void
    raw.checkForUpdates.mockReturnValue(new Promise((resolve) => { resolveCheck = resolve }))
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const check = service.check({ silent: true })
    emit('error', new Error('transient'))
    expect(service.getState().status).not.toBe('error')
    resolveCheck({ isUpdateAvailable: false })
    await check
    expect(service.getState().status).toBe('not-available')
  })

  it('still reports errors for a manual (non-silent) check', async () => {
    const { client, raw } = fakeClient()
    raw.checkForUpdates.mockRejectedValue(new Error('feed unavailable'))
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const result = await service.check({ silent: false })
    expect(result).toMatchObject({ ok: false, error: 'feed unavailable' })
    expect(service.getState()).toMatchObject({ status: 'error', message: 'feed unavailable' })
  })

  it('re-checks while downloaded and moves to a strictly newer version', async () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    emit('update-downloaded', { version: '1.0.1' })

    raw.checkForUpdates.mockImplementation(async () => {
      emit('update-available', { version: '1.0.2' })
      return { isUpdateAvailable: true, updateInfo: { version: '1.0.2' } }
    })
    expect((await service.check({ silent: true })).ok).toBe(true)
    expect(raw.checkForUpdates).toHaveBeenCalledOnce()
    expect(service.getState()).toMatchObject({ status: 'available', availableVersion: '1.0.2' })
  })

  it('keeps the downloaded state when a re-check finds the same version', async () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    emit('update-downloaded', { version: '1.0.1' })

    raw.checkForUpdates.mockImplementation(async () => {
      // The provider re-announces the version we already hold.
      emit('update-available', { version: '1.0.1' })
      return { isUpdateAvailable: true, updateInfo: { version: '1.0.1' } }
    })
    expect((await service.check({ silent: true })).ok).toBe(true)
    expect(service.getState()).toMatchObject({ status: 'downloaded', availableVersion: '1.0.1', percent: 100 })
  })

  it('restores the downloaded state when a re-check fails', async () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    emit('update-downloaded', { version: '1.0.1' })

    raw.checkForUpdates.mockRejectedValue(new Error('feed unavailable'))
    expect((await service.check({ silent: true })).ok).toBe(false)
    expect(service.getState()).toMatchObject({ status: 'downloaded', availableVersion: '1.0.1' })

    expect((await service.check({ silent: false })).ok).toBe(false)
    expect(service.getState()).toMatchObject({ status: 'downloaded', availableVersion: '1.0.1' })
  })
})
