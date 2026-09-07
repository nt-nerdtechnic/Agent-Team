// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import {
  USAGE_LIMIT_UNKNOWN_TTL_MS,
  detectUsageLimit,
  usageLimitDue,
  usageResumeAt
} from '../cliUsageLimit'
import { LIMIT_RESET_BUFFER_MS } from '../loopPrompt'
import { __resetUsageForTest, initUsage, type UsageSnapshot } from '../../composables/useUsage'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'

type Handler = (raw: unknown) => void

/** Seed the usage store the way the backend does — the detector reads it as a
 *  second, out-of-buffer signal, so it has to come from the real store. */
function seedUsage(windows: UsageSnapshot['windows'], status: UsageSnapshot['status'] = 'ok'): void {
  const handlers = new Map<string, Handler>()
  const backend = {
    status: ref('connected'),
    send: vi.fn(async () => ({ ok: true, payload: {} })),
    on: vi.fn((type: string, cb: Handler) => {
      handlers.set(type, cb)
      return () => handlers.delete(type)
    })
  }
  initUsage(backend as never)
  handlers.get('usage.changed')?.({
    providers: {
      claude: {
        provider: 'claude',
        status,
        planType: null,
        windows,
        fetchedAt: '2026-09-07T00:00:00Z',
        error: null
      }
    }
  })
}

const NOW = Date.parse('2026-09-07T06:00:00Z') // 14:00 Asia/Taipei

describe('detectUsageLimit', () => {
  beforeEach(() => {
    __resetUsageForTest()
    __resetSettingsForTest()
  })
  afterEach(() => {
    __resetUsageForTest()
    __resetSettingsForTest()
  })

  it('takes the reset time from the message, not from the /usage reading', () => {
    // The panel reading is up to 15 minutes old and here it disagrees: it still
    // believes the window ends at 18:50. The message was printed just now.
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    const hit = detectUsageLimit(
      'claude',
      "You've hit your session limit · resets 4:30pm (Asia/Taipei)",
      NOW
    )
    expect(hit).not.toBeNull()
    // 16:30 Taipei = 08:30Z, plus the safety buffer.
    expect(hit!.resumeAt).toBe(Date.parse('2026-09-07T08:30:00Z') + LIMIT_RESET_BUFFER_MS)
  })

  it('falls back to the /usage reading when the message time is unreadable', () => {
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    const hit = detectUsageLimit(
      'claude',
      "You've hit your session limit · resets 4:30pm (Middle/Earth)",
      NOW
    )
    expect(hit).not.toBeNull()
    expect(hit!.resumeAt).toBe(Date.parse('2026-09-07T10:50:00Z') + LIMIT_RESET_BUFFER_MS)
  })

  it('reports the hit with no resume time when neither source resolves one', () => {
    seedUsage([])
    const hit = detectUsageLimit(
      'claude',
      "You've hit your session limit · resets 4:30pm (Middle/Earth)",
      NOW
    )
    expect(hit).not.toBeNull()
    expect(hit!.resumeAt).toBeNull()
  })

  it('matches across the TUI hard wrap a narrow pane inserts', () => {
    seedUsage([])
    const hit = detectUsageLimit(
      'claude',
      "You've hit your session\nlimit · resets 4:30pm (Asia/\nTaipei)",
      NOW
    )
    expect(hit).not.toBeNull()
    expect(hit!.resumeAt).toBe(Date.parse('2026-09-07T08:30:00Z') + LIMIT_RESET_BUFFER_MS)
  })

  it('ignores a clockless limit phrase the quota reading does not confirm', () => {
    // Exactly the false positive this guard exists for: a CLI discussing limits
    // in its own assistant text, with quota to spare.
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 39, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    expect(
      detectUsageLimit('claude', 'the message says you hit your session limit somewhere', NOW)
    ).toBeNull()
  })

  it('believes a clockless limit phrase once the quota reading confirms it', () => {
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    const hit = detectUsageLimit('claude', 'You have hit your usage limit', NOW)
    expect(hit).not.toBeNull()
    expect(hit!.resumeAt).toBe(Date.parse('2026-09-07T10:50:00Z') + LIMIT_RESET_BUFFER_MS)
  })

  it('does not let a spent per-model bucket confirm a clockless phrase', () => {
    // A promotional "Fable only" bucket reports 100% used without blocking
    // anything, so it must not stand in for real exhaustion.
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 39, resetsAt: '2026-09-07T10:50:00Z' },
      { kind: 'weekly-model', label: 'Weekly (Fable)', usedPercent: 100, resetsAt: '2026-09-09T21:00:00Z' }
    ])
    expect(detectUsageLimit('claude', 'You have hit your usage limit', NOW)).toBeNull()
  })

  it('returns null when there is no limit message at all', () => {
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    expect(detectUsageLimit('claude', 'Current session: 100% used', NOW)).toBeNull()
  })
})

describe('usageResumeAt', () => {
  beforeEach(() => {
    __resetUsageForTest()
    __resetSettingsForTest()
  })
  afterEach(() => {
    __resetUsageForTest()
    __resetSettingsForTest()
  })

  it('refuses a reset that has already passed', () => {
    // Resuming into a window that "reset" an hour ago per a stale reading would
    // fire straight back into the exhausted quota.
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T05:00:00Z' }
    ])
    expect(usageResumeAt('claude', NOW)).toBeNull()
  })

  it('prefers the spent window over the session window', () => {
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 20, resetsAt: '2026-09-07T07:00:00Z' },
      { kind: 'weekly', label: 'Weekly (all models)', usedPercent: 100, resetsAt: '2026-09-09T21:00:00Z' }
    ])
    expect(usageResumeAt('claude', NOW)).toBe(
      Date.parse('2026-09-09T21:00:00Z') + LIMIT_RESET_BUFFER_MS
    )
  })

  it('is null for an agent with no usage provider', () => {
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    expect(usageResumeAt('aider', NOW)).toBeNull()
  })
})

describe('usageLimitDue', () => {
  it('holds the flag until the resolved reset arrives', () => {
    expect(usageLimitDue(NOW, NOW + 60_000, NOW)).toBe(false)
    expect(usageLimitDue(NOW, NOW + 60_000, NOW + 59_999)).toBe(false)
    // The boundary itself releases: the reset already carries a safety buffer.
    expect(usageLimitDue(NOW, NOW + 60_000, NOW + 60_000)).toBe(true)
  })

  it('falls back to the session window when no reset was resolved', () => {
    // Without this the badge sticks for the life of the pane, because nothing
    // else ever clears a flag whose window nobody could name.
    expect(usageLimitDue(NOW, null, NOW + USAGE_LIMIT_UNKNOWN_TTL_MS - 1)).toBe(false)
    expect(usageLimitDue(NOW, null, NOW + USAGE_LIMIT_UNKNOWN_TTL_MS)).toBe(true)
  })

  it('measures the fallback from when the hit was seen, not from now', () => {
    // A flag raised four hours ago must not get a fresh five hours on every
    // poll — that is exactly how a "temporary" state becomes permanent.
    const fourHoursAgo = NOW - 4 * 60 * 60_000
    expect(usageLimitDue(fourHoursAgo, null, NOW)).toBe(false)
    expect(usageLimitDue(fourHoursAgo, null, NOW + 61 * 60_000)).toBe(true)
  })
})
