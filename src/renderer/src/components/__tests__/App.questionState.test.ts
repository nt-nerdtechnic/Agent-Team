// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// QUESTION's rules are unit-tested in lib/__tests__/cliAwaitingInput.test.ts.
// What THIS file pins is the part that cannot be executed: App.vue is an SFC
// the suite cannot mount, so the adapter between those rules and the pane —
// and the two gates the state must not silently close — are asserted against
// the source, the same way the other App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function activityHandler(): string {
  const start = appSource.indexOf("backend.on('agent.activity'")
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('backend.on(', start + 1)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('agent.activity → QUESTION badge adapter', () => {
  it('routes the decision through questionActionFor instead of re-deciding inline', () => {
    const body = activityHandler()
    expect(body).toContain('questionActionFor(ev)')
    expect(body).toContain("=== 'raise'")
    expect(body).toContain("=== 'clear'")
  })

  it('calls both sides of the badge, and only from that decision', () => {
    const body = activityHandler()
    expect(body).toContain('markQuestion?.()')
    expect(body).toContain('clearQuestion?.()')
    // Exactly one call site each: the decision was duplicated across the
    // turn_complete and agent_active branches before it was hoisted, and two
    // copies is how the two halves drift apart again.
    expect(body.split('markQuestion?.()').length - 1).toBe(1)
    expect(body.split('clearQuestion?.()').length - 1).toBe(1)
  })

  it('decides before the branch split so both event types reach it', () => {
    const body = activityHandler()
    const decision = body.indexOf('questionActionFor(ev)')
    const branchSplit = body.indexOf("if (ev.event_type === 'turn_complete')")
    expect(decision).toBeGreaterThan(-1)
    expect(branchSplit).toBeGreaterThan(-1)
    expect(decision).toBeLessThan(branchSplit)
  })

  it('imports the decision rather than reimplementing the text heuristic', () => {
    expect(appSource).toContain('questionActionFor,')
    // textEndsOnQuestion is questionActionFor's business now; a second caller
    // in App.vue would be a copy of the rule that tests do not cover.
    expect(appSource).not.toContain('textEndsOnQuestion(')
  })
})

// The two whitelists QUESTION had to be added to. It renames panes that were
// already reaching these gates as 'idle', so leaving it out of either one
// would newly park those panes — a regression the state was never meant to
// make. Both are asserted here because both are one-line edits that a future
// refactor could drop without any test noticing.
describe('QUESTION does not close gates that were open before it existed', () => {
  it('passes the inter-CLI messaging gate, like running and idle', () => {
    const start = appSource.indexOf('function messagingHoldKey(')
    expect(start).toBeGreaterThan(-1)
    const gate = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(gate).toContain("status !== 'question'")
    expect(gate).toContain("return 'not-ready'")
    // AWAITING must stay excluded: that one is a permission prompt, and it was
    // never allowed through.
    expect(gate).not.toContain("status !== 'awaiting'")
  })

  it('is excluded from plan-dispatch pane reuse, deliberately', () => {
    // The opposite call, and the one behaviour change this state makes: an
    // AskUserQuestion box is a select widget, so a dispatched prompt typed
    // into it would be swallowed as the answer.
    const dispatch = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/lib/planDispatch.ts'),
      'utf8'
    )
    expect(dispatch).toContain("p.status === 'idle'")
    expect(dispatch).not.toContain("p.status === 'question'")
  })
})
