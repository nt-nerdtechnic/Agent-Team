import { describe, it, expect } from 'vitest'
import { activityMeansWorking, slotFinished, allSlotsFinished, turnCompleteDone, loopContinueReady, turnEndsWithSentinel, parseEventMs, isReplayedTurnComplete, normalizeTurnText, turnMadeProgress, loopBackoffMs, applyTurnProgress, loopStallVerdict, loopWaitingOnSubagents, turnUsedNoTools, LOOP_STALL_BACKOFF_MS, LOOP_MIN_PROGRESS_CHARS, LOOP_STALL_LIMIT, LOOP_MAX_CONTINUES, LOOP_SUBAGENT_WAIT_MAX_MS, LOOP_RECENT_TURNS, type SlotSignal, type LoopStallState } from '../completion'

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
    expect(applyTurnProgress(FRESH, WORK)).toEqual({ stalledRuns: 0, lastTurnText: WORK, recentTurns: [WORK] })
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

// ── The reported spin (2026-08-26) ─────────────────────────────────────────
//
// A loop resent "繼續" every 5s for hours while the CLI sat waiting on two
// background agents. Every guard passed: the turn really had ended (Claude's
// Stop hook fires when the main agent stops to wait), the continue really had
// woken it, and each turn's TEXT really was different — the agent restated
// "still waiting" in fresh words every single time.
//
// These are the four turns from the report, verbatim.
const SPIN_TURNS = [
  '回歸 agent 已被喚回去收結果（背景 phpunit 應已跑完，遺失就重跑）。瀏覽器實測 agent 仍在進行中。兩者回報後收尾。尚未完成，不輸出標記。',
  '回歸 agent 正在收取/重跑結果、瀏覽器實測 agent 仍在操作中，兩份回報一到即產出報告書收尾。尚未完成，不輸出標記。',
  '兩個驗收 agent 都在收尾階段，等待回報中。尚未完成，不輸出標記。',
  '驗收回報尚未到達，持續等待中（回歸 agent 收結果、瀏覽器 agent 實測）。尚未完成，不輸出標記。',
]

describe('loopWaitingOnSubagents', () => {
  const NOW = 10_000_000

  it('holds the loop while a fresh count says subagents are running', () => {
    expect(loopWaitingOnSubagents({ pending: 2, observedAt: NOW - 5_000, now: NOW })).toBe(true)
  })

  it('does not hold when nothing is pending', () => {
    expect(loopWaitingOnSubagents({ pending: 0, observedAt: NOW - 5_000, now: NOW })).toBe(false)
  })

  it('does not hold on a pane that never reported a count', () => {
    expect(loopWaitingOnSubagents({ pending: 0, observedAt: 0, now: NOW })).toBe(false)
    // A count with no report time is unusable even if non-zero.
    expect(loopWaitingOnSubagents({ pending: 3, observedAt: 0, now: NOW })).toBe(false)
  })

  it('fails OPEN once the count is stale — a drifted count only ever delays', () => {
    const stale = NOW - LOOP_SUBAGENT_WAIT_MAX_MS - 1
    expect(loopWaitingOnSubagents({ pending: 2, observedAt: stale, now: NOW })).toBe(false)
  })

  it('still holds right up to the staleness boundary', () => {
    const edge = NOW - LOOP_SUBAGENT_WAIT_MAX_MS + 1
    expect(loopWaitingOnSubagents({ pending: 1, observedAt: edge, now: NOW })).toBe(true)
  })

  it('never holds on a negative count (a stop with no matching start)', () => {
    expect(loopWaitingOnSubagents({ pending: -1, observedAt: NOW, now: NOW })).toBe(false)
  })
})

describe('normalizeTurnText CJK wrapping', () => {
  it('drops the space a TUI wrap inserts between two Chinese characters', () => {
    // Chinese has no space to collapse back down to, so a wrap ADDS one.
    // Without this, every wrapped repeat reads as a brand-new turn.
    expect(normalizeTurnText('尚未完成，不輸出標記。')).toBe(
      normalizeTurnText('尚未完成，\n  不輸出標記。')
    )
  })

  it('makes a wrapped Chinese repeat compare equal', () => {
    const wrapped = SPIN_TURNS[0].replace('。瀏覽器', '。\n  瀏覽器')
    expect(turnMadeProgress(wrapped, SPIN_TURNS[0])).toBe(false)
  })

  it('leaves English word spacing alone', () => {
    expect(normalizeTurnText('ran the suite')).toBe('ran the suite')
    // A space with CJK on only one side is real spacing, not a wrap artefact.
    expect(normalizeTurnText('執行 pytest 完成')).toBe('執行 pytest 完成')
  })
})

