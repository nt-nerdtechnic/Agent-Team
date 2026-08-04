export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'not-available'
  | 'error'

export type UpdateSeverity = 'patch' | 'minor' | 'major'

/**
 * A run of background checks that never reached the feed. Background checks
 * stay out of the visible status on purpose, so this rides alongside it —
 * without it a failing check is indistinguishable from "you are up to date".
 */
export interface UpdateCheckFailure {
  message: string
  /** Consecutive failed checks; reset to zero by the first one that succeeds. */
  count: number
  at: string
}

/**
 * How many consecutive background checks must fail before the failure is worth
 * showing outside the Updates panel. At the 30-minute check cadence the default
 * is roughly 90 minutes — long enough to ride out a transient network drop.
 */
export const DEFAULT_CHECK_FAILURE_THRESHOLD = 3
export const DEFAULT_DOWNLOAD_RETRY_COUNT = 3
export const DEFAULT_INSTALL_TIMEOUT_SECONDS = 20

export const CHECK_FAILURE_THRESHOLD_RANGE = { min: 1, max: 10 } as const
export const DOWNLOAD_RETRY_COUNT_RANGE = { min: 0, max: 5 } as const
export const INSTALL_TIMEOUT_SECONDS_RANGE = { min: 5, max: 120 } as const

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  percent?: number
  message?: string
  /** When a check last *succeeded*. A failed check never refreshes it. */
  checkedAt?: string
  releaseNotes?: string
  severity?: UpdateSeverity
  lastCheckFailure?: UpdateCheckFailure
}

export interface UpdateActionResult {
  ok: boolean
  state: UpdateState
  error?: string
}

export type UpdateChannel = 'stable' | 'beta'

export interface UpdaterSettings {
  autoCheck: boolean
  autoDownload: boolean
  /**
   * Apply a downloaded update when the user quits the app, instead of asking
   * them to restart for it. Deliberately separate from `autoDownload`: having
   * the payload on disk costs nothing, but installing it always restarts the
   * app and takes every running CLI pane with it — so the two decisions are
   * not the same decision. Off by default; installing stays explicit unless
   * the user asks for it.
   */
  autoInstallOnQuit: boolean
  channel: UpdateChannel
  /**
   * Surface a run of failed background checks outside the Updates panel. Off
   * means the count is still tracked and shown in the panel, just never in the
   * status bar — for someone who works offline and does not want the reminder.
   */
  notifyOnCheckFailure: boolean
  /** Consecutive failed checks before the reminder appears. */
  checkFailureThreshold: number
  /** Retry a failed download automatically on a bounded backoff. */
  retryDownload: boolean
  /** How many retries; ignored when retryDownload is off. */
  downloadRetryCount: number
  /**
   * How long quitAndInstall gets to take the process over before the update is
   * handed back as "ready to install" rather than leaving a dead state.
   */
  installTimeoutSeconds: number
}

export interface UpdateSettingsResult {
  ok: boolean
  settings: UpdaterSettings
  error?: string
}
