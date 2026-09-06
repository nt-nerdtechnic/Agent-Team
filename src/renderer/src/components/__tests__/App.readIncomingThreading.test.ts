// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so it isn't practical
// to mount it here (same reasoning as App.spawnAdvisories.test.ts). These tests
// parse the source text instead, guarding one seam: `ui.messaging.readIncoming`
// is the ONLY path by which cli_read_incoming learns a message's correlation
// id, reply link and hold — the backend reads them straight off this reply, so
// a field dropped here is a field the MCP tool can never report.
//
// What this cannot prove is that the values are right; that is covered where
// the fields are actually produced (useAgentMessaging.test.ts for the persisted
// correlation id and reply link, useAgentMessagingHoldReport.test.ts for the
// hold) and consumed (backend/tests/test_plan_mcp_read_incoming.py).
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('ui.messaging.readIncoming threading and hold', () => {
  const cmd = block(
    "registerCommand('ui.messaging.readIncoming', (args) => {",
    "\nregisterCommand('ui.messaging.settleRead'",
  )

  it('returns the correlation id, so a reader can reply to a specific message', () => {
    // The envelope typed into a pane carries `re: <correlationId>`. An agent
    // that READS its mail instead had no equivalent, which is what left
    // cli_send's reply_to with nothing to quote.
    expect(cmd).toContain('correlationId: m.correlationId ?? null,')
  })

  it('returns what a message answers', () => {
    expect(cmd).toContain('inReplyTo: m.inReplyTo ?? null,')
  })

  it('returns why the message has not been typed in yet', () => {
    // Live queue state: it exists nowhere but the window that owns the queue,
    // so this reply is the only place cli_read_incoming can get it.
    expect(cmd).toContain('hold: m.hold ? { key: m.hold.key, n: m.hold.n ?? null } : null,')
  })

  it('still returns the fields it always did', () => {
    for (const field of [
      'uid: m.uid,',
      'sender: m.from,',
      'status: m.status,',
      'kind: m.kind ?? null,',
      'content: m.content.slice(0, cap),',
      'createdAt: m.createdAt,',
    ]) {
      expect(cmd).toContain(field)
    }
  })
})
