// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. The decision
// itself is unit-tested in lib/__tests__/sessionMarkerTurn.test.ts; what is
// checked here is the wiring, i.e. that the marker gate is actually armed by
// the bootstrap and that every side effect it is supposed to drop consults it.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fnBody(header: string): string {
  const start = appSource.indexOf(header)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

function activityHandler(): string {
  const start = appSource.indexOf("backend.on('agent.activity'")
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('backend.on(', start + 1)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('session-marker gate wiring', () => {
  it('the bootstrap arms the gate only after the marker was actually sent', () => {
    const body = fnBody('async function sendSessionMarkerBootstrap(')
    expect(body).toContain('pane.markerReplyPending = true')
    // Armed after the Enter that submits the marker, never on an early return.
    expect(body.indexOf("data: '\\r'")).toBeLessThan(body.indexOf('pane.markerReplyPending = true'))
  })

  it('the activity handler consults the gate and disarms it', () => {
    const body = activityHandler()
    expect(body).toContain('markerTurnActionFor(ev)')
    expect(body).toContain('markerPane.markerReplyPending = undefined')
    expect(body).toContain("markerReply = action === 'suppress'")
  })

  it('a marker reply never chimes done, names the pane, or carries MSG blocks', () => {
    const body = activityHandler()
    expect(body).toContain('if (!markerReply) scheduleDoneNotify(')
    expect(body).toContain("onTurnCompleteForMessaging(ev.pane_id, markerReply ? '' : (ev.text ?? '')")
    const fallback = body.slice(body.indexOf('Auto-name fallback'))
    expect(fallback).toContain('!markerReply')
  })

  it('keeps the bookkeeping a real idle pane still needs', () => {
    const body = activityHandler()
    // The pane genuinely went idle, so the badge and the turn timestamp must
    // stay truthful — only the user-facing effects are dropped.
    expect(body).toContain('paneTurnCompleteAt.set(ev.pane_id, Date.now())')
    expect(body).toContain('markTurnComplete?.()')
    expect(body).not.toContain('if (!markerReply) paneTurnCompleteAt')
  })
})
