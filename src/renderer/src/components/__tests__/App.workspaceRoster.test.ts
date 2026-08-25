// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text.
//
// The workspace layer of the sidebar rests entirely on one backend contract:
// agent_msg.list returns EVERY registered pane when no workspace_path is
// given, and only the matching ones when it is. Passing the current workspace
// there would still return a valid answer, so the feature would degrade to a
// single section with no error anywhere — exactly the kind of silent failure
// a test has to catch.

const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

describe('cross-workspace roster', () => {
  it('asks for every workspace, not just this one', () => {
    const at = appSource.indexOf("'agent_msg.list'")
    expect(at).toBeGreaterThan(-1)
    // The payload is the argument right after the message type.
    const call = appSource.slice(at, at + 120)
    expect(call).not.toContain('workspace_path')
  })

  it('refreshes when a pane registers or unregisters', () => {
    for (const fn of ['function mirrorMessagingHandle', 'function unregisterPaneMessaging']) {
      const start = appSource.indexOf(fn)
      expect(start, fn).toBeGreaterThan(-1)
      const body = appSource.slice(start, appSource.indexOf('\n}', start))
      expect(body, fn).toContain('refreshWorkspaceRoster')
    }
  })

  it('refreshes on window focus and cleans the listener up', () => {
    expect(appSource).toContain("window.addEventListener('focus', refreshWorkspaceRoster)")
    expect(appSource).toContain("window.removeEventListener('focus', refreshWorkspaceRoster)")
  })

  it('does not poll', () => {
    // A timer here would run against a list nobody is looking at most of the
    // time; every refresh is event-driven instead.
    const start = appSource.indexOf('async function refreshWorkspaceRoster')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).not.toContain('setInterval')
    expect(appSource).not.toContain('setInterval(refreshWorkspaceRoster')
  })

  it('a detached window does not build a roster of its own', () => {
    const start = appSource.indexOf('async function refreshWorkspaceRoster')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('isDetachedWindow')
  })

  it('feeds the grouping builder every input it needs', () => {
    // The grouping itself moved to lib/workspaceGroups and is tested by
    // running it — App.vue cannot be mounted, so it could only ever be
    // grepped from here. What remains App's job is passing the right things
    // in: a missing input silently drops a whole band of the sidebar.
    const start = appSource.indexOf('const workspaceGroups = computed')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n)', start))
    expect(body).toContain('buildWorkspaceGroups({')
    for (const input of [
      'here: currentWorkspace.value',
      'order: workspaceOrder.value',
      'panes: panes.value',
      'lineage: paneLineage.value',
      'roster: crossWorkspaceRoster.value',
      'openPaths: openWorkspacePaths.value',
      'collapsed: collapsedWorkspaces.value',
      'homeDir: homeDir.value',
    ]) {
      expect(body, input).toContain(input)
    }
  })

  it('hands a cross-workspace add to the window that owns it', () => {
    // Spawning from here would apply THIS window's agent and role selection to
    // a project it has never opened. The owning window is asked instead.
    const start = appSource.indexOf('async function addAgentInWorkspace')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('requestSpawnInWorkspace')
    expect(body).not.toContain('onManualSpawn')
  })

  it('opens its own spawn card when another window asks', () => {
    expect(appSource).toContain('onSpawnRequested')
    expect(appSource).toContain('spawnCardNonce.value++')
    // Registered once and disposed — the listener outlives a reload otherwise.
    expect(appSource).toContain('_disposeSpawnRequested')
  })

  it('adds a picked workspace to THIS sidebar, not a new window', () => {
    const start = appSource.indexOf('async function openWorkspaceFromPicker')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('adoptWorkspace')
    expect(body).not.toContain('openMainWindow')
    // One already open elsewhere is still focused there: its panes live in the
    // window that owns them, and two windows on one folder would run two sets
    // of PTY and git operations on it.
    expect(body).toContain('focusWorkspaceWindow')
    // And it never repoints this window at it.
    expect(body).not.toContain('currentWorkspace.value =')
  })

  it('keeps adopted workspaces deduped and remembered', () => {
    const start = appSource.indexOf('function adoptWorkspace')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    // Never the primary, never twice — both come from the one predicate.
    expect(body).toContain('isLocalWorkspace(path)')
    expect(body).toContain('persistExtraWorkspaces')
    const pStart = appSource.indexOf('function isLocalWorkspace')
    const pred = appSource.slice(pStart, appSource.indexOf('\n}', pStart))
    expect(pred).toContain('normWs(currentWorkspace.value)')
    expect(pred).toContain('workspaceOrder.value.some')
    expect(appSource).toContain('sessionStorage.setItem(EXTRA_WS_KEY')
  })

  it('reuses the Welcome picker rather than a second copy of it', () => {
    // Browse / New / Home, the recent list, pinning, the already-open badge —
    // a rebuilt picker would drift from all of it.
    expect(appSource).toContain('v-else-if="workspacePickerOpen"')
    expect(appSource).toContain('@select="openWorkspaceFromPicker"')
    // Startup keeps its own non-dismissible instance.
    expect(appSource).toContain('v-if="!workspaceSelected"')
  })

  it('refreshes that list when a window opens or closes', () => {
    expect(appSource).toContain('onOpenWorkspacesChanged')
    expect(appSource).toContain('disposeOpenWorkspacesChanged')
  })

  it('the titlebar no longer duplicates what the sidebar carries', () => {
    // Path, reveal-in-Finder and the workspace switcher all used to sit up
    // there; the sidebar's Workspace section is where they live now.
    expect(appSource).not.toContain('titlebarRevealWorkspace')
    expect(appSource).not.toContain('titlebar-workspace')
  })

  it('opens a picked workspace by actually going to it', () => {
    // A list headed "Open Workspace" that adds a sidebar row and leaves the
    // window on the previous project reads as nothing having happened. The
    // switch also loads it, which is what brings its persisted agents back —
    // a project with work in it must not come up empty.
    const start = appSource.indexOf('async function openWorkspaceFromPicker')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('adoptWorkspace(path)')
    expect(body).toContain('await switchToWorkspace(path)')
    // The restore rides on the switch rather than being done twice.
    expect(body).not.toContain('restoreWorkspacePanes')
  })

  it('lets restore run for any workspace this window holds', () => {
    // restoreWorkspacePanes and its helpers guarded on currentWorkspace, which
    // an adopted workspace is not — every one of those became isLocalWorkspace.
    const start = appSource.indexOf('async function restoreWorkspacePanes')
    const body = appSource.slice(start, appSource.indexOf('\nasync function restoreSessionDecision', start))
    expect(body).not.toContain('currentWorkspace.value !== workspacePath')
    expect(body).toContain('isLocalWorkspace(workspacePath)')
  })

  it('leaves no restore path comparing against currentWorkspace', () => {
    // The one-workspace-per-window assumption was spelled four different ways
    // — workspacePath, session.workspacePath, deferred.workspacePath,
    // batch.workspacePath — so the first sweep missed some and a restored
    // placeholder in an adopted workspace silently would not start. Anything
    // still comparing a *.workspacePath against currentWorkspace inside the
    // restore/realize functions is a missed one.
    const region = appSource.slice(
      appSource.indexOf('async function restoreWorkspacePanes'),
      appSource.indexOf('const paneLineage = computed')
    )
    expect(region.length).toBeGreaterThan(0)
    const leaks = region.match(/currentWorkspace\.value [!=]==? \w*\.?workspacePath/g) ?? []
    expect(leaks).toEqual([])
  })

  it('shows one workspace in the grid at a time', () => {
    // Switching is a change of view: the workspaces left behind keep running
    // and keep their sidebar headings, they are just not on screen.
    // The filter itself is lib/paneVisibility, tested by running it. Here:
    // App must hand it the OTHER workspaces, not the viewed one.
    const start = appSource.indexOf('const panesInView = computed')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n)', start))
    expect(body).toContain('panesOfViewedWorkspace(panes.value, extraWorkspaces.value)')
  })

  it('counts a tab over the same panes the tab will show', () => {
    // stageTabShapes built its counts from every pane in the window. After a
    // switch, the other workspace's ungrouped panes landed in this one's
    // manual-tab count while the grid filter — correctly — refused to show
    // them: a tab reading "3" with nothing behind it.
    // The strip's shape is lib/stageTabs, tested by running it. What App must
    // do is feed it the workspace-filtered panes — the bug was a count taken
    // over every pane in the window while the stage filtered by workspace.
    const start = appSource.indexOf('const stageTabShapes = computed')
    const shapes = appSource.slice(start, appSource.indexOf('\n)', start))
    expect(shapes).toContain('panes: panesInView.value')
    expect(shapes).not.toContain('panes: panes.value')
    // And the grid filter narrows the same source rather than rebuilding it.
    const gStart = appSource.indexOf('const tabFilteredPaneIds = computed')
    const grid = appSource.slice(gStart, appSource.indexOf('\n)', gStart))
    expect(grid).toContain('panesOfActiveTab(panesInView.value')
  })

  it('keeps the sweeping actions inside the workspace on screen', () => {
    // Rebuild-all and kill-all hang off one workspace's heading. Reaching into
    // another project's agents from there is a surprise at best, and kill is
    // unrecoverable. Unchanged whenever the window holds a single workspace.
    for (const anchor of ['const rebuildableAllPaneCount', 'async function onKillAll']) {
      const start = appSource.indexOf(anchor)
      expect(start, anchor).toBeGreaterThan(-1)
      const body = appSource.slice(start, appSource.indexOf('\n}', start))
      expect(body, anchor).toContain('panesInView.value')
      expect(body, anchor).not.toContain('panes.value')
    }
    const start = appSource.indexOf('async function rebuildPanesViaResume')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('const ids = panesInView.value')
  })

  it('stops offering the all keyword once here is ambiguous', () => {
    // sendBroadcast reaches every pane the WINDOW registers, and `all` is
    // documented as workspace-local. Rather than teach the messaging registry
    // about workspaces, the menu stops offering the keyword — typing it by
    // hand still broadcasts window-wide, which the comment says out loud.
    const start = appSource.indexOf('function mentionCandidatesFor')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('extraWorkspaces.value.length === 0')
  })

  it('names the workspace being viewed in the titlebar', () => {
    // With several workspaces in one window, switching changed everything
    // below the titlebar and nothing in it. document.title already carried the
    // name for Mission Control; the bar itself said nothing.
    expect(appSource).toContain('class="titlebar-name titlebar-name--ws"')
    expect(appSource).toContain('{{ workspaceBaseName }}')
    // Sized to its text, centred by the spacers either side.
    expect(appSource).toContain('.titlebar-name--ws {')
    const at = appSource.indexOf('.titlebar-name--ws {')
    expect(appSource.slice(at, at + 120)).toContain('flex: 0 1 auto')
  })

  it('asks before a switch stops a running pipeline', () => {
    // Panes survive a switch; a pipeline cannot — `pipeline` is one per window,
    // so entering another project overwrites the state tracking this one's run
    // and onWorkspaceBrowse aborts it. Right call, but everything else about a
    // switch keeps running, so nobody would expect this one thing to stop.
    const start = appSource.indexOf('async function switchToWorkspace')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain("pipeline.state === 'running'")
    expect(body).toContain('notifyRestore.confirm')
    // Declining leaves the window where it is.
    expect(body).toContain('if (!ok) return')
    // The abort itself still lives in onWorkspaceBrowse — no second copy.
    expect(body).not.toContain('onPipelineAbort')
  })

  it('never tears down panes while entering a workspace', () => {
    // The third leg of "switch away and back, the agents are still there".
    // The other two are v-show on TerminalPane (asserted above) and restore
    // skipping any pane_id already in the list. This one is the easiest to
    // break by accident: a tidy-up added to either function would end the CLIs
    // of every workspace not being entered, and nothing else would complain.
    const REMOVAL = /panes\.value\s*=|panes\.value\.splice|panes\.value\.filter|unregisterPaneMessaging|onKill\(|delete paneRefs/
    // Up to the next top-level declaration — anchoring on a named one further
    // down would sweep in whatever sits between.
    const bodyOf = (fn: string): string => {
      const start = appSource.indexOf(fn)
      expect(start, fn).toBeGreaterThan(-1)
      const after = start + fn.length
      const ends = ['\nasync function ', '\nfunction ', '\nconst ']
        .map((m) => appSource.indexOf(m, after))
        .filter((i) => i > -1)
      expect(ends.length, `${fn} end`).toBeGreaterThan(0)
      return appSource.slice(start, Math.min(...ends))
    }
    for (const fn of ['async function restoreWorkspacePanes', 'async function onWorkspaceCheck']) {
      expect(REMOVAL.test(bodyOf(fn)), fn).toBe(false)
    }
  })

  it('skips a pane the list already holds rather than spawning it twice', () => {
    // Switching back re-runs restore for a workspace whose panes never left.
    const start = appSource.indexOf('async function restoreWorkspacePanes')
    const body = appSource.slice(start, appSource.indexOf('\nasync function restoreSessionDecision', start))
    expect(body).toContain('const existing = panes.value.find((p) => p.id === saved.pane_id)')
    expect(body).toContain('if (existing) continue')
  })

  it('says so when a switch does not take', () => {
    // onWorkspaceBrowse declines by returning — chiefly on finding the
    // workspace open in another window — which from the caller is
    // indistinguishable from having worked. A switch that quietly does nothing
    // leaves the sidebar saying one thing and the screen another.
    const start = appSource.indexOf('async function switchToWorkspace')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('normWs(currentWorkspace.value) !== normWs(path)')
    expect(body).toContain("switchWorkspace.failed")
    // Nothing to undo: the list is the same either way, which is the point of
    // keeping order out of "which one is on screen".
    expect(body).not.toContain('extraWorkspaces.value =')
  })

  it('falls back to a pane the screen can actually render', () => {
    // Sidebar and spotlight render effectiveFocusPaneId and nothing else, and
    // onScreenPaneIds checks it against the workspace-filtered list. Answering
    // with a pane from another workspace renders nothing at all — a blank
    // main area with a full agent list beside it.
    // The fallback itself is lib/paneFocus, tested by running it. App's job is
    // handing it the workspace on screen rather than every pane in the window.
    const start = appSource.indexOf('const effectiveFocusPaneId = computed')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n)', start))
    expect(body).toContain('panesInView.value')
    expect(body).not.toContain('panes.value')
  })

  it('never tears down the panes of the workspace it leaves', () => {
    // onWorkspaceBrowse resets the pipeline, and onPipelineReset is
    // `await onKillAll()` — browsing has always meant LEAVING, so a clean
    // slate was right. Switching is not leaving: the sidebar goes on listing
    // that workspace and its agents go on running. Without keepPanes the
    // switch destroyed exactly the work it was meant to leave running.
    const start = appSource.indexOf('async function switchToWorkspace')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('onWorkspaceBrowse(path, { keepPanes: true })')

    const bStart = appSource.indexOf('async function onWorkspaceBrowse')
    const browse = appSource.slice(bStart, appSource.indexOf('\n}', bStart))
    expect(browse).toContain('if (!opts?.keepPanes) await onPipelineReset()')
    // The pipeline still stops either way — one per window.
    expect(browse).toContain("if (pipeline.state === 'running') await onPipelineAbort()")

    // And the teardown really is in there, so this is not guarding a no-op.
    const rStart = appSource.indexOf('async function onPipelineReset')
    expect(appSource.slice(rStart, appSource.indexOf('\n}', rStart))).toContain('await onKillAll()')
  })

  it('has no unguarded teardown anywhere on the browse path', () => {
    // The previous test names the one call that tears panes down. This one
    // says there is no second: onWorkspaceBrowse is shared with the Welcome
    // picker, where a clean slate IS wanted, so anything destructive added
    // here later would reach the switch too — and a switch destroying the
    // workspace it leaves is exactly the bug that made this necessary.
    const bStart = appSource.indexOf('async function onWorkspaceBrowse')
    const browse = appSource.slice(bStart, appSource.indexOf('\n}', bStart))
    const destructive = browse.match(/onKillAll\(\)|onPipelineReset\(\)|onKill\(/g) ?? []
    expect(destructive).toEqual(['onPipelineReset()'])
    expect(browse).toContain('if (!opts?.keepPanes) await onPipelineReset()')
    // The rest of the path is clean, which is why nothing else is guarded.
    for (const fn of ['async function onPipelineAbort', 'function cancelAllWatchers']) {
      const start = appSource.indexOf(fn)
      expect(start, fn).toBeGreaterThan(-1)
      const body = appSource.slice(start, appSource.indexOf('\n}', start))
      expect(/onKillAll|onKill\(/.test(body), fn).toBe(false)
    }
  })

  it('does not check the same workspace twice for one switch', () => {
    // ControlPane reaches onWorkspaceCheck through a 400ms debounce, and a
    // switch calls it directly so the window does not spend those 400ms
    // pairing the new workspace with the old run groups. Both fire for one
    // switch, and the second bumps workspaceCheckSeq — which is exactly the
    // condition the first one's restore bails on. It gave up midway and the
    // workspace came up with none of its panes.
    const start = appSource.indexOf('async function onWorkspaceCheck')
    const body = appSource.slice(start, appSource.indexOf('\n  const seq =', start))
    expect(body).toContain('lastWorkspaceCheck.path')
    expect(body).toContain('WORKSPACE_RECHECK_MS')
    // The bail condition it protects is still there — this is not guarding a
    // mechanism that has since gone away.
    const full = appSource.slice(start, appSource.indexOf('\nasync function', start + 20))
    expect(full).toContain('seq !== workspaceCheckSeq')
  })

  it('files pane order under the workspace whose panes they are', () => {
    // `panes` holds every workspace the window runs. Sending all of them files
    // another project's pane ids under this one, and leaves that project's own
    // order unwritten — nothing else writes it.
    const start = appSource.indexOf('async function persistPaneOrder')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('panesInView.value.map((p) => p.id)')
    expect(body).not.toContain('panes.value.map((p) => p.id)')
  })

  it('scopes the all keyword to the sender\'s own workspace', () => {
    // The menu stops offering the keyword once a window holds more than one
    // workspace, but the bare-line protocol is typed by the agent and cannot
    // be gated that way. sendBroadcast reaches every pane the WINDOW
    // registers, so the scope is applied at the call site, which knows the
    // sender's workspace — the registry only knows names and agents.
    const at = appSource.indexOf('messaging.sendBroadcast(')
    expect(at).toBeGreaterThan(-1)
    const call = appSource.slice(at - 400, at + 500)
    expect(call).toContain('only: (targetPaneId)')
    expect(call).toContain('normWs(to) === normWs(from)')
    // A pane in neither list — a manual resume can pull a session in from any
    // folder — stays a recipient, as it always was.
    expect(call).toContain('return !to || ')
  })

  it('picking a workspace it already holds just looks at it', () => {
    // Nothing happened before: adopt refused it and no switch was attempted.
    const start = appSource.indexOf('async function openWorkspaceFromPicker')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('await switchToWorkspace(path)')
  })

  it('switching moves the view, not the list', () => {
    const start = appSource.indexOf('async function switchToWorkspace')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    // The window holds the same set either way. Deriving order from "which is
    // on screen" reshuffled the sidebar on every switch — two rows swapping
    // places under the cursor, so the next click lands on the wrong project.
    // The doc comment sits above the declaration, so read from it.
    const order = appSource.slice(
      appSource.indexOf('Every workspace this window holds'),
      appSource.indexOf('const extraWorkspaces = computed'),
    )
    expect(order).toContain('the order it took them on')
    expect(order).toContain('const workspaceOrder = ref')
    // The one being left is already in the list — the workspace a window opens
    // with joins it at the front, so it never sorts below something adopted
    // later.
    expect(appSource).toContain('workspaceOrder.value = [ws, ...workspaceOrder.value]')
    expect(body).not.toContain('workspaceOrder.value = [')
    // Everything that follows currentWorkspace moves with it, which is what
    // onWorkspaceBrowse already does — no second implementation. keepPanes is
    // asserted on its own below.
    expect(body).toContain('onWorkspaceBrowse(path, { keepPanes: true })')
    // Never for a workspace this window does not hold.
    expect(body).toContain('isLocalWorkspace(path)')
  })

  it('does not leave the focus on a pane it just hid', () => {
    // Grid mode would cope, but sidebar and spotlight render the focused pane
    // and nothing else — they would come up blank.
    const start = appSource.indexOf('async function switchToWorkspace')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('tabVisiblePanes.value')
    expect(body).toContain('selectPane(first')
  })

  it('keeps hidden panes alive rather than tearing them down', () => {
    // v-show, not v-if: switching away must not destroy the terminal or end
    // the CLI. This is what makes "keeps running, just not shown" true.
    const at = appSource.indexOf('<TerminalPane')
    const tag = appSource.slice(at, at + 200)
    expect(tag).toContain('v-show="onScreenPaneIds.has(p.id)"')
    expect(tag).not.toContain('v-if="onScreenPaneIds')
  })

  it('tells main which workspaces this window has taken on', () => {
    // Main answers "is this folder already open?" for every other window's
    // picker. Knowing only primaries, a second window could open a folder this
    // one is already running — two sets of PTY and git operations on one
    // checkout, which is the thing the whole design avoids.
    const start = appSource.indexOf('function persistExtraWorkspaces')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('reportAdoptedWorkspaces')
    // A reload restores the list from sessionStorage without going through
    // adoptWorkspace, so it has to be re-reported on mount.
    expect(appSource).toContain('if (workspaceOrder.value.length) {')
  })

  it('answers an external spawn for any workspace it holds', () => {
    // cli_open_agent with a workspace_path is addressed by workspace, not by a
    // parent pane. Only the window holding it may answer — and now exactly one
    // does, because findMainWindowForWorkspace covers adopted ones.
    const start = appSource.indexOf('async function handleMcpSpawnRequest')
    const body = appSource.slice(start, appSource.indexOf('\n  const report', start))
    expect(body).toContain('isLocalWorkspace(ev.target_workspace')
    expect(body).not.toContain('ev.target_workspace !== currentWorkspace.value')
  })

  it('takes back its adopted workspaces after a relaunch', () => {
    // sessionStorage wins when both exist: it is this window's live state,
    // while the registry's copy is from before the restart.
    expect(appSource).toContain('takeRestoredAdoptedWorkspaces')
    const at = appSource.indexOf('takeRestoredAdoptedWorkspaces')
    const around = appSource.slice(at - 700, at + 500)
    expect(around).toContain('if (workspaceOrder.value.length) {')
    // And their agents come back, the same way a picked workspace's do.
    expect(around).toContain("'project.peek'")
    expect(around).toContain('restoreWorkspacePanes')
  })

  it('still ties the history pane to the primary workspace', () => {
    // Deliberately NOT widened: spawn history follows the workspace the window
    // was opened with.
    const start = appSource.indexOf('function hydrateSpawnHistory')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('currentWorkspace.value !== workspacePath')
  })

  it('closing an adopted workspace takes its panes with it', () => {
    const start = appSource.indexOf('async function closeWorkspace')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    // Panes started in it would otherwise sit in the list with no heading.
    expect(body).toContain('onKill')
    expect(body).toContain('persistExtraWorkspaces')
    // The primary is what the window was opened with — closing it leaves no root.
    expect(body).toContain('normWs(currentWorkspace.value)')
  })

  it('focuses the owning window rather than switching this one', () => {
    const start = appSource.indexOf('async function revealWorkspace')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('focusWorkspaceWindow')
    // Switching would put two windows' PTY and git operations on one checkout.
    expect(body).not.toContain('currentWorkspace.value =')
  })
})
