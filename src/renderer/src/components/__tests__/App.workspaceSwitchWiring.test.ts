// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The interactions between the switch's parts, not each part on its own.
//
// Every fix in this feature introduced the next problem: scoping onKillAll to
// the workspace on screen aimed it at the one being left; calling
// onWorkspaceCheck immediately — to stop the window pairing a new workspace
// with old run groups — made ControlPane's debounced call abort the restore
// the first one had started. Neither was visible in the changed function; both
// were visible in how two of them ran together.
//
// Source-scanned, like the other App.*.test.ts files.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

/** A top-level declaration's text, up to the next one. */
function body(name: string, endMarker?: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`, `const ${name} = computed`]) {
    const at = appSource.indexOf(pat)
    if (at < 0) continue
    if (endMarker) return appSource.slice(at, appSource.indexOf(endMarker, at))
    const rest = appSource.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =/.exec(rest)
    return appSource.slice(at, at + pat.length + (next ? next.index : 3000))
  }
  throw new Error(`${name} not found`)
}

describe('workspace switch — how the parts fit together', () => {
  it('picks the focus only after restore has put the panes back', () => {
    const sw = body('switchToWorkspace')
    expect(sw.indexOf('await onWorkspaceCheck(path)')).toBeGreaterThan(-1)
    expect(sw.indexOf('await onWorkspaceCheck(path)')).toBeLessThan(sw.indexOf('tabVisiblePanes.value'))
  })

  it('drops the second check of one switch', () => {
    // ControlPane debounces its call by 400ms; the switch calls directly. Both
    // fire, and the second bumps the sequence the first one's restore bails on.
    const guard = body('onWorkspaceCheck', '\n  const seq =')
    expect(guard).toContain('lastWorkspaceCheck.path')
    expect(guard).toContain('WORKSPACE_RECHECK_MS')
    // Still guarding a live mechanism.
    expect(appSource).toContain('seq !== workspaceCheckSeq')
  })

  it('keeps panes on a switch while leaving the teardown for Welcome', () => {
    expect(body('switchToWorkspace')).toContain('onWorkspaceBrowse(path, { keepPanes: true })')
    expect(body('onWorkspaceBrowse')).toContain('if (!opts?.keepPanes) await onPipelineReset()')
  })

  it('orders the sidebar independently of what is on screen', () => {
    // The ordering rule lives in lib/workspaceGroups now and is tested there
    // by running it. What this file guards is that App hands the builder the
    // stable list rather than something derived from currentWorkspace.
    const g = body('workspaceGroups', '\n)')
    expect(g).toContain('order: workspaceOrder.value')
    expect(g).not.toContain('currentWorkspace.value, ...')
  })

  it('renders and focuses from the same filtered list', () => {
    // A focused pane the render set excludes shows an empty main area beside a
    // full agent list.
    for (const name of ['effectiveFocusPaneId', 'tabFilteredPaneIds']) {
      expect(body(name, '\n})'), name).toContain('panesInView.value')
    }
  })

  it('takes every jump-to-a-pane path through the same switch', () => {
    // Four ways to land on a pane: the sidebar list, the status-bar overview,
    // the history modal, and a message notification. Each can name one in a
    // workspace that is not on screen, and each would otherwise focus
    // something the grid filters out — the blank main area, four times over.
    // One helper, so a fifth entry point is easy to get right.
    const helper = body('ensurePaneWorkspaceOnScreen')
    expect(helper).toContain('isLocalWorkspace(target)')
    expect(helper).toContain('await switchToWorkspace(target)')
    expect(helper).toContain('return normWs(currentWorkspace.value) === normWs(target)')

    expect(body('onAgentOverviewJump')).toContain('onSidebarFocusPane(paneId)')
    for (const fn of ['onSidebarFocusPane', 'onFocusHistoryPane', 'focusPaneFromNotification']) {
      const b = body(fn)
      // Called, and its answer respected — an ignored false focuses a pane the
      // grid is still filtering out.
      expect(b, fn).toContain('if (!(await ensurePaneWorkspaceOnScreen(')
    }
  })

  it('leaves one-workspace behaviour exactly as it was', () => {
    // Nearly every commit on this feature claims it. The claim rests on
    // panesInView returning panes.value ITSELF when nothing is adopted — not a
    // copy, not an equivalent filter — so every derived read is a no-op. A
    // mixed read anywhere would differ even with a single workspace.
    // The identity return lives in lib/paneVisibility and is asserted there;
    // what App must not do is reach past it back to the full list.
    expect(body('panesInView', '\n)')).toContain(
      'panesOfViewedWorkspace(panes.value, extraWorkspaces.value)',
    )

    for (const [name, end] of [
      ['effectiveFocusPaneId', '\n)'],
      ['tabFilteredPaneIds', '\n)'],
      ['stageTabShapes', '\n)'],
      ['onKillAll', undefined],
      ['persistPaneOrder', undefined],
    ] as const) {
      const b = body(name, end)
      expect(b, name).toContain('panesInView.value')
      expect(b, name).not.toContain('panes.value')
    }

    // Opt-in flags: absent means the old path.
    expect(body('onWorkspaceBrowse')).toContain('if (!opts?.keepPanes) await onPipelineReset()')
  })

  it('keeps the structure layer off paneViews', () => {
    // syncViews rebuilds paneViews every 400ms from each pane's live status.
    // Anything structural that reads it is rebuilt on that timer too — the
    // sidebar's grouping, the lineage tree and the grid's filter would all
    // recompute four times a second for a status dot that ticked.
    //
    // The rule is easy to break by reaching for a field that happens to be on
    // the view object, and a comment cannot enforce it.
    // Most of these are now one-line calls into lib/, so their bodies end at
    // the call's closing paren rather than a computed's `})`.
    for (const [name, end] of [
      ['panesInView', '\n)'],
      ['workspaceGroups', '\n)'],
      ['paneLineage', '\n)'],
      ['tabFilteredPaneIds', '\n)'],
      ['stageTabShapes', '\n)'],
      ['sidebarOrderedPaneIds', '\n)'],
    ] as const) {
      expect(body(name, end), name).not.toContain('paneViews')
    }
  })

  it('shows a picked workspace instead of only listing it', () => {
    const pick = body('openWorkspaceFromPicker')
    expect(pick).toContain('adoptWorkspace(path)')
    expect(pick).toContain('switchToWorkspace(path)')
    // The restore rides on the switch; a second one here would race it.
    expect(pick).not.toContain('restoreWorkspacePanes')
  })
})