describe('text comparison stays exact', () => {
  it('calls a verbatim repeat a stall, ignoring only re-wrapping', () => {
    expect(turnMadeProgress(SPIN_TURNS[0], SPIN_TURNS[0])).toBe(false)
    expect(turnMadeProgress(SPIN_TURNS[0].replace('。瀏覽器', '。\n  瀏覽器'), SPIN_TURNS[0])).toBe(false)
  })

  it('does NOT catch the reported spin — the reworded turns read as progress', () => {
    // Pinned deliberately. A fuzzy (trigram-similarity) judgement was tried
    // here and dropped: the threshold that caught these four turns also called
    // "Completed step 1…" a repeat of "Completed step 0…", which differs by one
    // character and is real progress. Text cannot tell the two apart, so the
    // spin is caught by turnUsedNoTools and loopWaitingOnSubagents instead.
    expect(turnMadeProgress(SPIN_TURNS[1], SPIN_TURNS[0])).toBe(true)
    expect(turnMadeProgress(SPIN_TURNS[3], SPIN_TURNS[2])).toBe(true)
    // The third turn IS caught, but only by the length floor — it happens to be
    // under LOOP_MIN_PROGRESS_CHARS. One stall in four never reaches
    // LOOP_STALL_LIMIT, and the next turn resets the counter to zero, which is
    // why the run span hours on the old judgement.
    expect(SPIN_TURNS[2].length).toBeLessThan(LOOP_MIN_PROGRESS_CHARS)
    expect(turnMadeProgress(SPIN_TURNS[2], SPIN_TURNS[1])).toBe(false)
  })

  it('keeps near-identical but genuinely stepwise turns as progress', () => {
    const step0 = 'Completed step 0 of the migration and verified its output.'
    const step1 = 'Completed step 1 of the migration and verified its output.'
    expect(turnMadeProgress(step1, step0)).toBe(true)
  })
})

describe('turnUsedNoTools', () => {
  it('is true when a reporting pane ended a turn without touching a tool', () => {
    expect(turnUsedNoTools({ toolUsesThisTurn: 0, toolSignalsSeen: true })).toBe(true)
  })

  it('is false when the turn used tools', () => {
    expect(turnUsedNoTools({ toolUsesThisTurn: 3, toolSignalsSeen: true })).toBe(false)
  })

  it('is false for a vendor that never reports tool use — the whole safety net', () => {
    // Without this, every turn of every non-hook CLI would look stalled and
    // stop a perfectly healthy loop after LOOP_STALL_LIMIT turns.
    expect(turnUsedNoTools({ toolUsesThisTurn: 0, toolSignalsSeen: false })).toBe(false)
  })
})

describe('the reported spin is now caught', () => {
  const NO_TOOLS = { toolUsesThisTurn: 0, toolSignalsSeen: true }
  const WORKED = { toolUsesThisTurn: 4, toolSignalsSeen: true }

  it('stops the loop after LOOP_STALL_LIMIT waiting turns', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (const turn of SPIN_TURNS) state = applyTurnProgress(state, turn, NO_TOOLS)
    expect(state.stalledRuns).toBe(SPIN_TURNS.length)
    expect(loopStallVerdict({ continues: 4, stalledRuns: state.stalledRuns })).toBe('stop-stalled')
  })

  it('used to look like progress on every turn — the old verbatim judgement', () => {
    // Same four turns, judged the way they were before: each differs from the
    // one before it, so the counter never left zero and only the 200-continue
    // cap could end the run.
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (const turn of SPIN_TURNS) state = applyTurnProgress(state, turn)
    expect(state.stalledRuns).toBe(0)
  })

  it('leaves a genuinely working loop alone', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (const turn of SPIN_TURNS) state = applyTurnProgress(state, turn, WORKED)
    expect(state.stalledRuns).toBe(0)
    expect(loopStallVerdict({ continues: 4, stalledRuns: state.stalledRuns })).toBe('ok')
  })

  it('counts an empty-text turn that touched no tool', () => {
    // Claude's Stop hook carries no text. Before, that was UNKNOWN and the
    // turn was ignored entirely; now the tool signal can still speak for it.
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (let i = 0; i < LOOP_STALL_LIMIT; i++) state = applyTurnProgress(state, '', NO_TOOLS)
    expect(loopStallVerdict({ continues: 0, stalledRuns: state.stalledRuns })).toBe('stop-stalled')
  })

  it('still ignores an empty-text turn from a vendor with no tool signals', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (let i = 0; i < 50; i++) {
      state = applyTurnProgress(state, '', { toolUsesThisTurn: 0, toolSignalsSeen: false })
    }
    expect(loopStallVerdict({ continues: 0, stalledRuns: state.stalledRuns })).toBe('ok')
  })
})

