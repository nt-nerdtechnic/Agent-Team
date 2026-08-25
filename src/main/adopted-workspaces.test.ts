// A window's sidebar can take on workspaces beyond the one it was opened with.
// Main tracks those separately from the primary, because "already open
// somewhere" has to cover them: two windows on one folder run two sets of PTY
// and git operations on it, which is the thing the design exists to prevent.
//
// Source-scanned — the real thing needs live BrowserWindows.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

/** The body of a top-level `function name(...)` in main. */
function body(name: string): string {
  const at = mainSource.indexOf(`function ${name}(`)
  expect(at, `${name} not found`).toBeGreaterThan(-1)
  return mainSource.slice(at, mainSource.indexOf('\n}', at))
}

describe('adopted workspaces', () => {
  it('are tracked apart from the window primary', () => {
    // Everything that means "this window's own workspace" — the registry, the
    // run-group hand-off, the titlebar — must keep meaning exactly that.
    expect(mainSource).toContain('const adoptedWorkspaces = new Map<BrowserWindow, string[]>()')
    expect(body('broadcastToWorkspace')).not.toContain('adoptedWorkspaces')
  })

  it('count as open when another window asks', () => {
    const find = body('findMainWindowForWorkspace')
    expect(find).toContain('adoptedWorkspaces')
    // The window whose primary it is wins: that is where its tabs, git and
    // explorer already point.
    expect(find.indexOf('mainWindowWorkspaces')).toBeLessThan(find.indexOf('adoptedWorkspaces'))
  })

  it("show up in Welcome's open badges", () => {
    const at = mainSource.indexOf("ipcMain.handle('workspace:listOpen'")
    expect(at).toBeGreaterThan(-1)
    const handler = mainSource.slice(at, mainSource.indexOf('\n})', at))
    expect(handler).toContain('adoptedWorkspaces')
  })

  it('are reported by the renderer and dropped with the window', () => {
    const at = mainSource.indexOf("ipcMain.on('window:reportAdoptedWorkspaces'")
    expect(at).toBeGreaterThan(-1)
    const handler = mainSource.slice(at, mainSource.indexOf('\n})', at))
    // Same two guards the workspace report has: only real main windows.
    expect(handler).toContain('mainWindows.has(win)')
    expect(handler).toContain('detachedWindowIds.has(win.id)')
    // An empty list clears the entry rather than storing [].
    expect(handler).toContain('adoptedWorkspaces.delete(win)')
    // Other windows' pickers need to hear about it.
    expect(handler).toContain('broadcastOpenWorkspacesChanged()')
    // And the map must not outlive the window: cleared alongside the primary.
    const teardown = mainSource.indexOf('mainWindows.delete(win)')
    expect(teardown).toBeGreaterThan(-1)
    expect(mainSource.slice(teardown, teardown + 300)).toContain('adoptedWorkspaces.delete(win)')
  })
})
