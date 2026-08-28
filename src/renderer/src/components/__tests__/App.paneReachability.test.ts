// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Clicking a pane has to end with that pane on screen. Three filters sit
// between the click and the stage — the tab strip, the grid page, and the
// minimized set — and each one, on its own, turns the click into nothing
// visible: focus moves to a pane the stage never draws, so it looks like the
// click was ignored, or the focus resolver hands the screen to a different
// pane and it looks like somebody else opened.
//
// None of that raises an error, which is why the dead ends record a diagnostic
// now instead of returning in silence: an MCP client gets `ok: true` back from
// a jump that did nothing at all, and there is no renderer console to read.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

/** A function's text, from its declaration to the closing brace in column 0. */
function fn(name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = appSource.indexOf(pat)
    if (at < 0) continue
    return appSource.slice(at, appSource.indexOf('\n}', at) + 2)
  }
  throw new Error(`${name} not found`)
}

describe('a jump that cannot land says so', () => {
  it('records a diagnostic when the pane sits on no tab', () => {
    // buildStageTabs raises a tab for every group its panes name — including
    // one whose record is missing — so there is normally one to switch to.
    // Reaching the end means the pane cannot be opened by clicking it, which
    // used to pass in total silence.
    const reveal = fn('revealPaneTab')
    expect(reveal).toContain('recordDiagnostic({')
    expect(reveal).toContain("code: 'pane.noTab'")
    expect(reveal).toContain("level: 'warn'")
    // Attributed to the pane, or ui.diagnostics.read cannot filter for it.
    expect(reveal).toContain('paneId,')
  })

  it('reports on the fall-through, not on one of the guards', () => {
    // The early returns are ordinary — the pane is already on the visible tab,
    // or it is gone. Only the last path is the dead end, so the diagnostic has
    // to sit after every return in the function.
    const reveal = fn('revealPaneTab')
    expect(reveal.slice(reveal.lastIndexOf('return'))).toContain('recordDiagnostic')
  })

  it('records a diagnostic on both dead ends of a restore placeholder', () => {
    // Both leave a placeholder that can be clicked forever and never open: one
    // has no deferred restore to act on, the other needs a workspace this
    // window let go of (detach leaves the panes behind). The sidebar lists
    // them either way, so both are reachable by a click that does nothing.
    const realize = fn('performRealizeRestoredPane')
    const noDeferred = realize.slice(
      realize.indexOf('if (!deferred) {'),
      realize.indexOf('const saved = deferred.saved'),
    )
    expect(noDeferred).toContain('recordDiagnostic({')
    expect(noDeferred).toContain("code: 'restore.noDeferred'")
    expect(noDeferred).toContain('paneId,')
    // Reported before it gives up, not instead of giving up.
    expect(noDeferred.indexOf('recordDiagnostic({')).toBeLessThan(noDeferred.indexOf('return'))

    const foreign = realize.slice(
      realize.indexOf('if (!isLocalWorkspace(deferred.workspacePath)) {'),
      realize.indexOf('const session = workspaceRestoreSession('),
    )
    expect(foreign).toContain('recordDiagnostic({')
    expect(foreign).toContain("code: 'restore.foreignWorkspace'")
    expect(foreign).toContain('deferred.workspacePath')
    expect(foreign.indexOf('recordDiagnostic({')).toBeLessThan(foreign.indexOf('return'))
  })

  it('gives each dead end its own code', () => {
    // One shared code cannot tell the two apart, and they need different
    // repairs.
    for (const code of ['pane.noTab', 'restore.noDeferred', 'restore.foreignWorkspace']) {
      expect(appSource.split(`code: '${code}'`).length - 1, code).toBe(1)
    }
  })
})

describe('focusing a pane brings its grid page with it', () => {
  it('derives the page from the same list the stage pages', () => {
    // tabVisiblePanes is what gridPageSlice cuts into pages, so the index has
    // to come from it — an index into any other list names another pane's page.
    const grid = fn('revealPaneGridPage')
    expect(grid).toContain('tabVisiblePanes.value.findIndex((p) => p.id === paneId)')
    expect(grid).toContain('gridPageOf(index, gridPreset.value)')
    expect(appSource).toContain('  gridPageOf,\n')
  })

  it('does nothing outside the grid, or for a pane the list does not hold', () => {
    const grid = fn('revealPaneGridPage')
    expect(grid).toContain("if (effectiveLayoutMode.value !== 'grid') return")
    expect(grid).toContain('if (index < 0) return')
  })

  it('turns the page through the same handler the pager uses', () => {
    // And only when it actually changes: re-issuing the current page would
    // fight whatever the user just did.
    const grid = fn('revealPaneGridPage')
    expect(grid).toContain('if (page !== gridPage.value) onUserChangeGridPage(page)')
  })

  it('is called by onFocusPane, after the tab is switched', () => {
    // Every jump goes through onFocusPane, so this is the one place that makes
    // the page follow. The tab comes first: the page is an index into the tab's
    // own pane list, so computing it against the old tab names the wrong page.
    const focus = fn('onFocusPane')
    expect(focus).toContain('revealPaneTab(paneId)')
    expect(focus).toContain('revealPaneGridPage(paneId)')
    expect(focus.indexOf('revealPaneTab(paneId)')).toBeLessThan(
      focus.indexOf('revealPaneGridPage(paneId)'),
    )
  })
})

describe('every entry point restores a minimized pane before focusing it', () => {
  it('restores from the sidebar too, like history and the resource list', () => {
    // effectiveFocusPaneId skips a minimized pane, so setting focus on one
    // hands the screen to a different pane: the click appears to open somebody
    // else. Minimized state persists, so the sidebar's version of this came
    // back on every restart.
    const sidebar = fn('onSidebarFocusPane')
    expect(sidebar).toContain('if (minimizedPanes.value.has(paneId)) restorePane(paneId)')
    expect(sidebar.indexOf('restorePane(paneId)')).toBeLessThan(
      sidebar.indexOf('onFocusPane(paneId)'),
    )
  })

  it('leaves no jump path without the step', () => {
    // The three ways to click a pane out of a list. onResourceJump goes on
    // through onSidebarFocusPane, so it is covered twice — restorePane is
    // idempotent — but it is listed here so a fourth entry point is easy to
    // get right.
    for (const [name, id] of [
      ['onSidebarFocusPane', 'paneId'],
      ['onFocusHistoryPane', 'entry.paneId'],
      ['onResourceJump', 'paneId'],
    ] as const) {
      expect(fn(name), name).toContain(
        `if (minimizedPanes.value.has(${id})) restorePane(${id})`,
      )
    }
  })

  it('restores only after the workspace switch has been agreed', () => {
    // ensurePaneWorkspaceOnScreen can answer false — the pane's workspace is
    // not this window's to show. Un-minimizing a pane the jump then abandons
    // changes persisted state for a jump that never happened.
    const sidebar = fn('onSidebarFocusPane')
    expect(sidebar.indexOf('if (!(await ensurePaneWorkspaceOnScreen(paneId))) return')).toBeLessThan(
      sidebar.indexOf('if (minimizedPanes.value.has(paneId)) restorePane(paneId)'),
    )
  })
})
