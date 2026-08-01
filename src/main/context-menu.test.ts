import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

const h = vi.hoisted(() => ({
  template: null as MenuItemConstructorOptions[] | null,
  popups: 0,
  written: [] as string[],
  ipc: new Map<string, (event: { sender: unknown }, ...args: unknown[]) => void>()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: (text: string) => h.written.push(text) },
  ipcMain: {
    on: (channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => void) => {
      h.ipc.set(channel, listener)
    }
  },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      h.template = template
      return { popup: () => { h.popups++ } }
    }
  }
}))

import {
  buildContextMenuTemplate,
  buildTerminalContextMenuTemplate,
  installContextMenu,
  registerTerminalContextMenu,
  TERMINAL_CONTEXT_MENU_CHANNEL,
  type ContextMenuActions
} from './context-menu'

function recordingActions(): ContextMenuActions & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    copy: (text) => calls.push(`copy:${text}`),
    cut: (text) => calls.push(`cut:${text}`),
    paste: () => calls.push('paste'),
    selectAll: () => calls.push('selectAll')
  }
}

function labels(template: MenuItemConstructorOptions[]): string[] {
  return template.map((item) => item.label ?? item.type ?? '?')
}

function click(template: MenuItemConstructorOptions[], label: string): void {
  const item = template.find((i) => i.label === label)
  if (!item) throw new Error(`no menu item labeled "${label}"`)
  ;(item.click as unknown as () => void)()
}

function webContentsStub() {
  const calls: string[] = []
  const listeners = new Map<string, (event: unknown, params: unknown) => void>()
  return {
    calls,
    listeners,
    contents: {
      on: vi.fn((event: string, listener: (event: unknown, params: unknown) => void) => {
        listeners.set(event, listener)
      }),
      paste: () => calls.push('paste'),
      selectAll: () => calls.push('selectAll'),
      delete: () => calls.push('delete')
    }
  }
}

beforeEach(() => {
  h.template = null
  h.popups = 0
  h.written = []
  h.ipc.clear()
})

describe('buildContextMenuTemplate', () => {
  it('offers Copy for a selection in non-editable content', () => {
    const template = buildContextMenuTemplate(
      { selectionText: 'hello', isEditable: false },
      recordingActions()
    )
    expect(labels(template)).toEqual(['Copy', 'separator', 'Select All'])
  })

  it('offers the full set in an editable field with a selection', () => {
    const template = buildContextMenuTemplate(
      { selectionText: 'hello', isEditable: true },
      recordingActions()
    )
    expect(labels(template)).toEqual(['Copy', 'Cut', 'Paste', 'separator', 'Select All'])
  })

  it('drops Copy/Cut in an editable field with nothing selected', () => {
    const template = buildContextMenuTemplate(
      { selectionText: '', isEditable: true },
      recordingActions()
    )
    expect(labels(template)).toEqual(['Paste', 'separator', 'Select All'])
  })

  it('returns nothing for inert chrome — no selection, not editable', () => {
    const template = buildContextMenuTemplate(
      { selectionText: '', isEditable: false },
      recordingActions()
    )
    expect(template).toEqual([])
  })

  it('routes each item to its action, carrying the selection text', () => {
    const actions = recordingActions()
    const template = buildContextMenuTemplate(
      { selectionText: 'picked', isEditable: true },
      actions
    )
    for (const label of ['Copy', 'Cut', 'Paste', 'Select All']) click(template, label)
    expect(actions.calls).toEqual(['copy:picked', 'cut:picked', 'paste', 'selectAll'])
  })
})

describe('buildTerminalContextMenuTemplate', () => {
  it('offers Copy only when the pane reports a selection', () => {
    const withSelection = buildTerminalContextMenuTemplate('ls -la', recordingActions())
    expect(labels(withSelection)).toEqual(['Copy', 'Paste'])

    const empty = buildTerminalContextMenuTemplate('', recordingActions())
    expect(labels(empty)).toEqual(['Paste'])
  })

  it('copies the selection the renderer passed, not a DOM selection', () => {
    const actions = recordingActions()
    click(buildTerminalContextMenuTemplate('ls -la', actions), 'Copy')
    expect(actions.calls).toEqual(['copy:ls -la'])
  })
})

describe('installContextMenu', () => {
  it('opens a menu on right-click when there is something to offer', () => {
    const { contents, listeners } = webContentsStub()
    installContextMenu(contents as never)

    listeners.get('context-menu')?.({}, { selectionText: 'hello', isEditable: false })

    expect(h.popups).toBe(1)
    expect(labels(h.template!)).toEqual(['Copy', 'separator', 'Select All'])
  })

  it('stays silent on inert targets so existing UI is untouched', () => {
    const { contents, listeners } = webContentsStub()
    installContextMenu(contents as never)

    listeners.get('context-menu')?.({}, { selectionText: '', isEditable: false })

    expect(h.popups).toBe(0)
  })

  it('writes the pasteboard directly instead of relying on the copy role', () => {
    const { contents, listeners, calls } = webContentsStub()
    installContextMenu(contents as never)
    listeners.get('context-menu')?.({}, { selectionText: 'hello', isEditable: true })

    click(h.template!, 'Copy')
    expect(h.written).toEqual(['hello'])

    click(h.template!, 'Cut')
    expect(h.written).toEqual(['hello', 'hello'])
    expect(calls).toEqual(['delete'])
  })

  it('delegates Paste and Select All to the WebContents', () => {
    const { contents, listeners, calls } = webContentsStub()
    installContextMenu(contents as never)
    listeners.get('context-menu')?.({}, { selectionText: '', isEditable: true })

    click(h.template!, 'Paste')
    click(h.template!, 'Select All')
    expect(calls).toEqual(['paste', 'selectAll'])
  })
})

describe('registerTerminalContextMenu', () => {
  it('builds the menu from the selection the pane sent', () => {
    registerTerminalContextMenu()
    const { contents } = webContentsStub()

    h.ipc.get(TERMINAL_CONTEXT_MENU_CHANNEL)?.({ sender: contents }, 'selected text')

    expect(h.popups).toBe(1)
    expect(labels(h.template!)).toEqual(['Copy', 'Paste'])
    click(h.template!, 'Copy')
    expect(h.written).toEqual(['selected text'])
  })

  it('treats a non-string payload as no selection', () => {
    registerTerminalContextMenu()
    const { contents } = webContentsStub()

    h.ipc.get(TERMINAL_CONTEXT_MENU_CHANNEL)?.({ sender: contents }, undefined)

    expect(labels(h.template!)).toEqual(['Paste'])
  })
})
