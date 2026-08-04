import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { UpdateState, UpdaterSettings } from '../../../shared/updater'
import {
  DEFAULT_CHECK_FAILURE_THRESHOLD,
  DEFAULT_DOWNLOAD_RETRY_COUNT,
  DEFAULT_INSTALL_TIMEOUT_SECONDS,
} from '../../../shared/updater'

export type RendererUpdateState = UpdateState

const DEFAULT_SETTINGS: UpdaterSettings = {
  autoCheck: true,
  autoDownload: true,
  autoInstallOnQuit: false,
  channel: 'stable',
  notifyOnCheckFailure: true,
  checkFailureThreshold: DEFAULT_CHECK_FAILURE_THRESHOLD,
  retryDownload: true,
  downloadRetryCount: DEFAULT_DOWNLOAD_RETRY_COUNT,
  installTimeoutSeconds: DEFAULT_INSTALL_TIMEOUT_SECONDS,
}

export function useUpdater() {
  const state = ref<RendererUpdateState>({
    status: 'idle',
    currentVersion: window.agentTeam?.version ?? '',
  })
  const settings = ref<UpdaterSettings>({ ...DEFAULT_SETTINGS })
  let dispose: (() => void) | undefined

  async function loadSettings(): Promise<void> {
    const api = window.agentTeam?.updater
    if (!api?.getSettings) return
    try {
      settings.value = await api.getSettings()
    } catch {
      // Keep defaults if the main process cannot answer.
    }
  }

  async function updateSettings(patch: Partial<UpdaterSettings>): Promise<void> {
    const api = window.agentTeam?.updater
    if (!api?.setSettings) return
    try {
      const result = await api.setSettings(patch)
      if (result.ok) settings.value = result.settings
    } catch {
      // Leave the UI on the last known-good settings.
    }
  }

  onMounted(() => {
    const api = window.agentTeam?.updater
    if (!api) return
    dispose = api.onStateChanged((next) => { state.value = next })
    void api.getState().then((next) => { state.value = next }).catch((error: unknown) => {
      state.value = {
        ...state.value,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    })
    void loadSettings()
  })

  onUnmounted(() => dispose?.())

  async function run(action: 'check' | 'download' | 'install'): Promise<void> {
    const api = window.agentTeam?.updater
    if (!api) return
    try {
      const result = await api[action]()
      state.value = result.state
    } catch (error) {
      state.value = {
        ...state.value,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return {
    state,
    settings,
    isBusy: computed(() => ['checking', 'downloading', 'installing'].includes(state.value.status)),
    checkForUpdates: (): Promise<void> => run('check'),
    startDownload: (): Promise<void> => run('download'),
    installUpdate: (): Promise<void> => run('install'),
    loadSettings,
    updateSettings,
  }
}
