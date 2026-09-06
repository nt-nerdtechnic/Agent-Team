import { describe, expect, it } from 'vitest'
import {
  IDLE_RECLAIM_DEFAULT_MINUTES,
  IDLE_RECLAIM_MIN_MINUTES,
  IDLE_RECLAIM_NEVER,
  focusedForReclaim,
  idleReclaimDisabled,
  idleReclaimThresholdMs,
  reclaimBlockedBy,
  RECLAIM_NOW_THRESHOLD_MS,
  type ReclaimCandidate,
} from '../idleReclaim'

const NOW = 1_700_000_000_000
const THRESHOLD = 3 * 60 * 60_000

/** A pane that has done nothing for four hours and blocks on nothing. */
function idleForHours(over: Partial<ReclaimCandidate> = {}): ReclaimCandidate {
  return {
    realized: true,
    restoring: false,
    focused: false,
    resumeSessionId: 'sess-1',
    rebuilding: false,
    loopActive: false,
    preparationStatus: 'ready',
    injectionStatus: 'done',
    spawnReportPending: false,
    hasRef: true,
    displayStatus: 'idle',
    hasDraft: false,
    lastTouchedAt: NOW - 4 * 60 * 60_000,
    ...over,
  }
}

describe('reclaimBlockedBy', () => {
  it('reclaims a pane nobody has touched for longer than the threshold', () => {
    expect(reclaimBlockedBy(idleForHours(), THRESHOLD, NOW)).toBeNull()
  })

  it('leaves a pane alone until the threshold is actually past', () => {
    const recent = idleForHours({ lastTouchedAt: NOW - 60_000 })
    expect(reclaimBlockedBy(recent, THRESHOLD, NOW)).toBe('too-recent')
  })

  // Reading a long answer is using the pane, and it produces neither output nor
  // keystrokes — exactly the profile the timing check calls idle.
  it('never reclaims the focused pane, however old its last signal', () => {
    const focused = idleForHours({ focused: true, lastTouchedAt: NOW - 99 * 60 * 60_000 })
    expect(reclaimBlockedBy(focused, THRESHOLD, NOW)).toBe('focused')
  })

  // A pane holding a question open is idle by every timing measure and is the
  // single worst one to take away: the user comes back to answer it.
  it('never reclaims a pane awaiting the user', () => {
    expect(reclaimBlockedBy(idleForHours({ displayStatus: 'awaiting' }), THRESHOLD, NOW))
      .toBe('not-idle')
  })

  it('never reclaims a pane whose CLI is still working', () => {
    expect(reclaimBlockedBy(idleForHours({ displayStatus: 'running' }), THRESHOLD, NOW))
      .toBe('not-idle')
  })

  // The draft lives only in the CLI's input line. Killing the process is the
  // one way to lose it for good.
  it('never reclaims a pane with unsent text in its input', () => {
    expect(reclaimBlockedBy(idleForHours({ hasDraft: true }), THRESHOLD, NOW)).toBe('has-draft')
  })

  // Without a resume id the conversation cannot be brought back, so reclaiming
  // would be a permanent close the user never asked for.
  it('never reclaims a pane that cannot be resumed', () => {
    expect(reclaimBlockedBy(idleForHours({ resumeSessionId: '' }), THRESHOLD, NOW))
      .toBe('no-resume-id')
  })

  it('never reclaims a pane with no signal to age', () => {
    expect(reclaimBlockedBy(idleForHours({ lastTouchedAt: 0 }), THRESHOLD, NOW))
      .toBe('never-touched')
  })

  it.each([
    ['not-realized', { realized: false }],
    ['restoring', { restoring: true }],
    ['rebuilding', { rebuilding: true }],
    ['loop-active', { loopActive: true }],
    ['preparing', { preparationStatus: 'starting' }],
    ['injecting', { injectionStatus: 'pending' }],
    ['spawn-report-pending', { spawnReportPending: true }],
    ['no-ref', { hasRef: false }],
  ] as const)('never reclaims a pane that is %s', (reason, over) => {
    expect(reclaimBlockedBy(idleForHours(over), THRESHOLD, NOW)).toBe(reason)
  })
})

