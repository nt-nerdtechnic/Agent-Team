import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type IpcEvent = { sender: { id: number } }
type IpcHandler = (event: IpcEvent, payload?: unknown) => unknown
type IpcListener = (event: IpcEvent, payload?: unknown) => void

vi.mock('electron', () => {
  const ipcHandlers = new Map<string, IpcHandler>()
  const ipcListeners = new Map<string, IpcListener>()
  const exposed: Record<string, unknown> = {}
  const views: FakeWebContentsView[] = []
  let senderId = 0
  let nextWebContentsId = 9000

  class FakeWebContents {
    readonly id = nextWebContentsId++
    readonly loads: string[] = []
    readonly sent: Array<{ channel: string; args: unknown[] }> = []
    private destroyed = false
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    isDestroyed(): boolean {
      return this.destroyed
    }

    send(channel: string, ...args: unknown[]): void {
      this.sent.push({ channel, args })
      if (channel === 'plugin:backend:event') {
        const listener = ipcRendererListeners.get(channel)
        listener?.({ sender: { id: this.id } }, args[0])
      }
    }

    focus(): void {}

    loadFile(file: string, options?: { search?: string }): Promise<void> {
      this.loads.push(`${file}${options?.search ?? ''}`)
      return Promise.resolve()
    }

    loadURL(url: string): Promise<void> {
      this.loads.push(url)
      return Promise.resolve()
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    once(event: string, listener: (...args: unknown[]) => void): this {
      const wrapper = (...args: unknown[]): void => {
        this.removeListener(event, wrapper)
        listener(...args)
      }
      return this.on(event, wrapper)
    }

    removeListener(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
      )
      return this
    }

    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      for (const listener of [...(this.listeners.get('destroyed') ?? [])]) listener()
    }
  }

  const ipcRendererListeners = new Map<string, IpcListener>()
  const ipcRenderer = {
    on(channel: string, listener: IpcListener): void {
      ipcRendererListeners.set(channel, listener)
    },
    removeListener(channel: string, listener: IpcListener): void {
      if (ipcRendererListeners.get(channel) === listener) ipcRendererListeners.delete(channel)
    },
    invoke(channel: string, payload: unknown): Promise<unknown> {
      const handler = ipcHandlers.get(channel)
      if (!handler) return Promise.reject(new Error(`missing IPC handler: ${channel}`))
      return Promise.resolve(handler({ sender: { id: senderId } }, payload))
    },
    send(channel: string, payload?: unknown): void {
      ipcListeners.get(channel)?.({ sender: { id: senderId } }, payload)
    },
  }

  class FakeWebContentsView {
    readonly webContents = new FakeWebContents()
    readonly options: unknown
    bounds: unknown = null
    visible = false

    constructor(options?: unknown) {
      this.options = options
      views.push(this)
    }

    setBounds(bounds: unknown): void {
      this.bounds = bounds
    }

    setVisible(visible: boolean): void {
      this.visible = visible
    }
  }

  return {
    BrowserWindow: class BrowserWindow {},
    WebContentsView: FakeWebContentsView,
    ipcMain: {
      handle(channel: string, handler: IpcHandler): void {
        ipcHandlers.set(channel, handler)
      },
      on(channel: string, listener: IpcListener): void {
        ipcListeners.set(channel, listener)
      },
    },
    ipcRenderer,
    contextBridge: {
      exposeInMainWorld(name: string, value: unknown): void {
        exposed[name] = value
      },
    },
    __mock: {
      ipcHandlers,
      ipcListeners,
      exposed,
      views,
      setSender(id: number): void {
        senderId = id
      },
    },
  }
})

import * as electron from 'electron'
import {
  FrontendPluginManager,
  PLANS_PLUGIN_ID,
  type PluginLaunchDescriptor,
} from '../../src/main/plugins/frontendPluginManager'
import { useBackend } from '../../src/renderer/plugins/plans/capabilityBackend'
import { resolvePlanRoot } from '../../src/renderer/plugins/plans/resolvePlanRoot'

interface FakeWebContentsViewLike {
  webContents: { id: number }
  options: {
    webPreferences?: { additionalArguments?: string[] }
  }
}

class FakeHostWindow {
  readonly id = 41
  readonly children: unknown[] = []
  readonly contentView = {
    addChildView: (view: unknown): void => {
      this.children.push(view)
    },
    removeChildView: (view: unknown): void => {
      const index = this.children.indexOf(view)
      if (index >= 0) this.children.splice(index, 1)
    },
  }
  private destroyed = false
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  isDestroyed(): boolean {
    return this.destroyed
  }

