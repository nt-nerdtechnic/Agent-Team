import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import {
  CHECK_FAILURE_THRESHOLD_RANGE,
  DEFAULT_CHECK_FAILURE_THRESHOLD,
  DEFAULT_DOWNLOAD_RETRY_COUNT,
  DEFAULT_INSTALL_TIMEOUT_SECONDS,
  DOWNLOAD_RETRY_COUNT_RANGE,
  INSTALL_TIMEOUT_SECONDS_RANGE,
  type UpdateChannel,
  type UpdaterSettings,
} from '../shared/updater'

// Persisted user preferences for the auto-updater. The file lives under the
// Electron userData dir; the caller resolves the path (this module stays
// electron-free so it can be unit tested in isolation).
export const DEFAULT_UPDATER_SETTINGS: UpdaterSettings = {
  autoCheck: true,
  autoDownload: true,
  // Off by default: an existing install must not start applying updates on
  // quit just because it was upgraded to a version that can.
  autoInstallOnQuit: false,
  channel: 'stable',
  notifyOnCheckFailure: true,
  checkFailureThreshold: DEFAULT_CHECK_FAILURE_THRESHOLD,
  retryDownload: true,
  downloadRetryCount: DEFAULT_DOWNLOAD_RETRY_COUNT,
  installTimeoutSeconds: DEFAULT_INSTALL_TIMEOUT_SECONDS,
}

function clampChannel(value: unknown): UpdateChannel {
  return value === 'beta' ? 'beta' : 'stable'
}

// Numeric preferences come from a hand-editable JSON file and from spin boxes,
// so anything out of range (or not a number at all) falls back to the default
// rather than reaching the updater.
function clampNumber(
  value: unknown,
  range: { min: number; max: number },
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

// Validate an arbitrary parsed document into a full UpdaterSettings, ignoring
// unknown fields and falling back to defaults for missing/invalid ones.
export function parseUpdaterSettingsDoc(text: string | null): UpdaterSettings {
  if (!text) return { ...DEFAULT_UPDATER_SETTINGS }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ...DEFAULT_UPDATER_SETTINGS }
  }
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_UPDATER_SETTINGS }
  const doc = raw as Record<string, unknown>
  return {
    autoCheck:
      typeof doc.autoCheck === 'boolean' ? doc.autoCheck : DEFAULT_UPDATER_SETTINGS.autoCheck,
    autoDownload:
      typeof doc.autoDownload === 'boolean'
        ? doc.autoDownload
        : DEFAULT_UPDATER_SETTINGS.autoDownload,
    autoInstallOnQuit:
      typeof doc.autoInstallOnQuit === 'boolean'
        ? doc.autoInstallOnQuit
        : DEFAULT_UPDATER_SETTINGS.autoInstallOnQuit,
    channel: clampChannel(doc.channel),
    notifyOnCheckFailure:
      typeof doc.notifyOnCheckFailure === 'boolean'
        ? doc.notifyOnCheckFailure
        : DEFAULT_UPDATER_SETTINGS.notifyOnCheckFailure,
    checkFailureThreshold: clampNumber(
      doc.checkFailureThreshold,
      CHECK_FAILURE_THRESHOLD_RANGE,
      DEFAULT_UPDATER_SETTINGS.checkFailureThreshold,
    ),
    retryDownload:
      typeof doc.retryDownload === 'boolean'
        ? doc.retryDownload
        : DEFAULT_UPDATER_SETTINGS.retryDownload,
    downloadRetryCount: clampNumber(
      doc.downloadRetryCount,
      DOWNLOAD_RETRY_COUNT_RANGE,
      DEFAULT_UPDATER_SETTINGS.downloadRetryCount,
    ),
    installTimeoutSeconds: clampNumber(
      doc.installTimeoutSeconds,
      INSTALL_TIMEOUT_SECONDS_RANGE,
      DEFAULT_UPDATER_SETTINGS.installTimeoutSeconds,
    ),
  }
}

export function readUpdaterSettings(filePath: string): UpdaterSettings {
  try {
    return parseUpdaterSettingsDoc(readFileSync(filePath, 'utf-8'))
  } catch {
    return { ...DEFAULT_UPDATER_SETTINGS }
  }
}

// Merge a partial patch onto the current settings, re-validate, and persist
// atomically (write temp + rename). Returns the settings actually stored.
export function writeUpdaterSettings(
  filePath: string,
  patch: Partial<UpdaterSettings>,
): UpdaterSettings {
  const current = readUpdaterSettings(filePath)
  const merged: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value
  }
  const next = parseUpdaterSettingsDoc(JSON.stringify(merged))
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
  renameSync(tmp, filePath)
  return next
}
