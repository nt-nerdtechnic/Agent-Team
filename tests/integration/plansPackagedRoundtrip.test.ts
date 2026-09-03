// @vitest-environment happy-dom
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'

type IpcEvent = { sender: { id: number } }
type IpcHandler = (event: IpcEvent, payload?: unknown) => unknown
type IpcListener = (event: IpcEvent, payload?: unknown) => void

const electronMock = vi.hoisted(() => {
  let nextWebContentsId = 9000
  let nextWindowId = 41
  let senderId = 0

  class FakeWebContents {
    readonly id = nextWebContentsId++
    readonly sent: Array<{ channel: string; args: unknown[] }> = []
    private destroyed = false

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

    loadFile(): Promise<void> {
      return Promise.resolve()
    }

    loadURL(): Promise<void> {
      return Promise.resolve()
    }

    on(): this {
      return this
    }

    once(): this {
      return this
    }

    removeListener(): this {
      return this
    }

    close(): void {
      this.destroyed = true
    }
  }

  const ipcHandlers = new Map<string, IpcHandler>()
  const ipcListeners = new Map<string, IpcListener>()
  const ipcRendererListeners = new Map<string, IpcListener>()
  const invocations: Array<{ channel: string; payload: unknown }> = []
  const views: FakeWebContentsView[] = []

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

  class FakeHostWindow {
    readonly id = nextWindowId++
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

    isDestroyed(): boolean {
      return false
    }

    isMinimized(): boolean {
      return false
    }

    restore(): void {}

    show(): void {}

    focus(): void {}

    getContentBounds(): { x: number; y: number; width: number; height: number } {
      return { x: 0, y: 0, width: 1280, height: 820 }
    }

    on(): this {
      return this
    }

    removeListener(): this {
      return this
    }
  }

  const ipcRenderer = {
    on(channel: string, listener: IpcListener): void {
      ipcRendererListeners.set(channel, listener)
    },
    removeListener(channel: string, listener: IpcListener): void {
      if (ipcRendererListeners.get(channel) === listener) ipcRendererListeners.delete(channel)
    },
    invoke(channel: string, payload: unknown): Promise<unknown> {
      invocations.push({ channel, payload })
      const handler = ipcHandlers.get(channel)
      if (!handler) return Promise.reject(new Error(`missing IPC handler: ${channel}`))
      return Promise.resolve(handler({ sender: { id: senderId } }, payload))
    },
    send(channel: string, payload?: unknown): void {
      ipcListeners.get(channel)?.({ sender: { id: senderId } }, payload)
    },
  }

  const exposed: Record<string, unknown> = {}

  return {
    FakeHostWindow,
    FakeWebContentsView,
    ipcHandlers,
    ipcListeners,
    ipcRendererListeners,
    invocations,
    views,
    exposed,
    ipcRenderer,
    setSender(id: number): void {
      senderId = id
    },
  }
})

vi.mock('electron', () => {
  return {
    BrowserWindow: electronMock.FakeHostWindow,
    WebContentsView: electronMock.FakeWebContentsView,
    ipcMain: {
      handle(channel: string, handler: IpcHandler): void {
        electronMock.ipcHandlers.set(channel, handler)
      },
      on(channel: string, listener: IpcListener): void {
        electronMock.ipcListeners.set(channel, listener)
      },
    },
    ipcRenderer: electronMock.ipcRenderer,
    contextBridge: {
      exposeInMainWorld(name: string, value: unknown): void {
        electronMock.exposed[name] = value
      },
    },
    __mock: electronMock,
  }
})

const coreWsMock = vi.hoisted(() => {
  class FakeNodeWebSocket {
    static readonly OPEN = 1
    static readonly CONNECTING = 0
    static readonly CLOSED = 3
    static readonly instances: FakeNodeWebSocket[] = []
    readonly sent: string[] = []
    readyState = FakeNodeWebSocket.CONNECTING
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>()

    constructor(readonly url: string) {
      FakeNodeWebSocket.instances.push(this)
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? []
      listeners.push(listener)
      this.listeners.set(type, listeners)
    }

    send(data: string): void {
      this.sent.push(data)
      const request = JSON.parse(data) as { id: string; type: string }
      queueMicrotask(() => {
        this.emit('message', {
          data: JSON.stringify({
            id: request.id,
            type: request.type,
            ok: true,
            payload: request.type === 'plans.resolve_root'
              ? { root: process.cwd() }
              : { settings: {} },
            error: null,
            timestamp: new Date().toISOString(),
          }),
        })
      })
    }

    close(): void {
      if (this.readyState === FakeNodeWebSocket.CLOSED) return
      this.readyState = FakeNodeWebSocket.CLOSED
      this.emit('close', {})
    }

    open(): void {
      this.readyState = FakeNodeWebSocket.OPEN
      this.emit('open', {})
    }

    private emit(type: string, event: unknown): void {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    }
  }

  return { FakeNodeWebSocket }
})

