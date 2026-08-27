// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The App.vue half of the background-subagent gate. The pure predicates it
// composes are covered in lib/__tests__/completion.test.ts; what cannot be
// asserted there is the WIRING — which clock the loop reads, where the gate
// sits relative to the other verdicts, and that the shared clock was left
// alone. Those are exactly the joints a later edit breaks silently, because
// every unit test still passes while the sequence jams.
//
// App.vue cannot be mounted by this suite, so the wiring is asserted against
// the source the way the other App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function startLoopWatcherBody(): string {
  const start = appSource.indexOf('function startLoopLimitWatcher(')
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('}, LOOP_LIMIT_POLL_MS)', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('the loop reads its own activity clock', () => {
  it('judges continue-readiness on paneLastWorkingAt, not the shared clock', () => {
    // The regression: a subagent finishing arrives as an agent_active, and
    // stamping the loop's clock with it makes turn_complete permanently
    // not-the-latest-signal, so the loop stops continuing forever — silently,
    // and failing CLOSED. Reverting this line to paneLastActiveAt reintroduces
    // exactly that.
    const body = startLoopWatcherBody()
    const call = body.slice(body.indexOf('loopContinueReady({'))
    expect(call).toContain('lastActiveAt: paneLastWorkingAt.get(paneId)')
    expect(call).not.toContain('lastActiveAt: paneLastActiveAt.get(paneId)')
  })

  it('keeps stamping the SHARED clock unconditionally', () => {
    // Delivery gating, the done notification and the pipeline's stage verdict
    // all read paneLastActiveAt. Narrowing it instead of adding a second clock
    // would change all three, which is not what this fix is for.
    expect(appSource).toContain("paneLastActiveAt.set(ev.pane_id, Date.now())")
    const stamp = appSource.indexOf("paneLastActiveAt.set(ev.pane_id, Date.now())")
    const line = appSource.slice(appSource.lastIndexOf('\n', stamp), stamp)
    expect(line.trim()).toBe('')
  })

  it('stamps the loop clock only for events that mean this pane is working', () => {
    expect(appSource).toContain(
      "if (activityMeansWorking(ev.detail ?? '')) paneLastWorkingAt.set(ev.pane_id, Date.now())"
    )
  })
})

describe('the gate sits in the right place in the poll', () => {
  it('runs before the continue verdict', () => {
    // Behind it, the gate would never be consulted: loopContinueReady is
    // satisfied by exactly the turn this gate exists to reject.
    const body = startLoopWatcherBody()
    expect(body.indexOf('loopWaitingOnSubagents({')).toBeLessThan(body.indexOf('loopContinueReady({'))
  })

  it('runs after the stop verdicts, so a capped or stalled loop still ends', () => {
    // A pane parked on a subagent that never reports back must not become a
    // loop that can no longer be stopped by its own counters.
    const body = startLoopWatcherBody()
    expect(body.indexOf('loopStallVerdict(watcher)')).toBeLessThan(
      body.indexOf('loopWaitingOnSubagents({')
    )
  })

  it('runs after the session-limit wait, which owns the pane while it holds', () => {
    const body = startLoopWatcherBody()
    expect(body.indexOf('pane.loopWaitUntil != null')).toBeLessThan(
      body.indexOf('loopWaitingOnSubagents({')
    )
  })
})

describe('per-turn bookkeeping', () => {
  it('resets the tool count when a turn is armed, and keeps the per-pane flag', () => {
    const start = appSource.indexOf('function armLoopTurn(')
    const body = appSource.slice(start, appSource.indexOf('\n}\n', start))
    expect(body).toContain('watcher.toolUsesThisTurn = 0')
    // toolSignalsSeen is what stops this judgement from firing on the 12 CLIs
    // that never report tool use at all. Resetting it per turn would make every
    // one of their turns look like a stall.
    expect(body).not.toContain('toolSignalsSeen = false')
  })

  it('drops the subagent count with the watcher that reads it', () => {
    // A count left above zero — the CLI exited while a subagent ran, so its
    // stop never arrived — would gate the NEXT loop on this pane.
    const start = appSource.indexOf('function stopLoopLimitWatcher(')
    const body = appSource.slice(start, appSource.indexOf('\n}\n', start))
    expect(body).toContain('panePendingSubagents.delete(paneId)')
  })
})

describe('LOOP_WAIT wiring — the vendor-agnostic half', () => {
  function noteLoopWaitBody(): string {
    const start = appSource.indexOf('function noteLoopWait(')
    expect(start).toBeGreaterThan(-1)
    return appSource.slice(start, appSource.indexOf('\n}\n', start))
  }

  it('holds the next continue rather than stopping the loop', () => {
    // Waiting is a legitimate state. Stopping the run here would turn an honest
    // "still waiting" into a dead loop — the fail-CLOSED shape this whole area
    // is bounded against.
    const body = noteLoopWaitBody()
    expect(body).toContain('watcher.nextContinueAt = Date.now() + holdMs')
    expect(body).not.toContain('stopLoopSpinning')
  })

  it('stops honouring the marker once the budget is spent', () => {
    // Without this bound, a marker-every-turn agent parks the loop for good.
    const body = noteLoopWaitBody()
    expect(body).toContain('if (!loopWaitHonoured(watcher))')
    expect(body).toContain('return false')
  })

  it('guards against replayed turns the same way the done marker does', () => {
    // A re-parsed historical turn must not schedule a wait for a loop that has
    // since moved on.
    expect(noteLoopWaitBody()).toContain('TURN_TEXT_REPLAY_TOLERANCE_MS')
  })

  it('skips the stall judgement only for a HONOURED wait', () => {
    // The two mechanisms must not double-count: a wait has its own budget, and
    // a turn that is not an honoured wait has to fall through unchanged.
    expect(appSource).toContain(
      "if (!noteLoopWait(ev.pane_id, ev.text ?? '', ev.timestamp ?? '')) {"
    )
  })

  it('resets the streak on any other turn but keeps the spent budget', () => {
    const body = noteLoopWaitBody()
    expect(body).toContain('applyLoopWait(watcher, false)')
  })
})

describe('tool signals are read from every vendor that reports them', () => {
  it('does not hardcode the claude hook detail', () => {
    // opencode's reader already names tools as `tool:<name>`; hardcoding the
    // hook detail was what kept that signal unused.
    expect(appSource).toContain("if (detailMeansToolUse(ev.detail ?? '')) {")
    expect(appSource).not.toContain("if (ev.detail === 'hook:pre_tool_use') {")
  })
})
