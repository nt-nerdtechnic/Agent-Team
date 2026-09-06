// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so it isn't practical
// to mount it here (same reasoning as App.paneIdAlias.test.ts). This is a
// source assertion on one wiring rule, not a behavioural test: lineage is
// renderer state, and agent_msg.register is the only way it reaches the
// backend. Drop the key from that payload and cli_whoami can never tell a child
// agent who opened it — while every backend test still passes, because they
// hand the registry the value this line is supposed to send.
//
// What happens once it arrives (the registry field, cli_whoami's answer, a
// parent that was rebuilt or has closed) is covered in
// backend/tests/test_plan_mcp_whoami.py.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('agent_msg.register carries who opened the pane', () => {
  const mirror = block('function mirrorMessagingHandle(', '\nfunction unregisterPaneMessaging')

  it('sends the parent pane id with every mirror', () => {
    expect(mirror).toContain("spawned_by: pane.spawnedBy ?? '',")
  })

  it('sends it from the one place the backend registry is written', () => {
    // A second register call site would be a second chance to forget the key.
    expect(appSource.match(/\.send\('agent_msg\.register'/g)).toHaveLength(1)
  })
})
