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
    expect(body).toContain('path === here')
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
    expect(groups.match(/displayPath: workspaceParentPath\(/g)).toHaveLength(2)
    expect(groups).not.toContain('displayPath: collapseHomePath')
  })

  it('opens a picked workspace in its own window, never in this one', () => {
    // The sidebar lists workspaces side by side, so picking one is "also open
    // that", not "leave what I am doing" — and two windows on one folder would
    // run two sets of PTY and git operations on it.
    const start = appSource.indexOf('async function openWorkspaceFromPicker')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('focusWorkspaceWindow')
    expect(body).toContain('openMainWindow')
    expect(body).not.toContain('currentWorkspace.value =')
  })

  it('reuses the Welcome picker rather than a second copy of it', () => {
    // Browse / New / Home, the recent list, pinning, the already-open badge —
    // a rebuilt picker would drift from all of it.
    expect(appSource).toContain('v-else-if="workspacePickerOpen"')
    expect(appSource).toContain('@select="openWorkspaceFromPicker"')
    // Startup keeps its own non-dismissible instance.
    expect(appSource).toContain('v-if="!workspaceSelected"')
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
