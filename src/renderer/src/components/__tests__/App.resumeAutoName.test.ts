// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. They lock in the
// resume title fix: a pane's displayed name is customName → autoName →
// slotLabel → agentLabel, and most panes are titled by autoName (derived from
// the kickoff prompt or broadcast by the backend). The cold-restore paths all
// carried saved.auto_name, but onManualResume dropped it, so resuming from
// Agent History gave the pane back its bare vendor label.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  // Every one of these is followed by another top-level declaration, so the
  // next line-start `}` closes it.
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('resume keeps the pane title', () => {
  it('onManualResume accepts an autoName and forwards it to spawnPane', () => {
    const body = functionBody('onManualResume')
    expect(body).toContain('autoName?: string')
    expect(body).toContain('autoName: payload.autoName')
  })

  it('onManualResume persists the auto-name, before the custom rename', () => {
    const body = functionBody('onManualResume')
    const autoNameCall = body.indexOf("'project.set_pane_auto_name'")
    const renameCall = body.indexOf("'project.rename_pane'")
    expect(autoNameCall).toBeGreaterThan(-1)
    expect(renameCall).toBeGreaterThan(-1)
    // set_pane_auto_name is set-once in the backend and refuses a record that
    // already carries a custom name, so the order here is load-bearing.
    expect(autoNameCall).toBeLessThan(renameCall)
  })

  it('resuming from Agent History carries the entry auto-name', () => {
    const body = functionBody('onResumeHistoryAgent')
    expect(body).toContain('customName: entry.customName')
    expect(body).toContain('autoName: entry.autoName')
  })

  it('every onManualResume caller that has a pane name passes both name layers', () => {
    const marker = 'onManualResume({'
    const offsets: number[] = []
    for (let i = appSource.indexOf(marker); i !== -1; i = appSource.indexOf(marker, i + 1)) {
      offsets.push(i)
    }
    expect(offsets.length).toBeGreaterThan(0)
    for (const offset of offsets) {
      const payload = appSource.slice(offset, appSource.indexOf('})', offset))
      if (!payload.includes('customName:')) continue
      expect(payload).toContain('autoName:')
    }
  })
})
