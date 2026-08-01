import { BrowserWindow, clipboard, ipcMain, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'

/** Renderer → main request to open the terminal's own context menu. */
export const TERMINAL_CONTEXT_MENU_CHANNEL = 'terminal:context-menu'

/** What a menu item does when clicked, injected so templates stay testable. */
export interface ContextMenuActions {
  copy(text: string): void
  cut(text: string): void
  paste(): void
  selectAll(): void
}

type ContextMenuTarget = Pick<WebContents, 'on'>

/**
 * Build the template for a right-click on ordinary page content.
 *
 * Copy/Cut write the pasteboard directly instead of using `role: 'copy'` so
 * the item never depends on the native responder chain resolving to the right
 * WebContents — plugin content lives in a child WebContentsView, and the menu
 * has to work there too.
 *
 * An empty template means "no menu": right-clicking inert chrome should stay
 * inert rather than pop an all-disabled menu.
 */
export function buildContextMenuTemplate(
  params: Pick<ContextMenuParams, 'selectionText' | 'isEditable'>,
  actions: ContextMenuActions
): MenuItemConstructorOptions[] {
  const selection = params.selectionText
  const template: MenuItemConstructorOptions[] = []

  if (selection) template.push({ label: 'Copy', click: () => actions.copy(selection) })
  if (params.isEditable) {
    if (selection) template.push({ label: 'Cut', click: () => actions.cut(selection) })
    template.push({ label: 'Paste', click: () => actions.paste() })
  }
  if (template.length === 0) return []

  template.push({ type: 'separator' }, { label: 'Select All', click: () => actions.selectAll() })
  return template
}

/**
 * Build the template for a right-click inside a terminal pane.
 *
 * xterm paints its own selection layer and sets `user-select: none` on
 * `.xterm`, so `params.selectionText` is always empty there and Select All has
 * nothing to act on. The renderer passes `term.getSelection()` instead.
 */
export function buildTerminalContextMenuTemplate(
  selection: string,
  actions: Pick<ContextMenuActions, 'copy' | 'paste'>
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []
  if (selection) template.push({ label: 'Copy', click: () => actions.copy(selection) })
  template.push({ label: 'Paste', click: () => actions.paste() })
  return template
}

function webContentsActions(contents: WebContents): ContextMenuActions {
  return {
    copy: (text) => clipboard.writeText(text),
    cut: (text) => {
      clipboard.writeText(text)
      contents.delete()
    },
    paste: () => contents.paste(),
    selectAll: () => contents.selectAll()
  }
}

/**
 * Give every WebContents a right-click menu.
 *
 * Electron ships no default context menu, so without this right-click is inert
 * across the whole app — including as a fallback when a copy shortcut fails.
 * Chromium only emits `context-menu` when the renderer left the event's default
 * behaviour intact, so panes that already build their own menu (and call
 * preventDefault) are unaffected.
 */
export function installContextMenu(contents: ContextMenuTarget): void {
  contents.on('context-menu', (_event, params) => {
    const target = contents as WebContents
    const template = buildContextMenuTemplate(params, webContentsActions(target))
    if (template.length === 0) return
    const window = BrowserWindow.fromWebContents(target)
    Menu.buildFromTemplate(template).popup(window ? { window } : {})
  })
}

/** Serve terminal right-clicks, which carry their selection from the renderer. */
export function registerTerminalContextMenu(): void {
  ipcMain.on(TERMINAL_CONTEXT_MENU_CHANNEL, (event, selection: unknown) => {
    const contents = event.sender
    const actions = webContentsActions(contents)
    const template = buildTerminalContextMenuTemplate(
      typeof selection === 'string' ? selection : '',
      actions
    )
    const window = BrowserWindow.fromWebContents(contents)
    Menu.buildFromTemplate(template).popup(window ? { window } : {})
  })
}