// Which pane the `focused` guard is actually about. App.vue holds two ids for
// it and used to feed the guard only the first, which is how a pane on screen
// could be reclaimed while the user was reading it.
describe('focusedForReclaim', () => {
  it('is the pane the request names', () => {
    expect(focusedForReclaim('pane-a', 'pane-a', 'pane-a')).toBe(true)
  })

  it('is the pane on screen when nothing was requested', () => {
    // The case that made the sweep visible: focusPaneId is null on a fresh
    // window, and resolveFocusedPane puts the first visible pane on the stage.
    expect(focusedForReclaim(null, 'pane-a', 'pane-a')).toBe(true)
  })

  it('is the pane on screen when the request points somewhere else', () => {
    // A minimized or out-of-workspace request is replaced, and the substitute
    // is what the user is looking at.
    expect(focusedForReclaim('pane-minimized', 'pane-a', 'pane-a')).toBe(true)
  })

  it('still covers a request the resolver had to substitute for', () => {
    // The docked pane keeps its protection: the user put it there deliberately
    // and the reclaim would be just as much of a surprise on the way back.
    expect(focusedForReclaim('pane-minimized', 'pane-a', 'pane-minimized')).toBe(true)
  })

  it('is no other pane', () => {
    expect(focusedForReclaim('pane-a', 'pane-a', 'pane-b')).toBe(false)
    expect(focusedForReclaim(null, null, 'pane-b')).toBe(false)
  })

  it('blocks the reclaim it feeds', () => {
    // The two halves joined up: what this answers is the `focused` field, and
    // a true there is what refuses an otherwise perfectly reclaimable pane.
    const onScreen = idleForHours({
      focused: focusedForReclaim(null, 'pane-a', 'pane-a'),
    })
    expect(reclaimBlockedBy(onScreen, THRESHOLD, NOW)).toBe('focused')

    const offScreen = idleForHours({
      focused: focusedForReclaim(null, 'pane-a', 'pane-b'),
    })
    expect(reclaimBlockedBy(offScreen, THRESHOLD, NOW)).toBeNull()
  })
})

// Pressing "reclaim now" answers the question the timer exists to answer, so
// the age check is the only guard it skips. Everything else still refuses.
describe('manual reclaim (RECLAIM_NOW_THRESHOLD_MS)', () => {
  it('reclaims a pane that just went idle', () => {
    const justIdle = idleForHours({ lastTouchedAt: NOW - 1_000 })
    expect(reclaimBlockedBy(justIdle, RECLAIM_NOW_THRESHOLD_MS, NOW)).toBeNull()
  })

  it.each([
    ['focused', { focused: true }],
    ['not-idle', { displayStatus: 'awaiting' }],
    ['has-draft', { hasDraft: true }],
    ['no-resume-id', { resumeSessionId: '' }],
    ['never-touched', { lastTouchedAt: 0 }],
    ['loop-active', { loopActive: true }],
  ] as const)('still refuses a pane that is %s', (reason, over) => {
    const pane = idleForHours({ lastTouchedAt: NOW - 1_000, ...over })
    expect(reclaimBlockedBy(pane, RECLAIM_NOW_THRESHOLD_MS, NOW)).toBe(reason)
  })
})

describe('idleReclaimThresholdMs', () => {
  it('reads the stored minutes', () => {
    expect(idleReclaimThresholdMs('60')).toBe(60 * 60_000)
  })

  // A stored value below the floor would turn the sweep into "reclaim as soon
  // as the user stops typing", which is the failure this setting must not have.
  it('clamps an unreasonably small value up to the floor', () => {
    expect(idleReclaimThresholdMs('1')).toBe(IDLE_RECLAIM_MIN_MINUTES * 60_000)
    expect(idleReclaimThresholdMs('0')).toBe(IDLE_RECLAIM_MIN_MINUTES * 60_000)
  })

  it('falls back to the default when the stored value is not a number', () => {
    expect(idleReclaimThresholdMs('')).toBe(IDLE_RECLAIM_DEFAULT_MINUTES * 60_000)
    expect(idleReclaimThresholdMs('later')).toBe(IDLE_RECLAIM_DEFAULT_MINUTES * 60_000)
  })
})

// "Never" has to be a word rather than a number, because every number here is
// a duration the floor clamps — '0' means fifteen minutes, not off.
describe('never', () => {
  it('recognises the sentinel, and nothing else', () => {
    expect(idleReclaimDisabled(IDLE_RECLAIM_NEVER)).toBe(true)
    expect(idleReclaimDisabled('Never')).toBe(true)
    expect(idleReclaimDisabled(' never ')).toBe(true)
    for (const stored of ['15', '30', '60', '180', '480', '0', '', 'later']) {
      expect(idleReclaimDisabled(stored), stored).toBe(false)
    }
  })

  // The sweep checks idleReclaimDisabled and returns before it measures ages.
  // This is the backstop for a caller that does not: an unreachable threshold
  // reclaims nothing, where the old non-numeric fallback would have reclaimed
  // on the 30-minute default the user just switched off.
  it('answers with a threshold no pane can ever reach', () => {
    expect(idleReclaimThresholdMs(IDLE_RECLAIM_NEVER)).toBe(Number.POSITIVE_INFINITY)
  })

  it('refuses a pane idle for a century as too recent', () => {
    const ancient = idleForHours({ lastTouchedAt: NOW - 100 * 365 * 24 * 60 * 60_000 })
    expect(reclaimBlockedBy(ancient, idleReclaimThresholdMs(IDLE_RECLAIM_NEVER), NOW))
      .toBe('too-recent')
  })

  // The setting is about the timer. Pressing "reclaim now" is the user asking
  // by name, and never was never an answer to that question.
  it('leaves manual reclaim working', () => {
    const justIdle = idleForHours({ lastTouchedAt: NOW - 1_000 })
    expect(reclaimBlockedBy(justIdle, RECLAIM_NOW_THRESHOLD_MS, NOW)).toBeNull()
  })
})
