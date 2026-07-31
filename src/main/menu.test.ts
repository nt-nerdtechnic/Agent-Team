import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

// Shared, hoisted capture of the template passed to Menu.buildFromTemplate.
const h = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[]
}))

vi.mock('electron', () => ({
  app: { name: 'Agent-Team' },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      h.template = template
      return {}
    },
    setApplicationMenu: () => {}
  }
}))

import { installApplicationMenu, type AppMenuHooks } from './menu'

const isMac = process.platform === 'darwin'

function submenuOf(label: string): MenuItemConstructorOptions[] {
  const top = h.template.find((i) => i.label === label)
  if (!top || !Array.isArray(top.submenu)) throw new Error(`no top-level submenu labeled "${label}"`)
  return top.submenu as MenuItemConstructorOptions[]
}

function itemIn(menu: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = menu.find((i) => i.label === label)
  if (!found) throw new Error(`no menu item labeled "${label}"`)
  return found
}

function fire(item: MenuItemConstructorOptions): void {
  ;(item.click as unknown as (() => void) | undefined)?.()
}

function makeHooks(): AppMenuHooks & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    onOpenSettings: () => calls.push('settings'),
    onCheckUpdates: () => calls.push('check-updates'),
    onOpenWorkspace: () => calls.push('open-workspace'),
    onOpenRecent: (p) => calls.push('open-recent:' + p),
    onNewWindow: () => calls.push('new-window'),
    onOpenPipelineManager: () => calls.push('pipeline-manager'),
    onOpenRepo: () => calls.push('open-repo'),
    onReportIssue: () => calls.push('report-issue'),
    onShowShortcuts: () => calls.push('show-shortcuts')
  }
}

describe('installApplicationMenu', () => {
  let hooks: ReturnType<typeof makeHooks>

  beforeEach(() => {
    hooks = makeHooks()
    installApplicationMenu(hooks)
  })

  it('app menu (macOS) / File menu (non-macOS) has Settings… with ⌘, and Check for Updates…', () => {
    const menu = isMac ? submenuOf('Agent-Team') : submenuOf('File')
    const settings = itemIn(menu, 'Settings…')
    expect(settings.accelerator).toBe('CmdOrCtrl+,')
    const updates = itemIn(menu, 'Check for Updates…')
    fire(settings)
    fire(updates)
    expect(hooks.calls).toEqual(['settings', 'check-updates'])
  })

  it('File has Open Workspace… with ⌘O that invokes its hook', () => {
    const open = itemIn(submenuOf('File'), 'Open Workspace…')
    expect(open.accelerator).toBe('CmdOrCtrl+O')
    fire(open)
    expect(hooks.calls).toEqual(['open-workspace'])
  })

  it('File has New Window with ⌘N that invokes its hook', () => {
    const nw = itemIn(submenuOf('File'), 'New Window')
    expect(nw.accelerator).toBe('CmdOrCtrl+N')
    fire(nw)
    expect(hooks.calls).toEqual(['new-window'])
  })

  it('File > Open Recent lists the recents; missing folders are disabled and clicking opens by path', () => {
    installApplicationMenu(hooks, [
      { path: '/a/one', name: 'one', exists: true },
      { path: '/b/two', name: 'two', exists: false }
    ])
    const openRecent = itemIn(submenuOf('File'), 'Open Recent')
    const sub = openRecent.submenu as MenuItemConstructorOptions[]
    expect(sub.map((i) => i.label)).toEqual(['one', 'two'])
    expect(itemIn(sub, 'one').enabled).toBe(true)
    expect(itemIn(sub, 'two').enabled).toBe(false)
    fire(itemIn(sub, 'one'))
    expect(hooks.calls).toEqual(['open-recent:/a/one'])
  })

  it('File > Open Recent shows a disabled placeholder when there are no recents', () => {
    installApplicationMenu(hooks)
    const sub = itemIn(submenuOf('File'), 'Open Recent').submenu as MenuItemConstructorOptions[]
    expect(sub).toHaveLength(1)
    expect(sub[0].label).toBe('No Recent Workspaces')
    expect(sub[0].enabled).toBe(false)
  })

  it('Help menu has GitHub / Report an Issue / Keyboard Shortcuts that invoke their hooks', () => {
    const help = h.template.find((i) => i.role === 'help')
    if (!help || !Array.isArray(help.submenu)) throw new Error('no Help menu with submenu')
    const menu = help.submenu as MenuItemConstructorOptions[]
    fire(itemIn(menu, 'Navide on GitHub'))
    fire(itemIn(menu, 'Report an Issue…'))
    fire(itemIn(menu, 'Keyboard Shortcuts'))
    expect(hooks.calls).toEqual(['open-repo', 'report-issue', 'show-shortcuts'])
  })

  it('Window has Pipeline Manager that invokes its hook', () => {
    const win = submenuOf('Window')
    fire(itemIn(win, 'Pipeline Manager'))
    expect(hooks.calls).toEqual(['pipeline-manager'])
  })

  it('View still has no webContents zoom roles (deliberate omission)', () => {
    const view = submenuOf('View')
    const zoomRoles = view.filter(
      (i) => typeof i.role === 'string' && ['resetzoom', 'zoomin', 'zoomout'].includes(i.role.toLowerCase())
    )
    expect(zoomRoles).toEqual([])
  })

  it('builds and clicks safely with no hooks at all', () => {
    expect(() => installApplicationMenu()).not.toThrow()
    const menu = isMac ? submenuOf('Agent-Team') : submenuOf('File')
    expect(() => fire(itemIn(menu, 'Settings…'))).not.toThrow()
    expect(() => fire(itemIn(submenuOf('Window'), 'Pipeline Manager'))).not.toThrow()
  })
})
