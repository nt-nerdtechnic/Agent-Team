import { describe, it, expect } from 'vitest'
import { slotFinished, allSlotsFinished, turnCompleteDone, loopContinueReady, turnEndsWithSentinel, parseEventMs, isReplayedTurnComplete, normalizeTurnText, turnMadeProgress, loopBackoffMs, applyTurnProgress, loopStallVerdict, LOOP_STALL_BACKOFF_MS, LOOP_MIN_PROGRESS_CHARS, LOOP_STALL_LIMIT, LOOP_MAX_CONTINUES, type SlotSignal, type LoopStallState } from '../completion'

// Fixed reference time for the watcher arming. turn_complete only counts when
// its timestamp is strictly AFTER this.
const ARMED = 1000

describe('slotFinished', () => {
  it('is true when the sentinel was seen, regardless of turn_complete', () => {
    expect(slotFinished({ sentinelSeen: true, turnCompleteAt: 0, armedAt: ARMED })).toBe(true)
  })

  it('sentinel wins even over a stale turn_complete', () => {
    expect(slotFinished({ sentinelSeen: true, turnCompleteAt: 500, armedAt: ARMED })).toBe(true)
  })

  it('is true when turn_complete landed after the watcher armed', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: 2000, armedAt: ARMED })).toBe(true)
  })

  it('is false when there is no signal at all', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: 0, armedAt: ARMED })).toBe(false)
  })

  it('ignores a stale turn_complete from a prior stage/turn', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: 500, armedAt: ARMED })).toBe(false)
  })

  it('ignores a turn_complete exactly at arm time (must be strictly after)', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: ARMED, armedAt: ARMED })).toBe(false)
  })
})

describe('allSlotsFinished', () => {
  const finished: SlotSignal = { sentinelSeen: true, turnCompleteAt: 0, armedAt: ARMED }
  const unfinished: SlotSignal = { sentinelSeen: false, turnCompleteAt: 0, armedAt: ARMED }

  it('is never true for an empty list (no signals yet)', () => {
    expect(allSlotsFinished([])).toBe(false)
  })

  it('is true when a single slot is finished', () => {
    expect(allSlotsFinished([finished])).toBe(true)
  })

  it('is true when every slot is finished (mixed signal kinds)', () => {
    const viaTurnComplete: SlotSignal = { sentinelSeen: false, turnCompleteAt: 2000, armedAt: ARMED }
    expect(allSlotsFinished([finished, viaTurnComplete])).toBe(true)
  })

  it('is false when any slot is unfinished (partial completion never advances)', () => {
    expect(allSlotsFinished([finished, unfinished])).toBe(false)
  })

  it('is false when a slot only has a stale turn_complete', () => {
    const stale: SlotSignal = { sentinelSeen: false, turnCompleteAt: 500, armedAt: ARMED }
    expect(allSlotsFinished([finished, stale])).toBe(false)
  })
})

describe('turnCompleteDone', () => {
  const SETTLE = 1500

  it('is true when turn_complete is post-arm, latest, and settled', () => {
    // armed=1000, active=1500, turn_complete=2000, now=2000+SETTLE
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(true)
  })

  it('is true exactly at the settle boundary', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(true)
  })

  it('is false before settle elapses (lets a QUESTION render & be caught first)', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + 1000, settleMs: SETTLE
    })).toBe(false)
  })

  it('is false when agent_active came AFTER turn_complete (revived by injection)', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 2500, armedAt: ARMED,
      now: 2000 + SETTLE + 5000, settleMs: SETTLE
    })).toBe(false)
  })

  it('is false for a stale turn_complete from before the watcher armed', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 500, lastActiveAt: 0, armedAt: ARMED,
      now: 999_999, settleMs: SETTLE
    })).toBe(false)
  })

  it('is false when there is no turn_complete signal at all', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 0, lastActiveAt: 0, armedAt: ARMED,
      now: 999_999, settleMs: SETTLE
    })).toBe(false)
  })
})