describe('applyTurnProgress recent-turn history', () => {
  const A = 'Ran the migration on the staging database and verified the row counts matched.'
  const B = 'Rebuilt the search index from scratch and confirmed the query latency dropped.'

  it('catches a two-phrase alternation that verbatim comparison called progress', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (const turn of [A, B, A, B]) state = applyTurnProgress(state, turn)
    // A and B each repeat a turn inside the retained window.
    expect(state.stalledRuns).toBeGreaterThan(0)
  })

  it('keeps at most LOOP_RECENT_TURNS turns of history', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (let i = 0; i < LOOP_RECENT_TURNS + 3; i++) {
      state = applyTurnProgress(state, `Completed step ${i} of the migration and verified its output.`)
    }
    expect(state.recentTurns?.length).toBe(LOOP_RECENT_TURNS)
  })

  it('does not call a turn stalled just because it fell out of the window', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (let i = 0; i < LOOP_RECENT_TURNS + 1; i++) {
      state = applyTurnProgress(state, `Completed step ${i} of the migration and verified its output.`)
    }
    expect(state.stalledRuns).toBe(0)
  })
})

describe('activityMeansWorking', () => {
  it('treats ordinary activity as the pane working', () => {
    expect(activityMeansWorking('hook:pre_tool_use')).toBe(true)
    expect(activityMeansWorking('hook:notification')).toBe(true)
    expect(activityMeansWorking('user')).toBe(true)
    expect(activityMeansWorking('')).toBe(true)
  })

  it('does not count a subagent finishing as the pane working', () => {
    expect(activityMeansWorking('hook:subagent_stop')).toBe(false)
  })
})

describe('the full wait-then-resume sequence', () => {
  // Walks one real exchange through the actual predicates, which is where the
  // pieces meet: the unit tests above each pass while the SEQUENCE still jams.
  const SETTLE = 1500
  const ARMED = 1000
  const TASK_STARTED = 1100 // PreToolUse(Task) → agent_active
  const TURN_ENDED = 1200 // "still waiting" → Stop hook → turn_complete
  const SUBAGENT_DONE = 5000 // SubagentStop

  it('holds the loop while the subagent runs', () => {
    expect(loopWaitingOnSubagents({ pending: 1, observedAt: TURN_ENDED, now: 1300 })).toBe(true)
  })

  it('lets the loop continue once the subagent is done', () => {
    // The gate opens (count back to zero) AND the continue verdict must agree.
    expect(loopWaitingOnSubagents({ pending: 0, observedAt: SUBAGENT_DONE, now: 9000 })).toBe(false)
    expect(
      loopContinueReady({
        turnCompleteAt: TURN_ENDED,
        // SubagentStop did NOT advance the clock — activityMeansWorking said no.
        lastActiveAt: TASK_STARTED,
        armedAt: ARMED,
        now: 9000,
        settleMs: SETTLE,
      })
    ).toBe(true)
  })

  it('would jam forever if SubagentStop advanced the activity clock', () => {
    // The regression this pins: turnCompleteDone requires the turn end to be
    // the LATEST signal, so an activity stamp landing after it can never be
    // overtaken by anything except a NEW turn — and a main agent that stays
    // idle never produces one. Silent, and fails CLOSED.
    expect(
      loopContinueReady({
        turnCompleteAt: TURN_ENDED,
        lastActiveAt: SUBAGENT_DONE,
        armedAt: ARMED,
        now: 9000,
        settleMs: SETTLE,
      })
    ).toBe(false)
  })
})
