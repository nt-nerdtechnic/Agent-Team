// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. They guard the
// wiring only; flushSettingsOnExit's own behaviour is unit-tested in
// packages/plugin-ui/src/shared/lib/settings.exitFlush.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

describe('queued settings survive an exit', () => {
  it('flushes from the quit sequence, while the backend is still up', () => {
    // A quit stops the backend before app.quit() lets the window unload, so
    // beforeunload alone would send the batch into a closed socket. 'saving' is
    // the last stage that still has somewhere to send it.
    const start = appSource.indexOf('onQuitProgress')
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(start, start + 600)
    expect(block).toContain("if (stage === 'saving') flushSettingsOnExit()")
  })

  it('flushes on the teardowns that are not a quit', () => {
    expect(appSource).toContain("window.addEventListener('beforeunload', flushSettingsOnExit)")
    expect(appSource).toContain("window.removeEventListener('beforeunload', flushSettingsOnExit)")
  })

  it('imports the flush from the settings module rather than reimplementing it', () => {
    expect(appSource).toContain('flushSettingsOnExit')
    expect(appSource).toMatch(/import \{[^}]*flushSettingsOnExit[^}]*\} from '@navide\/plugin-ui\/shared'/)
  })
})
