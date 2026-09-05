// Input to output, which is the whole reason this is a function and not four
// lines inside a template: a boundary is only checkable if it can be called.
import { describe, expect, it } from 'vitest'

import { relativeTime } from '../relativeTime'

const NOW = Date.parse('2026-09-05T12:00:00.000Z')
const ago = (ms: number) => relativeTime(NOW - ms, NOW)

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('relativeTime', () => {
  it('says just now for anything under a minute', () => {
    expect(ago(0)).toEqual({ unit: 'just-now', count: 0 })
    expect(ago(59 * SECOND)).toEqual({ unit: 'just-now', count: 0 })
  })

  it('counts whole units, and rolls over exactly on the boundary', () => {
    // The off-by-one that shows "60 minutes ago" instead of "1 hour ago".
    expect(ago(MINUTE)).toEqual({ unit: 'minutes', count: 1 })
    expect(ago(59 * MINUTE + 59 * SECOND)).toEqual({ unit: 'minutes', count: 59 })
    expect(ago(HOUR)).toEqual({ unit: 'hours', count: 1 })
    expect(ago(23 * HOUR + 59 * MINUTE)).toEqual({ unit: 'hours', count: 23 })
    expect(ago(DAY)).toEqual({ unit: 'days', count: 1 })
    expect(ago(29 * DAY)).toEqual({ unit: 'days', count: 29 })
    expect(ago(30 * DAY)).toEqual({ unit: 'months', count: 1 })
  })

  it('rounds down, so a thing is never reported as older than it is', () => {
    expect(ago(8 * MINUTE + 59 * SECOND)).toEqual({ unit: 'minutes', count: 8 })
    expect(ago(45 * DAY)).toEqual({ unit: 'months', count: 1 })
  })

  it('treats a future timestamp as now rather than as a negative count', () => {
    // Two machines' clocks disagree by seconds as a matter of course, and
    // "last seen in 3 minutes" is a bug report about something that is fine.
    expect(ago(-3 * MINUTE)).toEqual({ unit: 'just-now', count: 0 })
    expect(ago(-DAY)).toEqual({ unit: 'just-now', count: 0 })
  })

  it('does not invent a number out of an unparseable time', () => {
    // `Date.parse` of a malformed string is NaN, and NaN comparisons are all
    // false — so without the guard this would fall through to "months ago".
    expect(relativeTime(Number.NaN, NOW)).toEqual({ unit: 'just-now', count: 0 })
  })
})
