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

  it('never lists this window own panes twice', () => {
    // The roster does not distinguish this window from any other, so both the
    // current workspace and any pane already rendered here must be filtered.
    const start = appSource.indexOf('const workspaceGroups = computed')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n})', start))
    // Every workspace this window runs panes in, not just its primary — it can
    // have adopted others from the picker.
    expect(body).toContain('seenLocal.has(norm(path))')
    expect(body).toContain('localIds.has(entry.pane_id)')
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

  it('shows the folder a workspace sits in, not the workspace itself', () => {
    // The heading already renders the last segment as the name; repeating it
    // in the path costs a row's width and tells you nothing.
    const start = appSource.indexOf('function workspaceParentPath')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('lastIndexOf')
    expect(body).toContain('collapseHomePath')
    // Both rows must go through it — a raw collapseHomePath would show the
    // full path again.
    const gStart = appSource.indexOf('const workspaceGroups = computed')
    const groups = appSource.slice(gStart, appSource.indexOf('\n})', gStart))
    // Every row source must go through it, however many there are — a raw
    // collapseHomePath anywhere would put the full path back on that row.
    const uses = new Set(groups.match(/displayPath: \w+/g) ?? [])
    expect(uses).toEqual(new Set(['displayPath: workspaceParentPath']))
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
    expect(pred).toContain('extraWorkspaces.value.some')
    expect(appSource).toContain('sessionStorage.setItem(EXTRA_WS_KEY')
  })

  it('groups panes by the workspace each was started in', () => {
    // A pane records its own workspacePath, so a second workspace's panes must
    // land under its heading rather than swelling the primary's count.
    const gStart = appSource.indexOf('const workspaceGroups = computed')
    const groups = appSource.slice(gStart, appSource.indexOf('\n})', gStart))
    expect(groups).toContain('p.workspacePath')
    expect(groups).toContain('lineageFor(path)')
    // The count is that group's panes, not every pane in the window.
    expect(groups).not.toContain('count: panes.value.length')
  })

  it('reuses the Welcome picker rather than a second copy of it', () => {
    // Browse / New / Home, the recent list, pinning, the already-open badge —
    // a rebuilt picker would drift from all of it.
    expect(appSource).toContain('v-else-if="workspacePickerOpen"')
    expect(appSource).toContain('@select="openWorkspaceFromPicker"')
    // Startup keeps its own non-dismissible instance.
    expect(appSource).toContain('v-if="!workspaceSelected"')
  })

  it('lists a window that is open but has no agent yet', () => {
    // The roster only knows workspaces with a REGISTERED PANE. Without main's
    // window registry, a workspace opened from the picker is absent from the
    // sidebar until its first CLI starts — which reads as "it did not open".
    expect(appSource).toContain('listOpenWorkspaces')
    const gStart = appSource.indexOf('const workspaceGroups = computed')
    const groups = appSource.slice(gStart, appSource.indexOf('\n})', gStart))
    expect(groups).toContain('openWorkspacePaths.value')
    expect(groups).toContain('count: 0')
    // …and never twice: a workspace with panes is already in the list.
    expect(groups).toContain('listed.has(norm(path))')
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

  it('brings an adopted workspace\'s agents back with it', () => {
    // Agents are persisted per workspace. Adopting one without restoring them
    // shows a project with work in it as empty.
    const start = appSource.indexOf('async function openWorkspaceFromPicker')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain("'project.peek'")
    expect(body).toContain('restoreWorkspacePanes')
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
    const start = appSource.indexOf('const panesInView = computed')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n})', start))
    expect(body).toContain('extraWorkspaces.value.map(normWs)')
    // A pane whose workspace is in neither list — a manual resume can pull one
    // in from any folder — must stay visible as it always did.
    expect(body).toContain('if (!held.size) return panes.value')
  })

  it('counts a tab over the same panes the tab will show', () => {
    // stageTabShapes built its counts from every pane in the window. After a
    // switch, the other workspace's ungrouped panes landed in this one's
    // manual-tab count while the grid filter — correctly — refused to show
    // them: a tab reading "3" with nothing behind it.
    const start = appSource.indexOf('const stageTabShapes = computed')
    const shapes = appSource.slice(start, appSource.indexOf('\n  const shapes', start))
    expect(shapes).toContain('for (const p of panesInView.value)')
    expect(shapes).not.toContain('for (const p of panes.value)')
    // And the grid filter reads the same source rather than rebuilding it.
    const gStart = appSource.indexOf('const tabFilteredPaneIds = computed')
    const grid = appSource.slice(gStart, appSource.indexOf('\n})', gStart))
    expect(grid).toContain('const here = panesInView.value')
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

  it('picking a workspace it already holds just looks at it', () => {
    // Nothing happened before: adopt refused it and no switch was attempted.
    const start = appSource.indexOf('async function openWorkspaceFromPicker')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('await switchToWorkspace(path)')
  })

  it('switching keeps the workspace it leaves', () => {
    const start = appSource.indexOf('async function switchToWorkspace')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    // The two swap places in the adopted list rather than one being dropped.
    expect(body).toContain('extraWorkspaces.value = [')
    expect(body).toContain('leaving')
    // Everything that follows currentWorkspace moves with it, which is what
    // onWorkspaceBrowse already does — no second implementation.
    expect(body).toContain('onWorkspaceBrowse(path)')
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
    expect(appSource).toContain('if (extraWorkspaces.value.length) {')
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
    expect(around).toContain('if (extraWorkspaces.value.length) {')
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
