import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fromWebContents } = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { fromWebContents },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))

import { registeredGitLeftWorkspace, trustedGitLeftWindow } from './gitLeftIpc'

type FakeWindow = {
  id: number
  webContents: object
  isDestroyed: () => boolean
}

describe('Git-left IPC authorization', () => {
  beforeEach(() => {
    fromWebContents.mockReset()
  })

  it('accepts only a live top-level sender from a registered non-detached main window', () => {
    const sender = {}
    const hostWindow: FakeWindow = {
      id: 1,
      webContents: sender,
      isDestroyed: () => false,
    }
    fromWebContents.mockReturnValue(hostWindow)

    expect(trustedGitLeftWindow(
      { sender, senderFrame: { parent: null } } as never,
      new Set([hostWindow]) as never,
      new Set(),
    )).toBe(hostWindow)

    expect(trustedGitLeftWindow(
      { sender, senderFrame: { parent: {} } } as never,
      new Set([hostWindow]) as never,
      new Set(),
    )).toBeNull()

    expect(trustedGitLeftWindow(
      { sender } as never,
      new Set([hostWindow]) as never,
      new Set(),
    )).toBeNull()

    expect(trustedGitLeftWindow(
      { sender: {}, senderFrame: { parent: null } } as never,
      new Set([hostWindow]) as never,
      new Set(),
    )).toBeNull()

    expect(trustedGitLeftWindow(
      { sender, senderFrame: { parent: null } } as never,
      new Set([hostWindow]) as never,
      new Set([hostWindow.id]),
    )).toBeNull()
  })

  it('rejects destroyed or unregistered windows', () => {
    const sender = {}
    const destroyedWindow: FakeWindow = {
      id: 2,
      webContents: sender,
      isDestroyed: () => true,
    }
    fromWebContents.mockReturnValue(destroyedWindow)

    expect(trustedGitLeftWindow(
      { sender, senderFrame: { parent: null } } as never,
      new Set([destroyedWindow]) as never,
      new Set(),
    )).toBeNull()

    const liveWindow: FakeWindow = { ...destroyedWindow, isDestroyed: () => false }
    fromWebContents.mockReturnValue(liveWindow)
    expect(trustedGitLeftWindow(
      { sender, senderFrame: { parent: null } } as never,
      new Set() as never,
      new Set(),
    )).toBeNull()
  })

  it('accepts only a workspace assertion matching the Host window registry', () => {
    const hostWindow = { id: 3 } as never
    const workspaces = new Map([[hostWindow, '/workspace/']])
    const normalize = (value: string): string => value.replace(/\/+$/, '')

    expect(registeredGitLeftWorkspace(hostWindow, '/workspace', workspaces, normalize)).toBe('/workspace/')
    expect(registeredGitLeftWorkspace(hostWindow, '/other', workspaces, normalize)).toBeNull()
    expect(registeredGitLeftWorkspace(hostWindow, undefined, workspaces, normalize)).toBeNull()
    expect(registeredGitLeftWorkspace(hostWindow, '/workspace', new Map(), normalize)).toBeNull()
  })
})
