// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

describe('llmNameRequested is released with the rest of the pane state', () => {
  // The guard that stops a pane being auto-named twice is keyed by pane id and
  // had no removal path: onKill dropped seven other per-pane structures and
  // left this one to accumulate for the lifetime of the window.

  it('onKill deletes the pane from the auto-name guard', () => {
    expect(functionBody('onKill')).toContain('llmNameRequested.delete(paneId)')
  })

  it('deletes it alongside the other per-pane maps, not somewhere unrelated', () => {
    const body = functionBody('onKill')
    const guard = body.indexOf('llmNameRequested.delete(paneId)')
    const msgProcessed = body.indexOf('paneMsgProcessedAt.delete(paneId)')
    const prepStage = body.indexOf('prepStageEnteredAt.delete(paneId)')
    expect(msgProcessed).toBeGreaterThan(-1)
    expect(prepStage).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(msgProcessed)
    expect(guard).toBeLessThan(prepStage)
  })

  it('still guards against a second request for the same pane', () => {
    // The delete only matters because the Set is what makes auto-naming
    // once-per-pane; assert the guard itself is intact.
    expect(appSource).toContain('if (llmNameRequested.has(paneId)) return')
    expect(appSource).toContain('llmNameRequested.add(paneId)')
  })
})
