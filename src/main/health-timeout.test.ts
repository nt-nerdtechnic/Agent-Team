import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clampHealthCheckTimeoutSec,
  parseHealthCheckTimeoutDoc,
  readHealthCheckTimeoutSec,
  writeHealthCheckTimeoutSec,
  DEFAULT_HEALTH_CHECK_TIMEOUT_SEC,
  MAX_HEALTH_CHECK_TIMEOUT_SEC,
} from './health-timeout'

describe('clampHealthCheckTimeoutSec', () => {
  it('clamps below the 15s floor', () => {
    expect(clampHealthCheckTimeoutSec(1)).toBe(15)
  })
  it('clamps above the ceiling', () => {
    expect(clampHealthCheckTimeoutSec(5_000)).toBe(MAX_HEALTH_CHECK_TIMEOUT_SEC)
  })
  it('leaves a long-but-allowed wait alone — a slow first launch is not a failure', () => {
    expect(clampHealthCheckTimeoutSec(300)).toBe(300)
  })
  it('rounds an in-range value', () => {
    expect(clampHealthCheckTimeoutSec(60.6)).toBe(61)
  })
  it('falls back to the default for non-finite input', () => {
    expect(clampHealthCheckTimeoutSec(NaN)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_SEC)
  })
})

describe('parseHealthCheckTimeoutDoc', () => {
  it('returns the default for missing or corrupt content', () => {
    for (const text of [null, '', 'not json', '{}']) {
      expect(parseHealthCheckTimeoutDoc(text)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_SEC)
    }
  })
  it('parses and clamps a valid doc', () => {
    expect(parseHealthCheckTimeoutDoc(JSON.stringify({ timeoutSec: 90 }))).toBe(90)
    expect(parseHealthCheckTimeoutDoc(JSON.stringify({ timeoutSec: 5 }))).toBe(15)
  })
})

describe('readHealthCheckTimeoutSec / writeHealthCheckTimeoutSec', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'health-timeout-'))
    file = join(dir, 'health-check-timeout.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the default when no file exists yet', () => {
    expect(readHealthCheckTimeoutSec(file)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_SEC)
  })

  it('round-trips a written value', () => {
    writeHealthCheckTimeoutSec(file, 75)
    expect(readHealthCheckTimeoutSec(file)).toBe(75)
  })

  it('clamps an out-of-range value on write', () => {
    writeHealthCheckTimeoutSec(file, 9_999)
    expect(readHealthCheckTimeoutSec(file)).toBe(MAX_HEALTH_CHECK_TIMEOUT_SEC)
  })

  it('survives a corrupt file on disk', () => {
    writeFileSync(file, '{truncated', 'utf-8')
    expect(readHealthCheckTimeoutSec(file)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_SEC)
  })
})
