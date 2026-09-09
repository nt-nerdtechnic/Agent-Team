// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The window's half of Stop-hook delivery: the backend asks what is queued for
// a claude pane while its Stop hook holds the agent open, and this answers. The
// queue logic itself is unit-tested in
// composables/__tests__/useAgentMessagingHookDrain.test.ts; what has to be
// asserted against the source is the wiring, because App.vue cannot be mounted
// in this suite.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function handler(eventName: string): string {
  const start = appSource.indexOf(`backend.on('${eventName}'`)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n})\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('agent_msg.hook_drain — the window side', () => {
  it('answers the request through the messaging queue', () => {
    const body = handler('agent_msg.hook_drain')
    expect(body).toContain('messaging.drainForHook')
    expect(body).toContain("'agent_msg.hook_drain_result'")
    expect(body).toContain('request_id: ev.request_id')
  })

  it('only keeps the reservation when the backend says the hook still had it', () => {
    // A hook that timed out before the answer arrived has already let Claude
    // stop; keeping the row as delivered would lose the message for good.
    const body = handler('agent_msg.hook_drain')
    expect(body).toContain('resp.payload?.delivered')
    expect(body).toContain('messaging.settleHookDrain(paneId, !!resp.ok && !!resp.payload?.delivered)')
    expect(body).toContain('.catch(() => { if (envelope) messaging.settleHookDrain(paneId, false) })')
  })

  it('always answers, so a window with nothing queued does not cost the hook its timeout', () => {
    // drainForHook returns null for "nothing to hand over"; the reply has to go
    // out anyway, as an empty envelope.
    const body = handler('agent_msg.hook_drain')
    expect(body).toContain('envelope: envelope ?? ')
    expect(body).not.toContain('if (!envelope) return')
  })

  it('only drains a pane this window actually owns', () => {
    const body = handler('agent_msg.hook_drain')
    expect(body).toContain('panes.value.some((p) => p.id === paneId)')
  })

  it('does not await the reply, which the hook is not waiting on', () => {
    // The hook is blocking the agent; the answer has to be produced in this
    // tick, not after a round-trip.
    const body = handler('agent_msg.hook_drain')
    expect(body).not.toContain('await ')
  })
})

describe('agent.activity — a turn end the Stop hook superseded', () => {
  it('drops only the signals that say the pane is free', () => {
    const start = appSource.indexOf("if (ev.event_type === 'turn_complete') {")
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, start + 3000)
    // Matched on the guard rather than the exact call: what this test owns is
    // that the idle timestamp is the thing skipped when the turn was
    // superseded, not how that timestamp is recorded.
    const guarded = body.slice(body.indexOf('if (!ev.superseded) {'), body.indexOf('markTurnComplete'))
    expect(guarded).toContain('recordTurnComplete(paneTurnCompleteAt, ev.pane_id')
    expect(body).toContain('if (!markerReply && !ev.superseded) scheduleDoneNotify')
  })

  it('still reads the turn text, which is real whether or not the turn ended', () => {
    // The MSG blocks this pane addressed to others, its sentinels and its
    // auto-name all come from this text; the flag only means "not idle yet".
    const start = appSource.indexOf("if (ev.event_type === 'turn_complete') {")
    const body = appSource.slice(start, start + 3000)
    expect(body).toContain('onTurnCompleteForMessaging(ev.pane_id,')
    expect(body).not.toContain('if (ev.superseded) return')
  })
})
