// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The status bar's branch pill is workspace-scoped — it asks git.status for
// currentWorkspace — but nothing told it to ask again when that changed.
//
// Its only triggers were a watch on workspaceSelected, a 5s poll, and the
// window becoming visible. Switching between two workspaces one window holds
// never flips workspaceSelected, so the pill kept showing the branch of the
// workspace being left until the poll caught up. Wrong is worse than absent
// here: a branch name beside a project you just switched to reads as that
// project's branch.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

describe('the branch pill follows the workspace', () => {
  it('refetches when the workspace on screen changes', () => {
    const at = appSource.indexOf('watch(currentWorkspace, () => {\n  statusBarGit.value')
    expect(at).toBeGreaterThan(-1)
    expect(appSource.slice(at, at + 240)).toContain('void refreshStatusBarGit()')
  })

  it('clears before it refetches, rather than showing the old branch', () => {
    // The refetch is a round trip. Leaving the previous branch up for its
    // duration is the exact failure this fixes, just shorter — and the pill
    // hides itself when the branch is empty, so absent costs nothing.
    const at = appSource.indexOf('watch(currentWorkspace, () => {\n  statusBarGit.value')
    const body = appSource.slice(at, at + 240)
    expect(body.indexOf("branch: ''")).toBeLessThan(body.indexOf('void refreshStatusBarGit()'))
  })

  it('still asks about the workspace on screen', () => {
    // The fetch was always workspace-scoped; only its triggers were wrong.
    const at = appSource.indexOf('async function refreshStatusBarGit')
    expect(at).toBeGreaterThan(-1)
    const fn = appSource.slice(at, appSource.indexOf('\n}', at))
    expect(fn).toContain("'git.status', { workspace_path: currentWorkspace.value }")
  })

  it('offers to open the folder beside the path', () => {
    // Rides with the path, not the name: it acts on the folder, and the folder
    // is what is on screen while hovering. A button on a bar showing a project
    // name would read as acting on the project.
    expect(appSource).toContain('class="titlebar-reveal"')
    expect(appSource).toContain('@click="revealWorkspaceFolder(currentWorkspace)"')
    const at = appSource.indexOf('.titlebar-reveal {')
    expect(at).toBeGreaterThan(-1)
    expect(appSource.slice(at, at + 120)).toContain('display: none')
    expect(appSource).toContain('.titlebar-id:hover .titlebar-reveal { display: block; }')
  })

  it('opens the real path, not the shortened one', () => {
    // The bar shows ~/… — handing that to the OS would open a folder named
    // "~" if anything at all.
    expect(appSource).toContain('@click="revealWorkspaceFolder(currentWorkspace)"')
    expect(appSource).not.toContain('revealWorkspaceFolder(workspaceDisplayPath)')
  })

  it('hides the pill rather than rendering an empty branch', () => {
    expect(appSource).toContain('<span v-if="statusBarGit.branch" class="sb-item sb-git">')
  })
})
