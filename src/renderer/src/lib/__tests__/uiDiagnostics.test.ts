import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordDiagnostic,
  readDiagnostics,
  takeDiagnosticsSince,
  currentDiagnosticSeq,
  _resetDiagnostics
} from '../uiDiagnostics'

beforeEach(() => {
  _resetDiagnostics()
})

describe('recordDiagnostic', () => {
  it('stamps a monotonically increasing seq and an ISO timestamp', () => {
    const first = recordDiagnostic({ level: 'warn', code: 'inject.resend', message: 'a' })
    const second = recordDiagnostic({ level: 'error', code: 'inject.failed', message: 'b' })
    expect(second.seq).toBe(first.seq + 1)
    expect(() => new Date(first.ts).toISOString()).not.toThrow()
    expect(new Date(first.ts).toISOString()).toBe(first.ts)
  })

  it('carries paneId through when given, omits it when not', () => {
    const withPane = recordDiagnostic({ level: 'warn', code: 'c', message: 'm', paneId: 'pane-1' })
    const withoutPane = recordDiagnostic({ level: 'warn', code: 'c', message: 'm' })
    expect(withPane.paneId).toBe('pane-1')
    expect(withoutPane.paneId).toBeUndefined()
  })
})

describe('readDiagnostics — ring buffer cap', () => {
  it('keeps at most 200 entries, dropping the oldest first', () => {
    for (let i = 0; i < 205; i++) {
      recordDiagnostic({ level: 'warn', code: 'c', message: `m${i}` })
    }
    const all = readDiagnostics()
    expect(all).toHaveLength(200)
    // Entries 0-4 were dropped; the oldest surviving one is m5.
    expect(all[0].message).toBe('m5')
    expect(all[all.length - 1].message).toBe('m204')
  })
})

describe('readDiagnostics — filtering', () => {
  it('sinceSeq excludes entries at or before the given seq', () => {
    const first = recordDiagnostic({ level: 'warn', code: 'c', message: 'm1' })
    recordDiagnostic({ level: 'warn', code: 'c', message: 'm2' })
    const entries = readDiagnostics({ sinceSeq: first.seq })
    expect(entries).toHaveLength(1)
    expect(entries[0].message).toBe('m2')
  })

  it('paneId filters to entries recorded for that pane', () => {
    recordDiagnostic({ level: 'warn', code: 'c', message: 'a', paneId: 'pane-1' })
    recordDiagnostic({ level: 'warn', code: 'c', message: 'b', paneId: 'pane-2' })
    recordDiagnostic({ level: 'warn', code: 'c', message: 'c-no-pane' })
    const entries = readDiagnostics({ paneId: 'pane-1' })
    expect(entries).toHaveLength(1)
    expect(entries[0].message).toBe('a')
  })

  it('limit caps the number of entries returned', () => {
    recordDiagnostic({ level: 'warn', code: 'c', message: 'a' })
    recordDiagnostic({ level: 'warn', code: 'c', message: 'b' })
    recordDiagnostic({ level: 'warn', code: 'c', message: 'c' })
    const entries = readDiagnostics({ limit: 2 })
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.message)).toEqual(['a', 'b'])
  })

  it('with no entries recorded, returns an empty array', () => {
    expect(readDiagnostics()).toEqual([])
  })
})

describe('takeDiagnosticsSince', () => {
  it('mirrors readDiagnostics({ sinceSeq, paneId })', () => {
    const seq = currentDiagnosticSeq()
    recordDiagnostic({ level: 'warn', code: 'c', message: 'before-watermark-does-not-apply' })
    const entries = takeDiagnosticsSince(seq)
    expect(entries).toHaveLength(1)
    expect(entries[0].message).toBe('before-watermark-does-not-apply')
  })

  it('filters by paneId when given', () => {
    const seq = currentDiagnosticSeq()
    recordDiagnostic({ level: 'warn', code: 'c', message: 'a', paneId: 'pane-1' })
    recordDiagnostic({ level: 'warn', code: 'c', message: 'b', paneId: 'pane-2' })
    const entries = takeDiagnosticsSince(seq, 'pane-2')
    expect(entries).toHaveLength(1)
    expect(entries[0].message).toBe('b')
  })
})

describe('currentDiagnosticSeq', () => {
  it('starts at 0 and tracks the seq of the last recorded entry', () => {
    expect(currentDiagnosticSeq()).toBe(0)
    const entry = recordDiagnostic({ level: 'warn', code: 'c', message: 'm' })
    expect(currentDiagnosticSeq()).toBe(entry.seq)
  })
})
