import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseUpdaterStateDoc, readUpdaterState, writeUpdaterState } from './updater-state-store'

describe('parseUpdaterStateDoc', () => {
  it('returns an empty state for missing or corrupt content', () => {
    for (const text of [null, '', 'not json', '[]', '42']) {
      expect(parseUpdaterStateDoc(text)).toEqual({})
    }
  })

  it('keeps a well-formed check history', () => {
    const doc = {
      checkedAt: '2026-01-01T00:00:00.000Z',
      lastCheckFailure: { message: 'feed unavailable', count: 2, at: '2026-01-02T00:00:00.000Z' },
    }
    expect(parseUpdaterStateDoc(JSON.stringify(doc))).toEqual(doc)
  })

  it('drops a malformed failure record rather than restoring nonsense', () => {
    const cases = [
      { count: 2, at: 'x' }, // no message
      { message: 'x', at: 'x' }, // no count
      { message: 'x', count: 0, at: 'x' }, // a run of zero is not a run
      { message: 'x', count: 'two', at: 'x' },
      { message: 'x', count: 2 }, // no timestamp
      'nope',
    ]
    for (const lastCheckFailure of cases) {
      expect(parseUpdaterStateDoc(JSON.stringify({ lastCheckFailure }))).toEqual({})
    }
  })

  it('ignores unknown fields and a non-string timestamp', () => {
    const parsed = parseUpdaterStateDoc(JSON.stringify({ checkedAt: 1234, extra: 'nope' }))
    expect(parsed).toEqual({})
  })
})

describe('readUpdaterState / writeUpdaterState', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'updater-state-'))
    file = join(dir, 'updater-state.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads an empty state when no file exists yet', () => {
    expect(readUpdaterState(file)).toEqual({})
  })

  it('round-trips a persisted state', () => {
    const state = {
      checkedAt: '2026-01-01T00:00:00.000Z',
      lastCheckFailure: { message: 'feed unavailable', count: 3, at: '2026-01-02T00:00:00.000Z' },
    }
    writeUpdaterState(file, state)
    expect(readUpdaterState(file)).toEqual(state)
  })

  it('recovers to an empty state when the file on disk is corrupt', () => {
    writeFileSync(file, '{truncated', 'utf-8')
    expect(readUpdaterState(file)).toEqual({})
  })

  it('never throws when the path cannot be written', () => {
    expect(() => writeUpdaterState(join(dir, 'missing', 'nested.json'), {})).not.toThrow()
  })
})
