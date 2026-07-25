import type { UpdateActionResult, UpdateSeverity, UpdateState } from '../shared/updater'

interface UpdateInfoLike {
  version: string
  releaseNotes?: string | Array<{ version?: string; note?: string | null }> | null
}

interface CheckResultLike {
  isUpdateAvailable?: boolean
  updateInfo?: UpdateInfoLike
}

export interface UpdaterClient {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<CheckResultLike | null>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterService {
  getState(): UpdateState
  check(options?: { silent?: boolean }): Promise<UpdateActionResult>
  download(): Promise<UpdateActionResult>
  install(): UpdateActionResult
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// electron-updater's UpdateInfo.releaseNotes may be a string, an array of
// { version, note } entries, or null. Normalize to a single string (or
// undefined when there is nothing meaningful to show).
function normalizeReleaseNotes(notes: UpdateInfoLike['releaseNotes']): string | undefined {
  if (typeof notes === 'string') return notes.trim() ? notes : undefined
  if (Array.isArray(notes)) {
    const joined = notes
      .map((entry) => (typeof entry?.note === 'string' ? entry.note : ''))
      .filter((note) => note.trim().length > 0)
      .join('\n\n')
    return joined.length > 0 ? joined : undefined
  }
  return undefined
}

// Classify how far availableVersion is from currentVersion (semver X.Y.Z).
// Unparsable versions count as 'major' — the safest reading is to ask the user
// rather than silently auto-download an unknown jump.
export function computeUpdateSeverity(current: string, available: string): UpdateSeverity {
  const parse = (version: string): [number, number] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
    return match ? [Number(match[1]), Number(match[2])] : null
  }
  const from = parse(current)
  const to = parse(available)
  if (!from || !to) return 'major'
  if (from[0] !== to[0]) return 'major'
  if (from[1] !== to[1]) return 'minor'
  return 'patch'
}

export function createUpdaterService(
  client: UpdaterClient,
  currentVersion: string,
  supported: boolean,
  onStateChanged: (state: UpdateState) => void,
): UpdaterService {
  let state: UpdateState = supported
    ? { status: 'idle', currentVersion }
    : {
        status: 'unsupported',
        currentVersion,
        message: 'Updates are not available for this build.',
      }
  let checkPromise: Promise<UpdateActionResult> | null = null
  let downloadPromise: Promise<UpdateActionResult> | null = null
  // True while a silent (startup/periodic) check is in flight. When set,
  // provider errors are logged but never surfaced as an 'error' state.
  let silentActive = false

  const snapshot = (): UpdateState => ({ ...state })
  const setState = (next: UpdateState): void => {
    state = next
    onStateChanged(snapshot())
  }
  const success = (): UpdateActionResult => ({ ok: true, state: snapshot() })
  const failure = (message: string): UpdateActionResult => ({ ok: false, state: snapshot(), error: message })

  client.autoDownload = false
  client.autoInstallOnAppQuit = false

  if (supported) {
    client.on('checking-for-update', () => {
      setState({ status: 'checking', currentVersion, availableVersion: state.availableVersion })
    })
    client.on('update-available', (info) => {
      setState({
        status: 'available',
        currentVersion,
        availableVersion: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        severity: computeUpdateSeverity(currentVersion, info.version),
        checkedAt: new Date().toISOString(),
      })
    })
    client.on('update-not-available', () => {
      setState({ status: 'not-available', currentVersion, checkedAt: new Date().toISOString() })
    })
    client.on('download-progress', (progress) => {
      setState({
        status: 'downloading',
        currentVersion,
        availableVersion: state.availableVersion,
        releaseNotes: state.releaseNotes,
        severity: state.severity,
        percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      })
    })
    client.on('update-downloaded', (info) => {
      setState({
        status: 'downloaded',
        currentVersion,
        availableVersion: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes) ?? state.releaseNotes,
        severity: computeUpdateSeverity(currentVersion, info.version),
        percent: 100,
      })
    })
    client.on('error', (error) => {
      const message = errorMessage(error)
      // Silent checks (startup/periodic) must not disrupt the visible state on
      // a transient network/feed error; log and leave the state as-is.
      if (silentActive) {
        console.warn('[updater] silent check error:', message)
        return
      }
      setState({
        status: 'error',
        currentVersion,
        availableVersion: state.availableVersion,
        message,
      })
    })
  }

