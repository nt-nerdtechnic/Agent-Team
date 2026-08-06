import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseCdpDebugDoc,
  readCdpDebugConfig,
  writeCdpDebugConfig,
  defaultCdpDebugConfig,
  DEFAULT_CDP_PORT,
} from './cdp-debug'

describe('parseCdpDebugDoc', () => {
  it('returns the disabled default for missing or corrupt content', () => {
    for (const text of [null, '', 'not json']) {
      expect(parseCdpDebugDoc(text)).toEqual(defaultCdpDebugConfig())
    }
  })
  it('defaults enabled to false and port to the default when absent', () => {
    expect(parseCdpDebugDoc('{}')).toEqual({ enabled: false, port: DEFAULT_CDP_PORT })
  })
  it('parses a valid enabled doc', () => {
    expect(parseCdpDebugDoc(JSON.stringify({ enabled: true, port: 9333 }))).toEqual({
      enabled: true,
      port: 9333,
    })
  })
  it('falls back to the default port for a non-numeric or non-positive port', () => {
    expect(parseCdpDebugDoc(JSON.stringify({ enabled: true, port: 'nope' }))).toEqual({
      enabled: true,
      port: DEFAULT_CDP_PORT,
    })
    expect(parseCdpDebugDoc(JSON.stringify({ enabled: true, port: -1 }))).toEqual({
      enabled: true,
      port: DEFAULT_CDP_PORT,
    })
  })
})

describe('readCdpDebugConfig / writeCdpDebugConfig', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdp-debug-'))
    file = join(dir, 'cdp-debug.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the disabled default when no file exists yet', () => {
    expect(readCdpDebugConfig(file)).toEqual(defaultCdpDebugConfig())
  })

  it('round-trips a written config', () => {
    writeCdpDebugConfig(file, { enabled: true, port: 9333 })
    expect(readCdpDebugConfig(file)).toEqual({ enabled: true, port: 9333 })
  })

  it('survives a corrupt file on disk by reading as disabled', () => {
    writeFileSync(file, '{truncated', 'utf-8')
    expect(readCdpDebugConfig(file)).toEqual(defaultCdpDebugConfig())
  })
})
