import { beforeEach, describe, expect, it, vi } from 'vitest'

// Contribution host windows are registered by key so a second open focuses the
// existing window instead of creating a duplicate. `close()` and the 'closed'
// event are separated by an event-loop turn, and a reopen can land in that gap:
// the late handler must only ever evict the entry it owns.

type Listener = (...args: never[]) => unknown

const ipcListeners = new Map<string, Listener>()

class FakeWindow {
  static instances: FakeWindow[] = []
  destroyed = false
  shown = 0
  focused = 0
  private readonly closedHandlers: Array<() => void> = []

  constructor() {
    FakeWindow.instances.push(this)
  }

  once(event: string, handler: () => void): void {
    if (event === 'closed') this.closedHandlers.push(handler)
  }

  on(): void {}

  /** Electron destroys the window synchronously but emits 'closed' later. */
  close(): void {
    this.destroyed = true
  }

  emitClosed(): void {
    this.destroyed = true
    for (const handler of this.closedHandlers.splice(0)) handler()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isMinimized(): boolean {
    return false
  }

  restore(): void {}

  show(): void {
    this.shown += 1
  }

  focus(): void {
    this.focused += 1
  }
}

vi.mock('electron', () => {
  const app = {
    isPackaged: false,
    getPath: () => '/tmp/navide-git-window-registry-race-test',
    setPath: () => {},
    getName: () => 'Navide',
    getVersion: () => '0.0.0-test',
    on: () => {},
    once: () => {},
    setName: () => {},
    quit: () => {},
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch: () => {} },
    setAboutPanelOptions: () => {},
  }
  class BrowserWindow extends FakeWindow {
    static getAllWindows(): unknown[] {
      return []
    }
    static getFocusedWindow(): unknown {
      return null
    }
    static fromWebContents(): unknown {
      return null
    }
    static fromId(): unknown {
      return null
    }
  }
  return {
    app,
    BrowserWindow,
    dialog: {
      showMessageBox: () => Promise.resolve({ response: 0 }),
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    },
    ipcMain: {
      handle: (channel: string, listener: Listener) => {
        ipcListeners.set(channel, listener)
      },
      on: (channel: string, listener: Listener) => {
        ipcListeners.set(channel, listener)
      },
      removeHandler: () => {},
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    Notification: class {
      static isSupported(): boolean {
        return false
      }
      show(): void {}
    },
    powerMonitor: { on: () => {} },
    safeStorage: { isEncryptionAvailable: () => false },
    session: {
      defaultSession: { webRequest: { onHeadersReceived: () => {} } },
      fromPartition: () => ({}),
    },
    shell: { openExternal: () => Promise.resolve(), showItemInFolder: () => {} },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({ popup: () => {} }) },
  }
})

describe('contribution window registry', () => {
  beforeEach(() => {
    ipcListeners.clear()
    FakeWindow.instances.length = 0
    vi.resetModules()
  })

  it('keeps the reopened window registered when the closing window settles late', async () => {
    const manager = await import('./plugins/frontendPluginManager')
    vi.spyOn(manager.frontendPluginManager, 'listContributionCatalog').mockReturnValue([
      {
        contributionKey: 'navide.git.window',
        location: 'window',
        title: 'Git',
      },
    ] as unknown as ReturnType<typeof manager.frontendPluginManager.listContributionCatalog>)
    vi.spyOn(manager.frontendPluginManager, 'closeContribution').mockReturnValue({ ok: true })
    const openContribution = vi
      .spyOn(manager.frontendPluginManager, 'openContributionWindow')
      .mockResolvedValueOnce({ ok: false, error: 'first open fails' })
      .mockResolvedValue({ ok: true })

    await import('./index')

    const openGit = ipcListeners.get('window:openGit')
    expect(openGit).toBeTypeOf('function')
    const open = (): Promise<{ ok: boolean }> =>
      (openGit as (event: unknown, args: Record<string, string>) => Promise<{ ok: boolean }>)(
        {},
        { workspace_path: '/tmp/navide-git-window-registry-race-test' },
      )

    // 1. The first open fails, so the Host closes the window it just created.
    //    Electron has not delivered its 'closed' event yet.
    expect(await open()).toEqual({ ok: false })
    expect(FakeWindow.instances).toHaveLength(1)
    const firstWindow = FakeWindow.instances[0]!
    expect(firstWindow.isDestroyed()).toBe(true)

    // 2. A reopen lands in that gap and registers a second window.
    expect(await open()).toEqual({ ok: true })
    expect(FakeWindow.instances).toHaveLength(2)
    const secondWindow = FakeWindow.instances[1]!

    // 3. Only now does the first window's 'closed' handler run.
    firstWindow.emitClosed()

    // 4. The next open must focus the live window, not create a third one.
    expect(await open()).toEqual({ ok: true })
    expect(FakeWindow.instances).toHaveLength(2)
    expect(secondWindow.focused).toBe(2)
    expect(openContribution).toHaveBeenCalledTimes(3)
  })
})
