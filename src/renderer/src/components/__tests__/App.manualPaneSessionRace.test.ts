// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. They lock in the
// ordering fix for the manual-pane session race: spawnPane must NOT persist the
// session itself (it always ran before its caller created the PaneRecord, so
// the backend logged 'pane ... not found — session not persisted' once per
// spawned pane), and every caller must carry the session id on manual_pane.spawn
// instead.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

describe('manual pane session persistence ordering', () => {
  it('spawnPane does not persist the session on its manual early-return path', () => {
    // The guard reads `!== 'pipeline'` (not `=== 'manual'`) so that mcp-spawned
    // panes take the same early-return path as manual ones.
    const start = appSource.indexOf(
      "if (pane.origin !== 'pipeline' && !pane.roleKey && !pane.kickoffPrompt) {"
    )
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(start, appSource.indexOf('return id', start))
    expect(block).not.toContain('persistPaneSession(')
  })

  it('every manual_pane.spawn call carries a session_id', () => {
    const marker = "'manual_pane.spawn'"
    const offsets: number[] = []
    for (let i = appSource.indexOf(marker); i !== -1; i = appSource.indexOf(marker, i + 1)) {
      offsets.push(i)
    }
    expect(offsets.length).toBeGreaterThan(0)
    for (const offset of offsets) {
      const payload = appSource.slice(offset, appSource.indexOf('})', offset))
      expect(payload).toContain('session_id:')
    }
  })
})
