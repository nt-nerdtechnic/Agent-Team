// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend, terminal, settings, and onboarding lifecycles;
// keep these checks narrow source-text assertions like the other App tests.
// The cycling logic itself is behaviourally covered in lib/__tests__/paneCycle
// and the dispatch chain in keybindings/__tests__/paneCycleBindings — what is
// left to pin here is the wiring between them.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

const cycleFn = appSource.slice(
  appSource.indexOf('function cycleFocusedPane'),
  appSource.indexOf('function cycleFocusedPane') + 1400
)

describe('App pane cycling wiring', () => {
  it('registers both cycling commands', () => {
    expect(appSource).toContain("registerCommand('workbench.action.focusNextPane'")
    expect(appSource).toContain("registerCommand('workbench.action.focusPreviousPane'")
    expect(appSource).toContain('cycleFocusedPane(1)')
    expect(appSource).toContain('cycleFocusedPane(-1)')
  })

  it('feeds the planner the tab-visible order and the effective focus', () => {
    expect(cycleFn).toContain('orderedIds: tabVisiblePanes.value.map((p) => p.id)')
    expect(cycleFn).toContain('currentId: effectiveFocusPaneId.value')
  })

  it('only passes grid dimensions in grid layout', () => {
    expect(cycleFn).toContain(
      "gridDims: effectiveLayoutMode.value === 'grid' ? gridPresetDims(gridPreset.value) : null"
    )
    expect(cycleFn).toContain('currentPage: gridPage.value')
  })

  it('turns the page only when the planner asks for one', () => {
    expect(cycleFn).toContain('if (plan.page !== null) onUserChangeGridPage(plan.page)')
  })

  it('focuses through selectPane so restored panes are realized', () => {
    expect(cycleFn).toContain(
      'selectPane(plan.targetId, { userInitiated: true, scrollIntoView: true })'
    )
  })

  it('bails out on a no-op plan', () => {
    expect(cycleFn).toContain('if (!plan) return')
  })

  it('marks the window as the pane-stage owner for the keybinding guard', () => {
    expect(appSource).toContain("setContext('paneStage', true)")
  })

  it('hands DOM focus over when the target is still a restore placeholder', () => {
    // A placeholder has no TerminalPane ref, so the focusPaneId watcher cannot
    // focus it — without this the outgoing terminal keeps every keystroke.
    expect(cycleFn).toContain("panes.value.find((p) => p.id === plan.targetId)?.realized")
    expect(cycleFn).toContain('.blur?.()')
    expect(cycleFn).toContain('void realizeRestoredPane(plan.targetId).then(')
    expect(cycleFn).toContain('paneRefs[plan.targetId]?.focus?.()')
  })
})
