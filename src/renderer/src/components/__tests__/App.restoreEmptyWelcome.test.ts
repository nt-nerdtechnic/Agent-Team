// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A restore that produces no panes must land on Welcome, not on an empty
// sidebar reading "No agents running." — which is indistinguishable from a
// broken app. Source-scanned, like the other App.*.test.ts files: App.vue is
// far too large to mount, and what matters here is that the guards stay wired
// to each other.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

/** The empty-restore block inside onWorkspaceCheck. */
function emptyRestoreBlock(): string {
  const at = appSource.indexOf('if (restoreEmptyCheckPending) {')
  expect(at).toBeGreaterThan(-1)
  return appSource.slice(at, at + 700)
}

describe('restore that yields nothing falls back to Welcome', () => {
  it('reads the restore flag main already sets on the window', () => {
    // index.ts opens snapshot-restored windows with `restore: '1'`; without
    // reading it the renderer cannot tell "restored into an empty workspace"
    // from "user opened an empty workspace", and only the first should eject.
    expect(appSource).toContain("get('restore') === '1'")
    expect(appSource).toContain('const _bootIsRestore =')
    expect(appSource).toContain('let restoreEmptyCheckPending = _bootIsRestore')
  })

  it('ejects only when no pane at all came back', () => {
    const block = emptyRestoreBlock()
    expect(block).toContain('panes.value.length === 0')
    expect(block).toContain('workspaceSelected.value = false')
  })

  it('clears the boot session keys so a reload does not re-enter the empty workspace', () => {
    // The boot wrote both when it took the workspace_path param. Leaving them
    // set sends the next reload straight past the picker, back into the same
    // empty workspace.
    const block = emptyRestoreBlock()
    expect(block).toContain('removeItem(WS_SELECTED_KEY)')
    expect(block).toContain('removeItem(WS_PATH_KEY)')
  })

  it('runs at most once per window', () => {
    // Closing your last pane later is the user's own doing and must not eject
    // them, so the flag is spent before the emptiness is even examined.
    const block = emptyRestoreBlock()
    const spent = block.indexOf('restoreEmptyCheckPending = false')
    const examined = block.indexOf('panes.value.length === 0')
    expect(spent).toBeGreaterThan(-1)
    expect(spent).toBeLessThan(examined)
  })

  it('sits after the empty-active-tab fallback, which handles the lesser case', () => {
    // That block switches to a tab that has panes; this one covers what it
    // cannot rescue — no tab has any. Running before it would eject windows
    // that the tab fallback would have fixed.
    const tabFallback = appSource.indexOf('const firstFull = stageTabs.value.find(')
    const eject = appSource.indexOf('if (restoreEmptyCheckPending) {')
    expect(tabFallback).toBeGreaterThan(-1)
    expect(eject).toBeGreaterThan(tabFallback)
  })
})
