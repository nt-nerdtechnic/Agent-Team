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
    expect(body('workspaceGroups', '\n})')).toContain('const localPaths = [...workspaceOrder.value')
  })

  it('renders and focuses from the same filtered list', () => {
    // A focused pane the render set excludes shows an empty main area beside a
    // full agent list.
    for (const name of ['effectiveFocusPaneId', 'tabFilteredPaneIds']) {
      expect(body(name, '\n})'), name).toContain('panesInView.value')
    }
  })

  it('goes to a pane\'s workspace before focusing it', () => {
    // The sidebar lists every workspace the window holds, so a click can land
    // on a pane the grid is filtering out. Focusing one the screen will not
    // draw is the blank-main-area bug again, reached by clicking rather than
    // by switching.
    const fn = body('onSidebarFocusPane')
    expect(fn).toContain('isLocalWorkspace(target)')
    expect(fn).toContain('await switchToWorkspace(target)')
    // A declined switch must not fall through to the focus.
    expect(fn.indexOf('if (normWs(currentWorkspace.value) !== normWs(target)) return'))
      .toBeLessThan(fn.indexOf('onFocusPane(paneId)'))
    // Modifier clicks are range/toggle selection and skip all of this.
    expect(fn.indexOf('onSetFocus(paneId, ev, sidebarOrderedPaneIds.value)'))
      .toBeLessThan(fn.indexOf('await switchToWorkspace(target)'))
  })

  it('shows a picked workspace instead of only listing it', () => {
    const pick = body('openWorkspaceFromPicker')
    expect(pick).toContain('adoptWorkspace(path)')
    expect(pick).toContain('switchToWorkspace(path)')
    // The restore rides on the switch; a second one here would race it.
    expect(pick).not.toContain('restoreWorkspacePanes')
  })
})
