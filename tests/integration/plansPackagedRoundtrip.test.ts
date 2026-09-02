// @vitest-environment happy-dom
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'

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
  const invocations: Array<{ channel: string; payload: unknown }> = []
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
      invocations,
      setSender(id: number): void {
        senderId = id
      },
    },
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

// The production Plans build aliases this import to capabilityBackend. Mirror
// that build-time alias here so the mounted production component uses the real
// package SDK/IPC path instead of opening the core WebSocket client.
vi.doMock(resolve(process.cwd(), 'src/renderer/src/composables/useBackend.ts'), async () => {
  const plansBackend = await import('../../src/renderer/plugins/plans/capabilityBackend')
  return { useBackend: plansBackend.useBackend }
})

import * as electron from 'electron'
import {
  FrontendPluginManager,
  PLANS_PLUGIN_ID,
  type PluginLaunchDescriptor,
} from '../../src/main/plugins/frontendPluginManager'
import { PLANS_PLUGIN_REQUIRES } from '../../src/shared/pluginCapabilities'
import { createPluginBackendClient } from '@navide/plugin-sdk'

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
  const mountedApps: Array<{ unmount(): void }> = []

  afterEach(async () => {
    while (mountedApps.length) mountedApps.pop()!.unmount()
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

      const hostWindow = new FakeHostWindow()
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

      let resolveChanged!: (payload: unknown) => void
      const changed = new Promise<unknown>((resolve) => {
        resolveChanged = resolve
      })
      const sdkSubscription = createPluginBackendClient().subscribe(
        'plans.changed',
        resolveChanged,
      )
      await sdkSubscription.ready
      mock.invocations.length = 0
      // Settings reconciliation currently reports failures through warn while
      // capability plumbing can report errors, so monitor both channels.
      const consoleError = vi.spyOn(console, 'error')
      const consoleWarn = vi.spyOn(console, 'warn')
      try {
        const { default: PlanWindowApp } = await import('../../src/renderer/src/PlanWindowApp.vue')
        const app = mount(PlanWindowApp, {
          global: {
            plugins: [i18n],
            // The real PlanWindowApp is mounted. Only the unrelated terminal
            // surface is stubbed because xterm requires a native layout engine.
            stubs: {
              AiCliDock: true,
              PlanDocPreview: defineComponent({
                name: 'PlanDocPreview',
                props: ['workspacePath', 'relPath', 'backend', 'refresh'],
                setup(props) {
                  return () => h('div', {
                    class: 'integration-plan-preview',
                    'data-workspace-path': props.workspacePath,
                    'data-refresh': String(props.refresh),
                  })
                },
              }),
            },
          },
        })
        mountedApps.push(app)
        await flushPromises()
        expect(app.find('.plan-window').exists()).toBe(true)
        expect(mock.invocations).toContainEqual(expect.objectContaining({
          channel: 'plugin:backend:call',
          payload: expect.objectContaining({
            name: 'plans.resolve_root',
            args: { workspace_path: workspacePath },
          }),
        }))
        await expect(changed).resolves.toEqual({ workspace_path: expectedPlanRoot })
        await flushPromises()
        const preview = app.find('.integration-plan-preview')
        expect(preview.attributes('data-workspace-path')).toBe(expectedPlanRoot)
        expect(preview.attributes('data-refresh')).toBe('1')
        const diagnostics = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
          .map((args) => args.map(String).join(' '))
          .join('\n')
        expect(diagnostics).not.toMatch(/capability .*not granted|\[settings\] reconcile failed/i)
      } finally {
        consoleError.mockRestore()
        consoleWarn.mockRestore()
        sdkSubscription.dispose()
        manager.destroyInstance(handle.instanceId)
      }
    },
  )
})
