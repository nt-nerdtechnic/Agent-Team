// @vitest-environment happy-dom
import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUpdater, type RendererUpdateState } from '../useUpdater'
import {
  DEFAULT_CHECK_FAILURE_THRESHOLD,
  DEFAULT_DOWNLOAD_RETRY_COUNT,
  DEFAULT_INSTALL_TIMEOUT_SECONDS,
} from '../../../../shared/updater'

const mounted: Array<ReturnType<typeof mount>> = []

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  window.agentTeam = undefined
})

function mountUpdater() {
  let composable!: ReturnType<typeof useUpdater>
  const wrapper = mount(defineComponent({
    setup() {
      composable = useUpdater()
      return () => null
    },
  }))
  mounted.push(wrapper)
  return composable
}

describe('useUpdater', () => {
  it('hydrates the main-process snapshot and disposes its subscription', async () => {
    const dispose = vi.fn()
    let listener!: (state: RendererUpdateState) => void
    window.agentTeam = {
      version: '1.0.0',
      updater: {
        getState: vi.fn().mockResolvedValue({ status: 'available', currentVersion: '1.0.0', availableVersion: '1.1.0' }),
        onStateChanged: vi.fn((cb) => { listener = cb; return dispose }),
      },
    } as unknown as typeof window.agentTeam

    const updater = mountUpdater()
    await nextTick()
    await nextTick()
    expect(updater.state.value).toMatchObject({ status: 'available', availableVersion: '1.1.0' })

    listener({ status: 'downloading', currentVersion: '1.0.0', availableVersion: '1.1.0', percent: 25 })
    expect(updater.state.value).toMatchObject({ status: 'downloading', percent: 25 })
    mounted.pop()!.unmount()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('runs actions and adopts their returned state', async () => {
    const downloaded: RendererUpdateState = {
      status: 'downloaded', currentVersion: '1.0.0', availableVersion: '1.1.0', percent: 100,
    }
    const download = vi.fn().mockResolvedValue({ ok: true, state: downloaded })
    window.agentTeam = {
      version: '1.0.0',
      updater: {
        getState: vi.fn().mockResolvedValue({ status: 'available', currentVersion: '1.0.0', availableVersion: '1.1.0' }),
        onStateChanged: vi.fn(() => vi.fn()),
        download,
      },
    } as unknown as typeof window.agentTeam

    const updater = mountUpdater()
    await nextTick()
    await updater.startDownload()
    expect(download).toHaveBeenCalledOnce()
    expect(updater.state.value).toEqual(downloaded)
  })

  it('surfaces rejected IPC actions as errors', async () => {
    window.agentTeam = {
      version: '1.0.0',
      updater: {
        getState: vi.fn().mockResolvedValue({ status: 'idle', currentVersion: '1.0.0' }),
        onStateChanged: vi.fn(() => vi.fn()),
        check: vi.fn().mockRejectedValue(new Error('offline')),
      },
    } as unknown as typeof window.agentTeam

    const updater = mountUpdater()
    await updater.checkForUpdates()
    expect(updater.state.value).toMatchObject({ status: 'error', message: 'offline' })
  })

  it('hydrates settings on mount and adopts updates from setSettings', async () => {
    const setSettings = vi.fn().mockResolvedValue({
      ok: true,
      settings: { autoCheck: false, autoDownload: true, channel: 'beta' },
    })
    window.agentTeam = {
      version: '1.0.0',
      updater: {
        getState: vi.fn().mockResolvedValue({ status: 'idle', currentVersion: '1.0.0' }),
        onStateChanged: vi.fn(() => vi.fn()),
        getSettings: vi.fn().mockResolvedValue({ autoCheck: true, autoDownload: false, channel: 'stable' }),
        setSettings,
      },
    } as unknown as typeof window.agentTeam

    const updater = mountUpdater()
    await nextTick()
    await nextTick()
    expect(updater.settings.value).toEqual({ autoCheck: true, autoDownload: false, channel: 'stable' })

    await updater.updateSettings({ channel: 'beta', autoCheck: false })
    expect(setSettings).toHaveBeenCalledWith({ channel: 'beta', autoCheck: false })
    expect(updater.settings.value).toEqual({ autoCheck: false, autoDownload: true, channel: 'beta' })
  })

  it('keeps default settings when the settings IPC is unavailable', async () => {
    window.agentTeam = {
      version: '1.0.0',
      updater: {
        getState: vi.fn().mockResolvedValue({ status: 'idle', currentVersion: '1.0.0' }),
        onStateChanged: vi.fn(() => vi.fn()),
      },
    } as unknown as typeof window.agentTeam

    const updater = mountUpdater()
    await nextTick()
    await nextTick()
    // toMatchObject, not toEqual: the point is that the fallbacks survive an
    // unreachable IPC, not that the settings shape never grows a field.
    expect(updater.settings.value).toMatchObject({
      autoCheck: true, autoDownload: true, autoInstallOnQuit: false, channel: 'stable',
      notifyOnCheckFailure: true,
      checkFailureThreshold: DEFAULT_CHECK_FAILURE_THRESHOLD,
      retryDownload: true,
      downloadRetryCount: DEFAULT_DOWNLOAD_RETRY_COUNT,
      installTimeoutSeconds: DEFAULT_INSTALL_TIMEOUT_SECONDS,
    })
    await expect(updater.updateSettings({ channel: 'beta' })).resolves.toBeUndefined()
  })
})
