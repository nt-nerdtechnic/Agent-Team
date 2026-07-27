// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend, terminal, settings, and onboarding lifecycles;
// keep these checks narrow source-text assertions like the other App tests.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

describe('App lazy cold restore', () => {
  it('materializes cold restores without probing or mounting a terminal', () => {
    const coldStart = appSource.indexOf('if (fullRestore) {')
    const eagerStart = appSource.indexOf('if (!fullRestore) {', coldStart)
    const coldSection = appSource.slice(coldStart, eagerStart)

    expect(coldSection).toContain('realized: false')
    expect(coldSection).toContain('deferredRestore:')
    expect(coldSection).toContain('autoName: saved.auto_name || undefined')
    expect(coldSection).not.toContain('await canResumeSession(')
    expect(appSource).toContain('<TerminalPane\n          v-if="p.realized"')
    expect(appSource).toContain('<RestoredPanePlaceholder\n          v-else')
  })

  it('realizes only selections explicitly marked as user initiated', () => {
    const selectAt = appSource.indexOf('function selectPane(')
    const selectEnd = appSource.indexOf('\nconst previewLogContent', selectAt)
    const select = appSource.slice(selectAt, selectEnd)

    expect(select).toContain('options.userInitiated')
    expect(select).toContain('void realizeRestoredPane(paneId)')
    expect(appSource).toContain('@activate="selectPane(p.id, { userInitiated: true })"')
    expect(appSource).toContain('@focus-pane="onFocusPane"')
    expect(appSource).toContain('selectPane(visible[0]?.id ?? null, { userInitiated: false })')
  })

  it('a user-selected tab focuses its prior pane without realizing it', () => {
    const tabAt = appSource.indexOf('async function onUserSelectTab')
    const tabEnd = appSource.indexOf('// Persist activeTab', tabAt)
    const tabSelect = appSource.slice(tabAt, tabEnd)

    expect(tabSelect).toContain('const visible = tabVisiblePanes.value')
    expect(tabSelect).toContain('visible.find((p) => p.id === focusPaneId.value)?.id ?? visible[0]?.id')
    expect(tabSelect).toContain('selectPane(target, { userInitiated: false })')
    expect(tabSelect).not.toContain('realizeRestoredPane(')
    expect(appSource).toContain('@update:model-value="onUserSelectTab"')
  })

  it('uses one on-screen pane set for rendering without automatic activation', () => {
    const helperAt = appSource.indexOf('const onScreenPaneIds = computed')
    const helperEnd = appSource.indexOf('\nconst dualFocusHandlePos', helperAt)
    const helper = appSource.slice(helperAt, helperEnd)

    expect(helper).toContain("effectiveLayoutMode.value === 'grid'")
    expect(helper).toContain('gridPagePaneIds.value')
    expect(helper).toContain("effectiveLayoutMode.value === 'sidebar'")
    expect(helper).toContain("effectiveLayoutMode.value === 'spotlight'")
    expect(helper).not.toContain('realizeRestoredPane(')
    expect(appSource).not.toContain('function realizeOnScreenPanes()')
    expect(appSource).not.toContain('watch([effectiveLayoutMode, gridPreset, gridPage]')
    expect(appSource).not.toContain('watch(onScreenPaneIds')
    expect(appSource).toContain('v-show="onScreenPaneIds.has(p.id)"')
  })

  it('keeps the realized replacement restoring until its first output', () => {
    const realizeAt = appSource.indexOf('async function realizeRestoredPane')
    const realizeEnd = appSource.indexOf('\nasync function onRefreshAnalyzer', realizeAt)
    const realize = appSource.slice(realizeAt, realizeEnd)

    expect(realize).toContain('placeholder.restoring = true')
    expect(realize).toContain('restoring: true')
    expect(appSource).toContain(':restoring="p.restoring"')
    expect(appSource).toContain('@first-output="onPaneFirstOutput(p.id)"')
  })

  it('shares an in-flight realization and reports unavailable restored pipeline sessions accurately', () => {
    const realizeAt = appSource.indexOf('async function realizeRestoredPane')
    const performAt = appSource.indexOf('async function performRealizeRestoredPane', realizeAt)
    const realize = appSource.slice(realizeAt, performAt)
    const resumeAt = appSource.indexOf('async function onPipelineResume')
    const resumeEnd = appSource.indexOf('// Orders every project.set_ui_state', resumeAt)
    const resume = appSource.slice(resumeAt, resumeEnd)

    expect(realize).toContain('restoringPanePromises.get(paneId)')
    expect(realize).toContain('if (pending) return pending')
    expect(resume).toContain('await Promise.all(pendingPipeline.map((id) => realizeRestoredPane(id)))')
    expect(resume).toContain('const unresolvedPipeline = panes.value.filter')
    expect(resume).toContain("await onPipelineAbort('restore-unavailable')")
    expect(resume.indexOf("await onPipelineAbort('restore-unavailable')")).toBeLessThan(
      resume.indexOf('await activateStage(info.nextStageIndex)')
    )
  })

  it('keeps lazy realization aligned with eager restore session and naming metadata', () => {
    const helperAt = appSource.indexOf('async function spawnRestoredPane')
    const helperEnd = appSource.indexOf('\ninterface SessionExistsPayload', helperAt)
    const helper = appSource.slice(helperAt, helperEnd)
    const eagerAt = appSource.indexOf('if (!fullRestore) {')
    const eagerEnd = appSource.indexOf('// Backfill removed manual panes', eagerAt)
    const eager = appSource.slice(eagerAt, eagerEnd)
    const realizeAt = appSource.indexOf('async function performRealizeRestoredPane')
    const realizeEnd = appSource.indexOf('\nasync function onRefreshAnalyzer', realizeAt)
    const realize = appSource.slice(realizeAt, realizeEnd)

    expect(helper).toContain('await spawnPane({')
    expect(helper).toContain('autoName: saved.auto_name || undefined')
    expect(helper).toContain('preferredMessagingName: persistedMessagingName(saved.pane_id)')
    expect(helper).toContain('sessionKnownOnDisk: opts.sessionKnownOnDisk')
    expect(helper).toContain('dropPersistedMessagingName(saved.pane_id)')
    expect(helper).toContain("'pipeline.slot_spawn'")
    expect(helper).toContain("'manual_pane.spawn'")
    expect(eager).toContain('await spawnRestoredPane({')
    expect(realize).toContain('await spawnRestoredPane({')
    expect(realize).toContain('forceFresh ? { timeoutMs: 2500 } : undefined')
    expect(realize).toContain('const attemptResume = !forceFresh && shouldAttemptResume(canResume)')
  })

  it('keeps ungrouped manual panes in the Manual tab and realizes restored grid panes without changing focus', () => {
    const restoreAt = appSource.indexOf('async function restoreWorkspacePanes')
    const realizeAt = appSource.indexOf('async function realizeRestoredPane', restoreAt)
    const restore = appSource.slice(restoreAt, realizeAt)
    const restorePaneAt = appSource.indexOf('function restorePane(')
    const restorePaneEnd = appSource.indexOf('/** Drag-reorder', restorePaneAt)
    const restorePane = appSource.slice(restorePaneAt, restorePaneEnd)

    expect(restore).toContain("saved.origin === 'pipeline' ? ensureRestoreGroup() : ''")
    expect(restorePane).toContain("if (layoutMode.value !== 'grid') selectPane(id, { userInitiated: true })")
    expect(restorePane).toContain('else void realizeRestoredPane(id)')
  })

  it('keeps cold hydration free of session probes and terminal realization', () => {
    const workspaceAt = appSource.indexOf('async function onWorkspaceCheck')
    const workspaceEnd = appSource.indexOf('\n  }\n}\n\n// Fire the deferred workspace', workspaceAt)
    const workspace = appSource.slice(workspaceAt, workspaceEnd)

    // onWorkspaceCheck also runs on a pipeline abort and a WS reconnect, so the
    // cold-load focus seed must never overwrite a focus the user already set.
    expect(workspace).toContain(
      'if (!focusPaneId.value || !tabVisiblePanes.value.some((p) => p.id === focusPaneId.value)) {'
    )
    expect(workspace).toContain('focusPaneId.value = tabVisiblePanes.value[0]?.id ?? null')
    expect(workspace).not.toContain('canResumeSession(')
    expect(workspace).not.toContain('realizeRestoredPane(')
    expect(appSource).not.toContain('hydratingColdRestore')
    expect(appSource).not.toContain('focus_pane_id: id ?? \'\'')
  })

  it('transfers the current minimized state instead of stale saved metadata', () => {
    const realizeAt = appSource.indexOf('async function performRealizeRestoredPane')
    const realizeEnd = appSource.indexOf('\nasync function onRefreshAnalyzer', realizeAt)
    const realize = appSource.slice(realizeAt, realizeEnd)

    expect(realize).toContain('const wasMinimized = minimizedPanes.value.has(paneId)')
    expect(realize).toContain('if (wasMinimized) minimized.add(newId)')
    expect(realize).not.toContain('wasMinimized || saved.is_minimized')
  })

  it('preserves an unknown saved pointer when Start fresh launches a new CLI', () => {
    // Slice from the options interface, not the function: preserveSessionPointer
    // is declared above spawnRestoredPane.
    const helperAt = appSource.indexOf('interface RestoredPaneSpawnOptions {')
    const helperEnd = appSource.indexOf('\ninterface SessionExistsPayload', helperAt)
    const helper = appSource.slice(helperAt, helperEnd)
    const realizeAt = appSource.indexOf('async function performRealizeRestoredPane')
    const realizeEnd = appSource.indexOf('\nasync function onRefreshAnalyzer', realizeAt)
    const realize = appSource.slice(realizeAt, realizeEnd)

    expect(helper).toContain('preserveSessionPointer?: boolean')
    expect(helper).toContain('opts.isResume || opts.preserveSessionPointer')
    expect(helper).toContain('!opts.preserveSessionPointer')
    expect(realize).toContain('preserveSessionPointer: forceFresh && canResume !== false')
  })

  it('locks pane and session identities before the first async decision', () => {
    const realizeAt = appSource.indexOf('async function realizeRestoredPane')
    const realizeEnd = appSource.indexOf('\nasync function onRefreshAnalyzer', realizeAt)
    const realize = appSource.slice(realizeAt, realizeEnd)
    const lockAt = realize.indexOf('for (const key of lockKeys) rebuildingPanes.add(key)')
    const firstAwait = realize.indexOf('await coldRestoreDecision(batch)')

    expect(lockAt).toBeGreaterThan(-1)
    expect(firstAwait).toBeGreaterThan(lockAt)
    expect(realize).toContain('finally {')
    expect(realize).toContain('for (const key of lockKeys) rebuildingPanes.delete(key)')
  })

  it('rejects stale workspace restores before materializing placeholders', () => {
    const restoreAt = appSource.indexOf('async function restoreWorkspacePanes')
    const unifiedListAt = appSource.indexOf('// Build unified pane list.', restoreAt)
    const restoreGuard = appSource.slice(restoreAt, unifiedListAt)

    expect(restoreGuard).toContain('isStale?.()')
    expect(restoreGuard).toContain('currentWorkspace.value !== workspacePath')
  })

  it('never realizes a placeholder added to a batch selection', () => {
    const focusAt = appSource.indexOf('function onSetFocus(')
    const focusEnd = appSource.indexOf('// Pane right-click context menu', focusAt)
    const setFocus = appSource.slice(focusAt, focusEnd)
    const batchBranch = setFocus.slice(0, setFocus.indexOf('selectedPaneIds.value = new Set()'))

    expect(batchBranch).toContain('selectPane(paneId, { userInitiated: false })')
    expect(batchBranch).not.toContain('selectPane(paneId, { userInitiated: true })')
    // The plain (non-modifier) click below it still opens the pane.
    expect(setFocus).toContain('selectPane(paneId, { userInitiated: true })')
  })

  it('stops the pipeline before any kickoff when a slot is still a placeholder', () => {
    const stageAt = appSource.indexOf('async function activateStage(')
    const stageEnd = appSource.indexOf('\nasync function waitForStagePanesSettled', stageAt)
    const stage = appSource.slice(stageAt, stageEnd)

    const abortAt = stage.indexOf("await onPipelineAbort('restore-unavailable')")
    const trackerAt = stage.indexOf('stageCompletions.set(index,')
    const parallelAt = stage.indexOf('await Promise.all(stage.slots.map(')

    expect(stage).toContain('const unrealizedSlot = stage.slots.find(')
    expect(abortAt).toBeGreaterThan(-1)
    // Aborting from inside the parallel slot loop would race the siblings that
    // are already injecting their kickoff — the check must precede both the
    // completion tracker and the loop.
    expect(abortAt).toBeLessThan(trackerAt)
    expect(abortAt).toBeLessThan(parallelAt)
    // The loop itself no longer needs an unrealized branch.
    expect(stage.slice(parallelAt)).not.toContain('!pane.realized')
  })

  it('reports one reconnect per realization rather than a running total', () => {
    const realizeAt = appSource.indexOf('async function performRealizeRestoredPane')
    const realizeEnd = appSource.indexOf('\nasync function onRefreshAnalyzer', realizeAt)
    const realize = appSource.slice(realizeAt, realizeEnd)

    expect(realize).toContain("i18n.global.t('reconnect.auto-toast', { count: 1 })")
    expect(realize).not.toContain('auto-toast\', { count: reconnectedCount.value }')
  })

  it('labels an unrealized pane by its resume state, not a preparation status', () => {
    const labelAt = appSource.indexOf('function panePreparationLabel(')
    const labelEnd = appSource.indexOf('function paneWaitingForSessionId(', labelAt)
    const label = appSource.slice(labelAt, labelEnd)

    expect(label).toContain('if (!p.realized) {')
    expect(label).toContain("p.restoring ? 'pane.terminal.resuming' : 'pane.terminal.click-to-resume'")
    expect(label.indexOf('if (!p.realized) {')).toBeLessThan(label.indexOf('paneWaitingForSessionId(p)'))
  })

  it('uses persisted stage identity when closing a pipeline placeholder', () => {
    const killAt = appSource.indexOf('async function onKill(')
    const killEnd = appSource.indexOf('/** Recover a render-corrupted pane', killAt)
    const kill = appSource.slice(killAt, killEnd)

    expect(kill).toContain('pane.deferredRestore?.saved.stage_index')
    expect(kill).toContain("typeof savedStageIndex === 'number' && savedStageIndex >= 0")
    expect(kill).toContain("'pipeline.slot_unspawn'")
    expect(kill).toContain('stage_index: stageIndex')
  })
})
