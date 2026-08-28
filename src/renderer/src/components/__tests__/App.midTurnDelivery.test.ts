// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_SPECS } from '@navide/plugin-shell'

// A CLI that queues typed input mid-turn does not need Navide to wait for its
// turn to end. Lifting that wait is what closes the 78s-vs-2s gap between a
// reply from a busy pane and a message into an idle one — but the same hold
// answer also drives two things that must NOT be exempted: the busy state the
// backend registry reports (cli_wait_idle / cli_list_targets) and the continue
// button, which types into the composer. deliveryHoldKey exists to keep those
// apart, and this file is what stops them being merged back together.
//
// messagingHoldKey / deliveryHoldKey live in App.vue, which the suite cannot
// mount, so they are asserted against the source the way the other
// App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('acceptsMidTurnInput — the vendor declaration', () => {
  it('is declared by claude', () => {
    const claude = AGENT_SPECS.find((s) => s.agentKey === 'claude')
    expect(claude?.acceptsMidTurnInput).toBe(true)
  })

  it('is not assumed for any other vendor', () => {
    // Each vendor has to be measured. qwen is the standing counter-example:
    // it aggregates several queued messages into one submission, so delivering
    // mid-turn there merges two senders into a single turn.
    const others = AGENT_SPECS.filter((s) => s.agentKey !== 'claude')
    expect(others.filter((s) => s.acceptsMidTurnInput)).toEqual([])
  })

  it('leaves qwen on the turn-boundary holds', () => {
    const qwen = AGENT_SPECS.find((s) => s.agentKey === 'qwen')
    expect(qwen).toBeDefined()
    expect(qwen?.acceptsMidTurnInput).toBeUndefined()
  })
})

describe('deliveryHoldKey — the exemption', () => {
  it('lifts only the two turn-boundary holds', () => {
    const body = fn('deliveryHoldKey')
    expect(body).toContain("key !== 'mid-turn'")
    expect(body).toContain("key !== 'settling'")
    expect(body).toContain('acceptsMidTurnInput')
  })

  it('passes every other hold through untouched', () => {
    // Anything that is not one of the two boundary holds returns as-is, so a
    // new hold reason added to messagingHoldKey is honoured by default rather
    // than silently exempted.
    const body = fn('deliveryHoldKey')
    expect(body).toContain('return key')
  })

  it('never lifts the typing hold', () => {
    // `typing` is about the person at the keyboard, not the turn — a
    // half-written line is lost the same way whatever the CLI queues.
    const body = fn('deliveryHoldKey')
    expect(body).not.toContain("'typing'")
  })

  it('derives from messagingHoldKey rather than re-deriving the gate', () => {
    const body = fn('deliveryHoldKey')
    expect(body).toContain('messagingHoldKey(paneId, opts)')
  })
})

describe('the exemption reaches delivery and nothing else', () => {
  it('is what the messaging composable is given', () => {
    expect(appSource).toContain('idleHoldKey: deliveryHoldKey')
    expect(appSource).toContain('isPaneIdle: (paneId: string) => deliveryHoldKey(paneId) === null')
  })

  it('is NOT applied to the push path', () => {
    // A push channel is not the typed path. claude's rewake hook is the idle
    // half of Stop-hook delivery, and mid-turn belongs to the Stop hook — which
    // fires at the turn boundary anyway, so there is no latency to win here.
    // Handing an envelope to a waiter parked for some other event would mark it
    // delivered to a CLI that never acted on it.
    const body = fn('pushTargetForMessaging')
    expect(body).toContain('messagingHoldKey(paneId, { ignoreTyping: !channel.holdsInputBox })')
    expect(body).not.toContain('deliveryHoldKey(paneId, {')
  })

  it('is NOT applied to the busy state the backend registry mirrors', () => {
    // A mid-turn pane is busy whatever it will accept. Exempting it here would
    // make cli_wait_idle return immediately for every claude pane.
    const body = fn('isPaneIdleForMessaging')
    expect(body).toContain('messagingHoldKey(paneId) === null')
    expect(body).not.toContain('deliveryHoldKey')
    expect(fn('syncPaneBusy')).toContain('isPaneIdleForMessaging')
  })

  it('is NOT applied to the continue button', () => {
    // That one types into the composer, so it must land between turns.
    const body = fn('continueRestoredPane')
    expect(body).toContain('messagingHoldKey(paneId) !== null')
    expect(body).not.toContain('deliveryHoldKey')
  })
})
