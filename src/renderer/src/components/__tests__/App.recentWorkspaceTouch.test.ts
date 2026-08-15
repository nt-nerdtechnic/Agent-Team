// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. They lock in the
// recent-workspaces gap: only Welcome's click handler and File > Open Recent
// used to call workspace.touch, so folders opened from outside the app (Finder
// "Open With", the macOS Quick Action, CLI path args) never appeared in Recent.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

describe('recent-workspace recording', () => {
  it('records a workspace booted from a URL param once the backend connects', () => {
    const start = appSource.indexOf('const touchBootWorkspace = ')
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(block).toContain("backend.status.value !== 'connected'")
    expect(block).toContain('touchRecentWorkspace(_bootWorkspace)')
  })

  it('re-runs the boot touch on the connected transition', () => {
    const start = appSource.indexOf('const touchBootWorkspace = ')
    const block = appSource.slice(start, appSource.indexOf('// Feed the native', start))
    expect(block).toContain('watch(() => backend.status.value, touchBootWorkspace)')
  })

  it('touches the picked workspace from the Open Workspace… menu action', () => {
    const start = appSource.indexOf("if (action === 'open-workspace') {")
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(
      start,
      appSource.indexOf("if (action.startsWith('open-recent:'))", start)
    )
    expect(block).toContain('touchRecentWorkspace(picked)')
  })
})
