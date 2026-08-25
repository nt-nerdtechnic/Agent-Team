// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Restore sessions once shared a single variable, which was fine while a window
// held one workspace and wrong the moment it could hold several: realizing any
// pane reassigns the session to that pane's workspace, so two workspaces
// restoring at once cancelled each other. Nothing failed loudly — the losing
// workspace's panes simply stayed placeholders.
//
// The scope lists had the mirror-image fault: they came from the workspace on
// screen while the pending list came from the session's, so the two described
// different workspaces.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

/** A top-level function's text, up to the next declaration. */
function body(name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = appSource.indexOf(pat)
    if (at < 0) continue
    const rest = appSource.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =|\n\/\*\*/.exec(rest)
    return appSource.slice(at, at + pat.length + (next ? next.index : 3000))
  }
  throw new Error(`${name} not found`)
}

describe('a restore session per workspace', () => {
  it('keys sessions by workspace instead of holding one', () => {
    expect(appSource).toContain('const restoreSessions = new Map<string, RestoreSession>()')
    // The single variable is what two workspaces stole from each other.
    expect(appSource).not.toContain('activeRestoreSession')
  })

  it('reuses a workspace session rather than replacing it', () => {
    // Its settings snapshot and its answer to the restore prompt are fixed for
    // as long as the workspace is open here; rebuilding it re-asks.
    const fn = body('workspaceRestoreSession')
    expect(fn).toContain('const existing = restoreSessions.get(workspacePath)')
    expect(fn).toContain('if (existing) return existing')
  })

  it('drops only sessions for workspaces the window no longer holds', () => {
    // Dropping every session but the current one is precisely the bug: the
    // other workspace is still held, still restoring, and still needs its own.
    expect(appSource).toContain('if (key !== path && !isLocalWorkspace(key)) restoreSessions.delete(key)')
  })

  it('checks the map entry, not a single global, before continuing', () => {
    const fn = body('advanceRestoreSession')
    expect(fn).toContain('restoreSessions.get(session.workspacePath) !== session')
  })

  it('advances the workspace on screen when a UI event triggers it', () => {
    // A tab change, a Grid page turn and a layout change all describe what is
    // being looked at, so they must not reach a background workspace's session.
    const fn = body('advanceRestoreSession')
    expect(fn).toContain("const path = coldBatch?.workspacePath ?? currentWorkspace.value")
    expect(fn).toContain('const session = restoreSessions.get(path)')
  })
})

describe('scope targets belong to one workspace', () => {
  it('offers the visible lists only for the workspace on screen', () => {
    // 'single', 'page' and 'tab' intersect the pending list with a visible one.
    // Fed another workspace's visible panes, that intersection is empty and the
    // restore silently does nothing.
    const fn = body('restoreSessionScopeTargets')
    expect(fn).toContain(
      'const onScreen = normWs(session.workspacePath) === normWs(currentWorkspace.value)'
    )
    expect(fn).toContain('activeTabPaneIds: onScreen ? tabVisiblePanes.value.map((pane) => pane.id) : []')
    expect(fn).toContain('gridPagePaneIds: onScreen ? gridPagePanes.value.map((pane) => pane.id) : []')
  })

  it('does not offer a focused pane from a different workspace', () => {
    // 'single' prefers the focused pane; the focus belongs to the workspace on
    // screen, so for any other one it must not be considered.
    expect(body('restoreSessionScopeTargets')).toContain('focusedPaneId: onScreen ? focusPaneId.value : null')
  })

  it('still scopes the pending list by the session workspace', () => {
    // This half was always right; the fix must not lose it.
    expect(body('restoreSessionScopeTargets')).toContain(
      'pendingPaneIds: pendingRestorePaneIds(panes.value, session.workspacePath)'
    )
  })
})
