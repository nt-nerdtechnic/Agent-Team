import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_UPDATER_SETTINGS,
  parseUpdaterSettingsDoc,
  readUpdaterSettings,
  writeUpdaterSettings,
} from './updater-settings'
import {
  CHECK_FAILURE_THRESHOLD_RANGE,
  DOWNLOAD_RETRY_COUNT_RANGE,
  INSTALL_TIMEOUT_SECONDS_RANGE,
} from '../shared/updater'

describe('parseUpdaterSettingsDoc', () => {
  it('returns defaults for missing or corrupt content', () => {
    for (const text of [null, '', 'not json', '[]']) {
      expect(parseUpdaterSettingsDoc(text)).toEqual(DEFAULT_UPDATER_SETTINGS)
    }
  })

  it('fills missing fields with defaults and ignores unknown keys', () => {
    // Spread the defaults rather than restating them: this asserts "everything
    // not in the document falls back", which is the actual contract, and does
    // not need editing every time a new preference is added.
    const parsed = parseUpdaterSettingsDoc(JSON.stringify({ autoCheck: false, extra: 'nope' }))
    expect(parsed).toEqual({ ...DEFAULT_UPDATER_SETTINGS, autoCheck: false })
  })

  it('clamps the channel to the two allowed values', () => {
    expect(parseUpdaterSettingsDoc(JSON.stringify({ channel: 'beta' })).channel).toBe('beta')
    expect(parseUpdaterSettingsDoc(JSON.stringify({ channel: 'nightly' })).channel).toBe('stable')
    expect(parseUpdaterSettingsDoc(JSON.stringify({ channel: 42 })).channel).toBe('stable')
  })

  it('clamps numeric preferences into their allowed range', () => {
    const tooLow = parseUpdaterSettingsDoc(
      JSON.stringify({ checkFailureThreshold: 0, downloadRetryCount: -4, installTimeoutSeconds: 1 }),
    )
    expect(tooLow.checkFailureThreshold).toBe(CHECK_FAILURE_THRESHOLD_RANGE.min)
    expect(tooLow.downloadRetryCount).toBe(DOWNLOAD_RETRY_COUNT_RANGE.min)
    expect(tooLow.installTimeoutSeconds).toBe(INSTALL_TIMEOUT_SECONDS_RANGE.min)

    const tooHigh = parseUpdaterSettingsDoc(
      JSON.stringify({ checkFailureThreshold: 99, downloadRetryCount: 99, installTimeoutSeconds: 9999 }),
    )
    expect(tooHigh.checkFailureThreshold).toBe(CHECK_FAILURE_THRESHOLD_RANGE.max)
    expect(tooHigh.downloadRetryCount).toBe(DOWNLOAD_RETRY_COUNT_RANGE.max)
    expect(tooHigh.installTimeoutSeconds).toBe(INSTALL_TIMEOUT_SECONDS_RANGE.max)
  })

  it('falls back to defaults for non-numeric or fractional preferences', () => {
    const parsed = parseUpdaterSettingsDoc(
      JSON.stringify({ checkFailureThreshold: 'three', downloadRetryCount: null, installTimeoutSeconds: 20.6 }),
    )
    expect(parsed.checkFailureThreshold).toBe(DEFAULT_UPDATER_SETTINGS.checkFailureThreshold)
    expect(parsed.downloadRetryCount).toBe(DEFAULT_UPDATER_SETTINGS.downloadRetryCount)
    expect(parsed.installTimeoutSeconds).toBe(21)
  })

  it('rejects non-boolean flags in favour of defaults', () => {
    const parsed = parseUpdaterSettingsDoc(JSON.stringify({ autoCheck: 'yes', autoDownload: 0 }))
    expect(parsed.autoCheck).toBe(true)
    expect(parsed.autoDownload).toBe(true)
  })
})

describe('readUpdaterSettings / writeUpdaterSettings', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'updater-settings-'))
    file = join(dir, 'updater-settings.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads defaults when no file exists yet', () => {
    expect(readUpdaterSettings(file)).toEqual(DEFAULT_UPDATER_SETTINGS)
  })

  it('round-trips a merged patch', () => {
    const saved = writeUpdaterSettings(file, { autoDownload: false, channel: 'beta' })
    expect(saved).toEqual({ ...DEFAULT_UPDATER_SETTINGS, autoDownload: false, channel: 'beta' })
    expect(readUpdaterSettings(file)).toEqual(saved)
  })

  it('merges successive patches without dropping prior fields', () => {
    writeUpdaterSettings(file, { channel: 'beta' })
    writeUpdaterSettings(file, { autoCheck: false })
    expect(readUpdaterSettings(file)).toEqual({
      ...DEFAULT_UPDATER_SETTINGS,
      autoCheck: false,
      channel: 'beta',
    })
  })

  it('recovers to defaults when the file on disk is corrupt', () => {
    writeFileSync(file, '{truncated', 'utf-8')
    expect(readUpdaterSettings(file)).toEqual(DEFAULT_UPDATER_SETTINGS)
  })
})
