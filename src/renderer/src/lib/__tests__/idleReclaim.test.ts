import { describe, expect, it } from 'vitest'
import {
  IDLE_RECLAIM_DEFAULT_MINUTES,
  IDLE_RECLAIM_MIN_MINUTES,
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
