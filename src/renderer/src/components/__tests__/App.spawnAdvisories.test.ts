// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles (see
// App.paneCycle.test.ts / App.logPreview.test.ts), so it isn't practical to
// mount it here. These tests parse the source text instead, guarding the
// wiring for two spawn-gate gaps: ui.pane.create bypassing the gate entirely,
// and cli_open_agent's advisories never reaching the MCP caller. The gate's
// own logic (spawnAdvisoriesFor, evaluateTurnSpawns accumulation) is unit
// tested directly in lib/__tests__/agentSpawnGate.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string, fromIndex = 0): string {
  const start = appSource.indexOf(startMarker, fromIndex)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('ui.pane.create spawn-gate wiring', () => {
  const cmd = block("registerCommand('ui.pane.create', async (args) => {", "\nregisterCommand('ui.pane.close'")

  it('checks the standalone gate context before spawning', () => {
    expect(cmd).toContain('const gateCtx = standaloneSpawnGateContext()')
  })

  it('rejects a taken name with the gate\'s own wording, before spawnPane runs', () => {
    const nameCheckIdx = cmd.indexOf('gateCtx.isNameTaken(name)')
    const spawnIdx = cmd.indexOf('await spawnPane({')
    expect(nameCheckIdx).toBeGreaterThan(-1)
    expect(spawnIdx).toBeGreaterThan(-1)
    expect(nameCheckIdx).toBeLessThan(spawnIdx)
    expect(cmd).toContain('已被其他 pane 使用，請換一個名稱')
  })

  it('does not require name — the collision check only runs when one was given', () => {
    expect(cmd).toContain('if (a.name) {\n    const name = normalizeMessagingName(a.name)')
  })

  it('records advisories via the shared pure function after a successful spawn', () => {
    expect(cmd).toContain('for (const advisory of spawnAdvisoriesFor(gateCtx)) {')
    expect(cmd).toContain(
      "recordDiagnostic({ level: 'warn', code: 'spawn.advisory', message: advisory, paneId })"
    )
    // Must run after the pane exists (paneId assigned) so the diagnostic can
    // reference it, and before the command returns so useUiActionBus's
    // takeDiagnosticsSince window (opened before invokeCommand) still covers it.
    const paneIdIdx = cmd.indexOf('if (!paneId) throw new Error(`ui.pane.create failed to spawn')
    const advisoryIdx = cmd.indexOf('for (const advisory of spawnAdvisoriesFor(gateCtx))')
    expect(paneIdIdx).toBeGreaterThan(-1)
    expect(advisoryIdx).toBeGreaterThan(paneIdIdx)
  })

  it('imports spawnAdvisoriesFor alongside the rest of the gate', () => {
    const importBlock = block("import {\n  evaluateTurnSpawns,", "} from './lib/agentSpawnGate'")
    expect(importBlock).toContain('spawnAdvisoriesFor')
  })
})

describe('cli_open_agent advisories forwarding (agent_spawn.result)', () => {
  const handler = block(
    'async function handleMcpSpawnRequest(ev: {',
    '\nfunction describeSpawnRefusal('
  )

  it('report() carries an optional advisories list', () => {
    expect(handler).toContain('advisories?: string[]')
  })

  it('only attaches the advisories key to the outgoing payload when non-empty', () => {
    expect(handler).toContain(
      'if (verdict.advisories && verdict.advisories.length > 0) payload.advisories = verdict.advisories'
    )
  })

  it('passes gate.advisories through on both success paths (standalone and parented)', () => {
    const matches = [...handler.matchAll(/report\(\{ ok: true, paneId, name: childName(, advisories: gate\.advisories)?/g)]
    expect(matches.length).toBe(2)
    for (const m of matches) {
      expect(m[1]).toBe(', advisories: gate.advisories')
    }
  })
})