  isMinimized(): boolean {
    return false
  }

  restore(): void {}

  show(): void {}

  focus(): void {}

  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 1200, height: 800 }
  }

  setTitle(_title: string): void {}

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.removeListener(event, wrapper)
      listener(...args)
    }
    return this.on(event, wrapper)
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    )
    return this
  }
}

const mock = (electron as unknown as {
  __mock: {
    exposed: Record<string, unknown>
    views: FakeWebContentsViewLike[]
    setSender(id: number): void
  }
}).__mock

const packagedFixture = join(process.cwd(), 'dist-test-fixtures/plans/backend/navide-plans')
const packagedFixtureEnabled = process.env.NAVIDE_TEST_PACKAGED_PLANS === '1'
if (packagedFixtureEnabled && !existsSync(packagedFixture)) {
  throw new Error(
    `NAVIDE_TEST_PACKAGED_PLANS=1 requires the packaged fixture at ${packagedFixture}; run pnpm run build:plans:fixture first.`,
  )
}

const runPackagedTest = packagedFixtureEnabled ? it : it.skip

describe('Plans packaged backend composition', () => {
  const managers: FrontendPluginManager[] = []
  const originalArgv = [...process.argv]
  const originalWindow = (globalThis as unknown as { window?: unknown }).window
  const originalNav = (globalThis as unknown as { nav?: unknown }).nav

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.closeBackendPlugins()))
    process.argv.splice(0, process.argv.length, ...originalArgv)
    if (originalWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true })
    if (originalNav === undefined) delete (globalThis as unknown as { nav?: unknown }).nav
    else Object.defineProperty(globalThis, 'nav', { value: originalNav, configurable: true })
  })

  runPackagedTest(
    'resolves the Plans root and receives plans.changed through the packaged child',
    async () => {
      const manager = new FrontendPluginManager()
      managers.push(manager)
      const workspacePath = process.cwd()
      const packageVersion = '0.1.92'
      const view = {
        id: 'window',
        contributionKey: `${PLANS_PLUGIN_ID}.window`,
        kind: 'custom' as const,
        location: 'window' as const,
        title: 'Plans',
        entryFile: join(workspacePath, 'src/renderer/plugins/plans/index.html'),
      }
      const descriptor: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: workspacePath,
        requires: [],
        devUrl: '',
        entryFile: view.entryFile,
        views: [view],
      }
      manager.registerDescriptor(descriptor, { builtin: true })
      manager.registerBackendActivation({
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: workspacePath,
        entryFile: packagedFixture,
        protocolVersion: 1,
        activation: 'startup',
        approvedMethods: ['plans.resolve_root'],
        approvedEvents: ['plans.changed'],
      })

      const hostWindow = new FakeHostWindow()
      const handle = await manager.openView(descriptor, view, {
        hostWindow: hostWindow as never,
        bounds: 'fill',
        workspacePath,
        query: `?workspace_path=${encodeURIComponent(workspacePath)}`,
      })
      const mountedView = mock.views.at(-1)
      expect(mountedView?.options.webPreferences?.additionalArguments).toContain('--plugin-backend=1')
      expect(hostWindow.children).toHaveLength(1)
      const webContents = (hostWindow.children[0] as FakeWebContentsViewLike).webContents
      mock.setSender(webContents.id)

      process.argv.splice(
        0,
        process.argv.length,
        ...originalArgv,
        `--plugin-id=${PLANS_PLUGIN_ID}`,
        '--plugin-backend=1',
      )
      await import('../../src/preload/plugin-preload')
      const nav = mock.exposed.nav
      expect(nav).toBeDefined()
      Object.defineProperty(globalThis, 'window', {
        value: { location: { search: `?workspace_path=${encodeURIComponent(workspacePath)}` }, nav },
        configurable: true,
      })
      Object.defineProperty(globalThis, 'nav', { value: nav, configurable: true })

      const planBackend = useBackend()
      let resolveChanged!: (payload: unknown) => void
      const changed = new Promise<unknown>((resolve) => {
        resolveChanged = resolve
      })
      const dispose = planBackend.on('plans.changed', resolveChanged)
      await expect(resolvePlanRoot(planBackend, workspacePath)).resolves.toBe(workspacePath)
      await expect(changed).resolves.toEqual({ workspace_path: workspacePath })
      dispose()
      manager.destroyInstance(handle.instanceId)
    },
  )
})