vi.mock('ws', () => ({ WebSocket: coreWsMock.FakeNodeWebSocket }))

import * as electron from 'electron'
import {
  FrontendPluginManager,
  PLANS_PLUGIN_ID,
  type PluginLaunchDescriptor,
} from '../../src/main/plugins/frontendPluginManager'
import { PLANS_PLUGIN_REQUIRES } from '../../src/shared/pluginCapabilities'

interface FakeWebContentsViewLike {
  webContents: {
    id: number
  }
  options: {
    webPreferences?: { additionalArguments?: string[] }
  }
}

const mock = (electron as unknown as {
  __mock: {
    exposed: Record<string, unknown>
    views: FakeWebContentsViewLike[]
    invocations: Array<{ channel: string; payload: unknown }>
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
  const originalWindowNav = (window as unknown as { nav?: unknown }).nav
  const originalLocation = window.location.href
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(managers.splice(0).map((manager) => manager.closeBackendPlugins()))
    process.argv.splice(0, process.argv.length, ...originalArgv)
    window.history.replaceState({}, '', originalLocation)
    if (originalWindowNav === undefined) delete (window as unknown as { nav?: unknown }).nav
    else Object.defineProperty(window, 'nav', { value: originalWindowNav, configurable: true })
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
      const workspacePath = join(process.cwd(), 'src')
      const expectedPlanRoot = process.cwd()
      const packageVersion = '0.1.92'
      const view = {
        id: 'window',
        contributionKey: `${PLANS_PLUGIN_ID}.window`,
        kind: 'custom' as const,
        location: 'window' as const,
        title: 'Plans',
        entryFile: join(expectedPlanRoot, 'src/renderer/plugins/plans/index.html'),
      }
      const descriptor: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: expectedPlanRoot,
        requires: [...PLANS_PLUGIN_REQUIRES],
        devUrl: '',
        entryFile: view.entryFile,
        views: [view],
      }
      manager.registerDescriptor(descriptor, { builtin: true })
      manager.configurePlansFilesystemService()
      manager.registerBackendActivation({
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: expectedPlanRoot,
        entryFile: packagedFixture,
        protocolVersion: 1,
        activation: 'startup',
        approvedMethods: ['plans.resolve_root'],
        approvedEvents: ['plans.changed'],
        approvedBridgePorts: ['filesystem'],
      })

      const hostWindow = new electronMock.FakeHostWindow()
      // The production bridge is configured explicitly; the package child
      // never receives a direct Node filesystem adapter.
      manager.setBackendWsUrl('ws://plans-core-test')
      const handle = await manager.openView(descriptor, view, {
        hostWindow: hostWindow as never,
        bounds: 'fill',
        workspacePath,
        query: `?window=plans&workspace_path=${encodeURIComponent(workspacePath)}&rel_path=${encodeURIComponent('.agent-team/plans/integration.html')}`,
      })
      const mountedView = mock.views.at(-1)
      expect(mountedView?.options.webPreferences?.additionalArguments).toContain('--plugin-backend=1')
      expect(hostWindow.children).toHaveLength(1)
      const webContents = (hostWindow.children[0] as FakeWebContentsViewLike).webContents
      mock.setSender(webContents.id)
      const coreSocket = coreWsMock.FakeNodeWebSocket.instances.at(-1)
      expect(coreSocket?.url).toBe('ws://plans-core-test')
      coreSocket?.open()
      await flushPromises()

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
      window.history.replaceState(
        {},
        '',
        `/?window=plans&workspace_path=${encodeURIComponent(workspacePath)}&rel_path=${encodeURIComponent('.agent-team/plans/integration.html')}`,
      )
      Object.defineProperty(globalThis, 'window', {
        value: window,
        configurable: true,
      })
      Object.defineProperty(window, 'nav', { value: nav, configurable: true })
      Object.defineProperty(globalThis, 'nav', { value: nav, configurable: true })

      mock.invocations.length = 0
      // Settings reconciliation currently reports failures through warn while
      // capability plumbing can report errors, so monitor both channels.
      const consoleError = vi.spyOn(console, 'error')
      const consoleWarn = vi.spyOn(console, 'warn')
      let plansSubscription: { dispose(): void } | undefined
      try {
        const plansBackendModule = '../../plugins/navide-plans/src/backend'
        const { plansBackend } = (await import(plansBackendModule)) as {
          plansBackend: {
            call(name: string, args?: unknown): Promise<unknown>
            subscribe(event: string, listener: (payload: unknown) => void): { ready: Promise<void>; dispose(): void }
          }
        }
        let resolveChanged!: (payload: unknown) => void
        const changed = new Promise<unknown>((resolve) => {
          resolveChanged = resolve
        })
        const sub = plansBackend.subscribe(
          'plans.changed',
          resolveChanged,
        )
        plansSubscription = sub
        await sub.ready

        const rootResult = await plansBackend.call('plans.resolve_root', { workspace_path: workspacePath })
        expect(rootResult).toMatchObject({ root: expectedPlanRoot })
        expect(mock.invocations).toContainEqual(expect.objectContaining({
          channel: 'plugin:backend:call',
          payload: expect.objectContaining({
            name: 'plans.resolve_root',
            args: { workspace_path: workspacePath },
          }),
        }))
        await expect(changed).resolves.toEqual({ workspace_path: expectedPlanRoot })
        const diagnostics = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
          .map((args) => args.map(String).join(' '))
          .join('\n')
        expect(diagnostics).not.toMatch(/capability .*not granted|\[settings\] reconcile failed/i)
      } finally {
        consoleError.mockRestore()
        consoleWarn.mockRestore()
        plansSubscription?.dispose()
        manager.destroyInstance(handle.instanceId)
      }
    },
  )

  runPackagedTest(
    'mounts the production PlansApp view and renders the plan list from the packaged child',
    async () => {
      const manager = new FrontendPluginManager()
      managers.push(manager)
      const workspacePath = join(process.cwd(), 'src')
      const expectedPlanRoot = process.cwd()
      const packageVersion = '0.1.92'
      const view = {
        id: 'window',
        contributionKey: `${PLANS_PLUGIN_ID}.window`,
        kind: 'custom' as const,
        location: 'window' as const,
        title: 'Plans',
        entryFile: join(expectedPlanRoot, 'src/renderer/plugins/plans/index.html'),
      }
      const descriptor: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: expectedPlanRoot,
        requires: [...PLANS_PLUGIN_REQUIRES],
        devUrl: '',
        entryFile: view.entryFile,
        views: [view],
      }
      manager.registerDescriptor(descriptor, { builtin: true })
      manager.configurePlansFilesystemService()
      manager.registerBackendActivation({
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: expectedPlanRoot,
        entryFile: packagedFixture,
        protocolVersion: 1,
        activation: 'startup',
        approvedMethods: ['plans.resolve_root', 'plans.list'],
        approvedEvents: ['plans.changed'],
        approvedBridgePorts: ['filesystem'],
      })

      const hostWindow = new electronMock.FakeHostWindow()
      manager.setBackendWsUrl('ws://plans-core-test')
      const handle = await manager.openView(descriptor, view, {
        hostWindow: hostWindow as never,
        bounds: 'fill',
        workspacePath,
        query: `?window=plans&workspace_path=${encodeURIComponent(workspacePath)}`,
      })
      const mountedView = mock.views.at(-1)
      expect(mountedView?.options.webPreferences?.additionalArguments).toContain('--plugin-backend=1')
      const webContents = (hostWindow.children[0] as FakeWebContentsViewLike).webContents
      mock.setSender(webContents.id)
      const coreSocket = coreWsMock.FakeNodeWebSocket.instances.at(-1)
      coreSocket?.open()
      await flushPromises()

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
      window.history.replaceState(
        {},
        '',
        `/?window=plans&workspace_path=${encodeURIComponent(workspacePath)}`,
      )
      Object.defineProperty(globalThis, 'window', {
        value: window,
        configurable: true,
      })
      Object.defineProperty(window, 'nav', { value: nav, configurable: true })
      Object.defineProperty(globalThis, 'nav', { value: nav, configurable: true })

      mock.invocations.length = 0
      const consoleError = vi.spyOn(console, 'error')
      const consoleWarn = vi.spyOn(console, 'warn')
      let app: { unmount(): void } | undefined
      try {
        const plansAppModule = '../../plugins/navide-plans/src/PlansApp.vue'
        const { default: PlansApp } = (await import(plansAppModule)) as {
          default: any
        }

        const mountedApp = mount(PlansApp, {
          global: {
            plugins: [i18n],
            stubs: {
              SafeAiCliPanel: true,
            },
          },
        })
        app = mountedApp

        for (let i = 0; i < 50; i++) {
          await flushPromises()
          if (mountedApp.find('.plan-row').exists()) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }

        expect(mock.invocations).toContainEqual(expect.objectContaining({
          channel: 'plugin:backend:call',
          payload: expect.objectContaining({
            name: 'plans.list',
            args: {},
          }),
        }))

        const row = mountedApp.find('.plan-row')
        expect(row.exists()).toBe(true)
        expect(mountedApp.text()).toContain('Integration Plan')

        const diagnostics = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
          .map((args) => args.map(String).join(' '))
          .join('\n')
        expect(diagnostics).not.toMatch(/capability .*not granted|\[settings\] reconcile failed/i)
      } finally {
        consoleError.mockRestore()
        consoleWarn.mockRestore()
        app?.unmount()
        manager.destroyInstance(handle.instanceId)
      }
    },
  )
})
