// @vitest-environment happy-dom
// Closing a pane must clear its persisted record for EVERY non-pipeline origin.
//
// The backend side of this was already fixed and tested
// (backend/tests/test_projects_pane_origin.py::test_unspawn_marks_mcp_pane_removed),
// but onKill gated the manual_pane.unspawn call on `origin === 'manual'`, so an
// mcp-spawned pane never reached it. Its record stayed at spawn_status
// 'spawned', and restoreWorkspacePanes — which restores exactly that set — put
// the pane back as a placeholder on the next workspace switch. The green
// backend test made the gap invisible: nothing exercised the caller.
//
// App.vue cannot be mounted here (backend/terminal/settings/onboarding
// lifecycles all start on mount), so these are source-text assertions in the
// style of the other App.* tests.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

const onKillFn = appSource.slice(
  appSource.indexOf('async function onKill(paneId: string'),
  appSource.indexOf('async function onKill(paneId: string') + 4000
)

describe('pane close persists for every non-pipeline origin', () => {
  it('sends manual_pane.unspawn for manual AND mcp panes', () => {
    // `!== 'pipeline'` is the repo-wide spelling of "a pane the project record
    // owns". Narrowing it to `=== 'manual'` is what resurrected mcp panes.
    const gate = onKillFn.slice(0, onKillFn.indexOf("'manual_pane.unspawn'"))
    expect(gate).toContain("pane.origin !== 'pipeline'")
    expect(gate).not.toContain("pane?.origin === 'manual'")
  })

  it('still guards on the pane existing, so undefined cannot reach the payload', () => {
    // The old `pane?.origin === 'manual'` was false for a missing pane; a bare
    // `!==` flips that to true and then dereferences pane.workspacePath.
    const gate = onKillFn.slice(0, onKillFn.indexOf("'manual_pane.unspawn'"))
    expect(gate).toContain('pane != null')
  })

  it('mirrors the rebuild spawn gate, which already persisted mcp panes', () => {
    // The two rebuild paths re-register the pane under its new id using
    // `!== 'pipeline'`. Recording on rebuild but refusing to clear on close is
    // the asymmetry that resurrected panes.
    const rebuildGates = appSource
      .split("await sendQuiet<ProjectPayload>('manual_pane.spawn'")
      .slice(0, -1)
      .map((chunk) => chunk.slice(-200))
      .filter((gate) => /snap\.origin/.test(gate))
    expect(rebuildGates.length).toBe(2)
    for (const gate of rebuildGates) {
      expect(gate).toContain("snap.origin !== 'pipeline'")
    }
  })

  it('records mcp-spawned panes at spawn time, which is why close must clear them', () => {
    // Panes an agent opens over MCP are persisted exactly like manual ones, so
    // they are eligible for restore and must be eligible for unspawn.
    expect(appSource).toContain("origin: 'mcp'")
  })

  it('leaves no `origin === "manual"` filter anywhere in App.vue', () => {
    // Pins the whole class of bug, not just the one line: with three origin
    // values, equality against 'manual' is never the right test for
    // "not a pipeline pane".
    const offenders = appSource
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'))
      .filter(({ line }) => /origin\s*(\?\.)?\s*===\s*'manual'/.test(line))
    expect(offenders, `origin === 'manual' filters left: ${JSON.stringify(offenders)}`)
      .toHaveLength(0)
  })

  it('restores exactly the records unspawn clears, which is why the gate matters', () => {
    // Documents the coupling: restore reads spawn_status === 'spawned', so any
    // close path that fails to write 'removed' resurrects the pane.
    const restoreFn = appSource.slice(appSource.indexOf('function restoreWorkspacePanes'))
    expect(restoreFn.slice(0, 4000)).toContain("spawn_status === 'spawned'")
  })
})
