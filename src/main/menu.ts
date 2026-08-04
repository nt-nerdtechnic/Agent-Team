import { app, Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * Application menu.
 *
 * The default Electron menu structure (kept so native accelerators like
 * ⌘C / ⌘V / ⌘Q keep working — `setApplicationMenu(null)` would break
 * copy/paste and quit) plus Navide-specific entries wired through
 * AppMenuHooks:
 *   - App menu (macOS): Settings… (⌘,) and Check for Updates…
 *   - File: Open Workspace… (⌘O); on non-macOS also Settings… / Check for
 *     Updates… (platforms without an app menu)
 *   - Window: Pipeline Manager
 *
 * ONE deliberate omission from the default menu remains: the View submenu's
 * `resetZoom` / `zoomIn` / `zoomOut` roles. Those roles bind ⌘0 / ⌘+ / ⌘- to
 * `webContents` zoom, which scales the ENTIRE window — chrome, layout, every
 * pane — and their native accelerators fire before the renderer's key
 * handlers. Zoom in this app is per-pane content zoom only (xterm font size
 * in useTerminal.ts, Monaco font size in EditorViewMonaco.vue), so the
 * built-in roles must not exist. Installing a menu without them is the only
 * way to drop them: Electron has no API to edit the default menu in place.
 */
/** One entry in the File > Open Recent submenu. */
export interface RecentMenuEntry {
  path: string
  name: string
  exists: boolean
}

export interface AppMenuHooks {
  /** App menu (macOS) / File menu (non-macOS): open the settings modal. */
  onOpenSettings?: () => void
  /** App menu (macOS) / File menu (non-macOS): check for updates. */
  onCheckUpdates?: () => void
  /** File menu: pick a workspace folder and open it. */
  onOpenWorkspace?: () => void
  /** File menu: open a recent workspace by absolute path. */
  onOpenRecent?: (path: string) => void
  /** File menu: open a fresh window. */
  onNewWindow?: () => void
  /** Window menu: ask the main window to open the Pipeline Manager modal. */
  onOpenPipelineManager?: () => void
  /** Help menu: open the Navide GitHub repo. */
  onOpenRepo?: () => void
  /** Help menu: open the GitHub issues page. */
  onReportIssue?: () => void
  /** Help menu: show the keyboard-shortcuts panel. */
  onShowShortcuts?: () => void
  // When provided, a dev-only "Developer" submenu with an entry that opens the
  // no-op plugin view is appended. Omit it (the default) and the menu is
  // byte-for-byte the shipping menu. Gated by the caller behind a dev flag.
  onOpenNoopPlugin?: () => void
  /** Same dev-only submenu: opens the M2 fs-probe plugin view. */
  onOpenFsProbePlugin?: () => void
  /** Same dev-only submenu: opens the M4 mini-IDE plugin view. */
  onOpenMiniIdePlugin?: () => void
  /** Same dev-only submenu: opens the Plans plugin view. */
  onOpenPlansPlugin?: () => void
}

export function installApplicationMenu(
  hooks: AppMenuHooks = {},
  recents: RecentMenuEntry[] = []
): void {
  const isMac = process.platform === 'darwin'

  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => hooks.onOpenSettings?.()
  }
  const checkUpdatesItem: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => hooks.onCheckUpdates?.()
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settingsItem,
              checkUpdatesItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => hooks.onNewWindow?.() },
        {
          label: 'Open Workspace…',
          accelerator: 'CmdOrCtrl+O',
          click: () => hooks.onOpenWorkspace?.()
        },
        {
          label: 'Open Recent',
          submenu: recents.length
            ? recents.map((r) => ({
                label: r.name || r.path,
                enabled: r.exists,
                click: () => hooks.onOpenRecent?.(r.path)
              }))
            : [{ label: 'No Recent Workspaces', enabled: false }]
        },
        { type: 'separator' },
        // No app menu off macOS — surface the same entries under File.
        ...(isMac
          ? [{ role: 'close' } as MenuItemConstructorOptions]
          : [
              settingsItem,
              checkUpdatesItem,
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'quit' } as MenuItemConstructorOptions
            ])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' } as MenuItemConstructorOptions,
              { role: 'delete' } as MenuItemConstructorOptions,
              { role: 'selectAll' } as MenuItemConstructorOptions
            ]
          : [
              { role: 'delete' } as MenuItemConstructorOptions,
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'selectAll' } as MenuItemConstructorOptions
            ])
      ]
    },
    {
      label: 'View',
      // No resetZoom / zoomIn / zoomOut — see the doc comment above.
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Pipeline Manager', click: () => hooks.onOpenPipelineManager?.() },
        { type: 'separator' },
        { role: 'minimize' },
        // macOS "zoom" = maximize the window frame. Unrelated to content zoom,
        // has no accelerator, and is part of the standard Window menu.
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'front' } as MenuItemConstructorOptions
            ]
          : [{ role: 'close' } as MenuItemConstructorOptions])
      ]
    },
    {
      role: 'help',
      submenu: [
        { label: 'Navide on GitHub', click: () => hooks.onOpenRepo?.() },
        { label: 'Report an Issue…', click: () => hooks.onReportIssue?.() },
        { type: 'separator' },
        { label: 'Keyboard Shortcuts', click: () => hooks.onShowShortcuts?.() }
      ]
    } as MenuItemConstructorOptions
  ]

  // Dev-only, flag-gated: a Developer submenu to launch the M1 plugin view.
  // Never present unless the caller passes the hook (see index.ts gating), so
  // the default UI is untouched.
  if (hooks.onOpenNoopPlugin || hooks.onOpenFsProbePlugin || hooks.onOpenMiniIdePlugin || hooks.onOpenPlansPlugin) {
    const submenu: MenuItemConstructorOptions[] = []
    if (hooks.onOpenNoopPlugin) {
      submenu.push({ label: 'Open no-op plugin view', click: () => hooks.onOpenNoopPlugin?.() })
    }
    if (hooks.onOpenFsProbePlugin) {
      submenu.push({ label: 'Open fs-probe plugin view', click: () => hooks.onOpenFsProbePlugin?.() })
    }
    if (hooks.onOpenMiniIdePlugin) {
      submenu.push({ label: 'Open mini-IDE plugin view', click: () => hooks.onOpenMiniIdePlugin?.() })
    }
    if (hooks.onOpenPlansPlugin) {
      submenu.push({ label: 'Open Plans plugin view', click: () => hooks.onOpenPlansPlugin?.() })
    }
    template.push({ label: 'Developer', submenu })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