describe('loopContinueReady', () => {
  const SETTLE = 1500

  it('is true when the continue woke the CLI: agent_active landed after arm', () => {
    // armed=1000, active=1500 (>arm), turn_complete=2000, settled.
    expect(loopContinueReady({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(true)
  })

  it('is false for an empty turn_complete with NO agent_active after arm (the infinite-loop bug)', () => {
    // turnCompleteDone alone would be TRUE here (post-arm, latest, settled), but
    // lastActiveAt (from before arm) never advanced — the injected continue did
    // not wake the CLI, so a re-fire would spam "繼續" forever.
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 500, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(true)
    expect(loopContinueReady({
      turnCompleteAt: 2000, lastActiveAt: 500, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(false)
  })

  it('is false when agent_active landed exactly at arm time (must be strictly after)', () => {
    expect(loopContinueReady({
      turnCompleteAt: 2000, lastActiveAt: ARMED, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(false)
  })

  it('inherits turnCompleteDone gating: false before settle even with a post-arm agent_active', () => {
    expect(loopContinueReady({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + 1000, settleMs: SETTLE
    })).toBe(false)
  })
})

describe('turnMadeProgress', () => {
  // Long enough to clear LOOP_MIN_PROGRESS_CHARS.
  const WORK = 'Implemented the parser, added three tests, and ran the suite — all green.'
  const OTHER_WORK = 'Fixed the failing case in the reducer and re-ran the suite — still green.'

  it('is true for a substantial turn that differs from the previous one', () => {
    expect(turnMadeProgress(WORK, OTHER_WORK)).toBe(true)
  })

  it('is false when the CLI repeats its previous answer verbatim', () => {
    expect(turnMadeProgress(WORK, WORK)).toBe(false)
  })

  it('ignores whitespace/wrapping differences when comparing to the previous turn', () => {
    expect(turnMadeProgress(WORK.replace(' ', '\n  '), WORK)).toBe(false)
  })

  it('is false for a turn too short to be work (the "等待中。" spin)', () => {
    expect(turnMadeProgress('等待中。', '')).toBe(false)
    expect(turnMadeProgress('等待中。', '等待中。')).toBe(false)
  })

  it('is false for an empty turn_complete', () => {
    expect(turnMadeProgress('', 'anything')).toBe(false)
  })

  it('treats exactly LOOP_MIN_PROGRESS_CHARS as long enough', () => {
    expect(turnMadeProgress('x'.repeat(LOOP_MIN_PROGRESS_CHARS), '')).toBe(true)
    expect(turnMadeProgress('x'.repeat(LOOP_MIN_PROGRESS_CHARS - 1), '')).toBe(false)
  })
})

describe('normalizeTurnText', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeTurnText('  a \n\n b\tc  ')).toBe('a b c')
  })
})

describe('loopBackoffMs', () => {
  it('does not delay a productive loop', () => {
    expect(loopBackoffMs(0)).toBe(0)
    expect(loopBackoffMs(-1)).toBe(0)
  })

  it('escalates with each consecutive stalled run', () => {
    expect(loopBackoffMs(1)).toBe(LOOP_STALL_BACKOFF_MS[1])
    expect(loopBackoffMs(2)).toBe(LOOP_STALL_BACKOFF_MS[2])
    expect(loopBackoffMs(3)).toBe(LOOP_STALL_BACKOFF_MS[3])
  })

  it('clamps past the last tier', () => {
    expect(loopBackoffMs(99)).toBe(LOOP_STALL_BACKOFF_MS[LOOP_STALL_BACKOFF_MS.length - 1])
  })
})

describe('applyTurnProgress', () => {
  const FRESH: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
  const WORK = 'Implemented the parser, added three tests, and ran the suite — all green.'

  it('records a productive turn and keeps the counter at zero', () => {
    expect(applyTurnProgress(FRESH, WORK)).toEqual({ stalledRuns: 0, lastTurnText: WORK })
  })

  it('clears the counter as soon as the loop gets moving again', () => {
    expect(applyTurnProgress({ stalledRuns: 3, lastTurnText: '等待中。' }, WORK).stalledRuns).toBe(0)
  })

  it('counts a repeated answer as a stalled run', () => {
    const after = applyTurnProgress({ stalledRuns: 1, lastTurnText: WORK }, WORK)
    expect(after.stalledRuns).toBe(2)
  })

  it('reaches the stall limit after LOOP_STALL_LIMIT "等待中。" turns (the reported spin)', () => {
    let state = FRESH
    for (let i = 0; i < LOOP_STALL_LIMIT; i++) state = applyTurnProgress(state, '等待中。')
    expect(state.stalledRuns).toBe(LOOP_STALL_LIMIT)
    expect(loopStallVerdict({ continues: 0, stalledRuns: state.stalledRuns })).toBe('stop-stalled')
  })

  it('leaves the state untouched for a text-less turn_complete (kimi/qwen/pi readers)', () => {
    const stalled: LoopStallState = { stalledRuns: 2, lastTurnText: WORK }
    expect(applyTurnProgress(stalled, '')).toBe(stalled)
    expect(applyTurnProgress(stalled, '   \n ')).toBe(stalled)
  })

  it('never stalls a vendor that sends no turn text, however many turns pass', () => {
    let state = FRESH
    for (let i = 0; i < 50; i++) state = applyTurnProgress(state, '')
    expect(loopStallVerdict({ continues: 0, stalledRuns: state.stalledRuns })).toBe('ok')
  })
})

describe('loopStallVerdict', () => {
  it('lets a healthy loop keep going', () => {
    expect(loopStallVerdict({ continues: 0, stalledRuns: 0 })).toBe('ok')
    expect(loopStallVerdict({ continues: LOOP_MAX_CONTINUES - 1, stalledRuns: LOOP_STALL_LIMIT - 1 })).toBe('ok')
  })

  it('stops on the stall limit', () => {
    expect(loopStallVerdict({ continues: 0, stalledRuns: LOOP_STALL_LIMIT })).toBe('stop-stalled')
  })

  it('stops on the continue cap', () => {
    expect(loopStallVerdict({ continues: LOOP_MAX_CONTINUES, stalledRuns: 0 })).toBe('stop-capped')
  })

  it('reports the cap when both trip on the same poll', () => {
    expect(loopStallVerdict({ continues: LOOP_MAX_CONTINUES, stalledRuns: LOOP_STALL_LIMIT })).toBe('stop-capped')
  })
})

describe('parseEventMs', () => {
  it('parses an ISO-8601 timestamp (Claude/Codex)', () => {
    expect(parseEventMs('2026-07-23T07:45:32.000Z')).toBe(Date.parse('2026-07-23T07:45:32.000Z'))
  })

  it('parses a bare epoch-ms string (Kimi wire.jsonl time)', () => {
    expect(parseEventMs('1784762222265')).toBe(1784762222265)
  })

  it('returns NaN for empty or unparseable input', () => {
    expect(Number.isNaN(parseEventMs(''))).toBe(true)
    expect(Number.isNaN(parseEventMs('not-a-date'))).toBe(true)
  })
})

describe('isReplayedTurnComplete', () => {
  const TOL = 60_000
  const NOW = 2_000_000

  it('flags a stale ISO event replayed on backend restart', () => {
    const old = new Date(NOW - TOL - 5_000).toISOString()
    expect(isReplayedTurnComplete(old, NOW, TOL)).toBe(true)
  })

  it('flags a stale epoch-ms (Kimi) event beyond tolerance', () => {
    expect(isReplayedTurnComplete(String(NOW - TOL - 1), NOW, TOL)).toBe(true)
  })

  it('passes a live turn end within tolerance (both formats)', () => {
    expect(isReplayedTurnComplete(String(NOW - 8_000), NOW, TOL)).toBe(false)
    expect(isReplayedTurnComplete(new Date(NOW - 8_000).toISOString(), NOW, TOL)).toBe(false)
  })

  it('treats a missing/unparseable timestamp as live (never suppresses)', () => {
    expect(isReplayedTurnComplete('', NOW, TOL)).toBe(false)
    expect(isReplayedTurnComplete('garbage', NOW, TOL)).toBe(false)
  })
})

describe('turnEndsWithSentinel', () => {
  const S = '---SPEC-DONE---'

  it('accepts the sentinel as the final non-empty line', () => {
    expect(turnEndsWithSentinel(`規格完成。\n${S}`, S)).toBe(true)
    expect(turnEndsWithSentinel(`規格完成。\n${S}\n\n  `, S)).toBe(true)
    expect(turnEndsWithSentinel(`  ${S}  `, S)).toBe(true)
  })

  it('rejects mid-text mentions (quoted protocol / instructions)', () => {
    // Real kickoff instruction lines from the CRM run — these were echoed by
    // the TUI and falsely completed stages under the old log-file scanner.
    expect(turnEndsWithSentinel(`錯誤：完成了 ${S}\n接下來開始工作`, S)).toBe(false)
    expect(turnEndsWithSentinel(`${S}\n正確：最後一行只有 ${S}。`, S)).toBe(false)
    expect(turnEndsWithSentinel(`完成後，最後一行只輸出 ${S}。`, S)).toBe(false)
  })

  it('rejects inline text on the final line', () => {
    expect(turnEndsWithSentinel(`完成了 ${S}`, S)).toBe(false)
    expect(turnEndsWithSentinel(`${S} 以上`, S)).toBe(false)
  })

  it('rejects empty inputs', () => {
    expect(turnEndsWithSentinel('', S)).toBe(false)
    expect(turnEndsWithSentinel('done', '')).toBe(false)
  })

  it('question block followed by a bare sentinel line still ends with the sentinel', () => {
    // Ordering (question wins) is the caller's job; this fn only judges the tail.
    const text = `---QUESTION-START---\ntype: choice\nprompt: MVP 核心？\n---QUESTION-END---\n${S}`
    expect(turnEndsWithSentinel(text, S)).toBe(true)
  })
})
