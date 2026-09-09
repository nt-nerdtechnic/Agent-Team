// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The ↻ and history buttons sit on every workspace heading but were answered
// from currentWorkspace, so they acted on the workspace on screen whichever
// heading you clicked. ControlPane now names the workspace; these pin what
// App does with it.
//
// Both act in place now. Rebuild reads each pane's own workspacePath; history
// keeps its own read-only copy of the named workspace's entries and names that
// workspace on every write. The write side is pinned in
// App.historyWorkspace.test.ts — that is where the data-loss risk lives.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

/** A top-level declaration's text, up to the next one. */
function body(name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = appSource.indexOf(pat)
    if (at < 0) continue
    const rest = appSource.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =|\n\/\*\*/.exec(rest)
    return appSource.slice(at, at + pat.length + (next ? next.index : 4000))
  }
  throw new Error(`${name} not found`)
}

describe('a workspace heading acts on its own workspace', () => {
  it('rebuild takes the workspace as an argument', () => {
    expect(appSource).toContain(
      "async function rebuildPanesViaResume(scope: 'tab' | 'all', workspacePath?: string)",
    )
  })

  it('rebuild picks that workspace\'s panes, and panesInView only without one', () => {
    const fn = body('rebuildPanesViaResume')
    expect(fn).toContain('const pool = workspacePath')
    expect(fn).toContain('panes.value.filter((p) => normWs(p.workspacePath) === normWs(workspacePath))')
    // The toolbar and the tab strip still mean the workspace on screen.
    expect(fn).toContain(': panesInView.value')
    expect(fn).toContain('const ids = pool')
  })

  it('passes the heading\'s workspace through from the sidebar', () => {
    expect(appSource).toContain("@rebuild-all=\"rebuildPanesViaResume('all', $event)\"")
    // The tab strip's own rebuild stays scoped to the active tab, unchanged.
    expect(appSource).toContain("@rebuild-all=\"rebuildPanesViaResume('tab')\"")
  })

  it('enables each heading\'s button from its own workspace', () => {
    expect(appSource).toContain('const rebuildableByWorkspace = computed<Record<string, number>>')
    // Keyed by the normalised path, so ControlPane's lookup matches.
    expect(appSource).toContain('const key = normWs(p.workspacePath)')
    expect(appSource).toContain(':rebuildable-by-workspace="rebuildableByWorkspace"')
    // The on-screen count still drives the toolbar's copy of the button.
    expect(appSource).toContain(':can-rebuild-all="rebuildableAllPaneCount > 0"')
  })

  it('history opens the named workspace without switching to it', () => {
    const fn = body('onOpenWorkspaceHistory')
    expect(fn).not.toContain('switchToWorkspace')
    expect(fn).toContain('showHistory.value = true')
    expect(fn).toContain('normWs(workspacePath) !== normWs(currentWorkspace.value)')
    expect(appSource).toContain('@open-history="onOpenWorkspaceHistory"')
  })

  it('treats the workspace on screen as the ordinary case', () => {
    // Opening the viewed workspace's own history must not build a foreign
    // copy of what spawnHistory already holds, live.
    const fn = body('onOpenWorkspaceHistory')
    expect(fn).toContain("? workspacePath : ''")
    // Opening runs a refresh, and that is where the branch lives: the foreign
    // copy is built only when the modal is showing another project.
    expect(fn).toContain('await onRefreshHistory()')
    expect(body('onRefreshHistory')).toContain('if (historyIsForeign.value) {')
  })
})