  async function check({ silent = false }: { silent?: boolean } = {}): Promise<UpdateActionResult> {
    if (!supported) return failure(state.message ?? 'Updates are not supported in this build.')
    if (checkPromise) return checkPromise
    if (downloadPromise || state.status === 'installing') return success()
    // Re-checking while an update is already downloaded is allowed — a newer
    // release may have shipped since. Snapshot the ready-to-install state so
    // anything short of a strictly newer version restores it (the provider
    // re-emits 'update-available' even for the version we already hold).
    const downloadedBefore = state.status === 'downloaded' ? snapshot() : null
    const restoreDownloaded = (): void => {
      if (!downloadedBefore) return
      // Leave the state alone when the check surfaced a strictly newer version
      // or a download cycle is already running/complete.
      if (state.status === 'downloading' || state.status === 'downloaded') return
      if (state.status === 'available' && state.availableVersion !== downloadedBefore.availableVersion) return
      setState({ ...downloadedBefore })
    }

    checkPromise = (async () => {
      silentActive = silent
      setState({ status: 'checking', currentVersion, availableVersion: state.availableVersion })
      try {
        const result = await client.checkForUpdates()
        // electron-updater normally emits an event before resolving. Keep a
        // deterministic fallback for providers/mocks that only return a result.
        if (state.status === 'checking') {
          const version = result?.updateInfo?.version
          if (result?.isUpdateAvailable && version) {
            setState({
              status: 'available',
              currentVersion,
              availableVersion: version,
              releaseNotes: normalizeReleaseNotes(result?.updateInfo?.releaseNotes),
              severity: computeUpdateSeverity(currentVersion, version),
              checkedAt: new Date().toISOString(),
            })
          } else {
            setState({ status: 'not-available', currentVersion, checkedAt: new Date().toISOString() })
          }
        }
        restoreDownloaded()
        if (state.status === 'error') return failure(state.message ?? 'Update check failed.')
        return success()
      } catch (error) {
        const message = errorMessage(error)
        // A silent check must never surface an error state; log only and settle
        // into not-available if we are still mid-check.
        if (silent) {
          console.warn('[updater] silent check failed:', message)
          if (state.status === 'checking') {
            setState({ status: 'not-available', currentVersion, checkedAt: new Date().toISOString() })
          }
          restoreDownloaded()
          return failure(message)
        }
        if (state.status !== 'error' || state.message !== message) {
          setState({ status: 'error', currentVersion, message })
        }
        restoreDownloaded()
        return failure(message)
      } finally {
        silentActive = false
        checkPromise = null
      }
    })()
    return checkPromise
  }

  async function download(): Promise<UpdateActionResult> {
    if (!supported) return failure(state.message ?? 'Updates are not supported in this build.')
    if (downloadPromise) return downloadPromise
    if (state.status === 'downloaded') return success()
    if (state.status !== 'available' && state.status !== 'error') {
      return failure('No update is ready to download.')
    }
    const availableVersion = state.availableVersion
    if (!availableVersion) return failure('No update is ready to download.')

    const releaseNotes = state.releaseNotes
    const severity = state.severity
    downloadPromise = (async () => {
      setState({ status: 'downloading', currentVersion, availableVersion, releaseNotes, severity, percent: 0 })
      try {
        await client.downloadUpdate()
        if (state.status === 'error') return failure(state.message ?? 'Update download failed.')
        if (state.status === 'downloading') {
          setState({ status: 'downloaded', currentVersion, availableVersion, releaseNotes, severity, percent: 100 })
        }
        return success()
      } catch (error) {
        const message = errorMessage(error)
        if (state.status !== 'error' || state.message !== message) {
          setState({ status: 'error', currentVersion, availableVersion, message })
        }
        return failure(message)
      } finally {
        downloadPromise = null
      }
    })()
    return downloadPromise
  }

  function install(): UpdateActionResult {
    if (state.status !== 'downloaded') return failure('No downloaded update is ready to install.')
    setState({
      status: 'installing',
      currentVersion,
      availableVersion: state.availableVersion,
      percent: 100,
    })
    try {
      client.quitAndInstall(false, true)
      return success()
    } catch (error) {
      const message = errorMessage(error)
      setState({
        status: 'error',
        currentVersion,
        availableVersion: state.availableVersion,
        message,
      })
      return failure(message)
    }
  }

  return { getState: snapshot, check, download, install }
}
