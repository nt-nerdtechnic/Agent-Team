// @vitest-environment happy-dom
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { manifestV2CapabilityPolicy } from '../../src/main/plugins/pluginPermissions'

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
      queueMicrotask(() => {
        if (this.readyState === FakeNodeWebSocket.CONNECTING) this.open()
      })
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
              : request.type === 'plans.ensure_assets'
                ? { ok: true }
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
      if (this.readyState === FakeNodeWebSocket.OPEN) return
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
import { createPlansWindowRouter } from '../../src/main/plansWindowRouting'
import { PLANS_PLUGIN_REQUIRES } from '../../src/shared/pluginCapabilities'
import {
  PluginBackendSupervisor,
  createAuthenticatedBackendRuntime,
  type BackendPluginLaunchSpec,
  type BackendRuntimeContext,
} from '../../src/main/plugins/pluginBackendSupervisor'
import {
  createProductionPlansBridgeDispatcher,
  createTestPlansFilesystemPort,
} from '../../src/main/plugins/plansBridge'

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

const productionBackend = join(
  process.cwd(),
  process.platform === 'win32'
    ? 'dist-plugins/navide-plans/backend/navide-plans.exe'
    : 'dist-plugins/navide-plans/backend/navide-plans',
)
const productionBackendEnabled =
  process.env.NAVIDE_TEST_PRODUCTION_PLANS_BACKEND === '1' ||
  process.env.NAVIDE_TEST_PRODUCTION_PLANS === '1'
if (productionBackendEnabled && !existsSync(productionBackend)) {
  throw new Error(
    `NAVIDE_TEST_PRODUCTION_PLANS_BACKEND=1 requires the production backend at ${productionBackend}; run pnpm run build:plans:backend first.`,
  )
}

const runProductionBackendTest = productionBackendEnabled ? it : it.skip

const packagedBackendEnvironment: Record<string, string> = {}
for (const key of ['TMPDIR', 'TEMP', 'TMP'] as const) {
  const value = process.env[key]
  if (typeof value === 'string' && value.length > 0) packagedBackendEnvironment[key] = value
}

describe('Plans packaged backend composition', () => {
  const managers: FrontendPluginManager[] = []
  const supervisors: PluginBackendSupervisor[] = []
  const originalArgv = [...process.argv]
  const originalWindow = (globalThis as unknown as { window?: unknown }).window
  const originalNav = (globalThis as unknown as { nav?: unknown }).nav
  const originalWindowNav = (window as unknown as { nav?: unknown }).nav
  const originalLocation = window.location.href
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()))
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
      const leftView = {
        id: 'left',
        contributionKey: `${PLANS_PLUGIN_ID}.left`,
        kind: 'custom' as const,
        location: 'left' as const,
        title: 'Plans',
        entryFile: join(expectedPlanRoot, 'src/renderer/plugins/plans/left.html'),
      }
      const windowView = {
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
        capabilityPolicy: {
          kind: 'manifest-v2',
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          grants: [],
        },
        devUrl: '',
        entryFile: leftView.entryFile,
        views: [leftView, windowView],
      }
      manager.registerDescriptor(descriptor, { builtin: true })
      manager.setCapabilityGrantResolver((pluginId, version) => {
        if (pluginId !== PLANS_PLUGIN_ID || version !== packageVersion) return null
        return {
          packageVersion,
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          storage: true,
        }
      })
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
      const openedWindows: Array<{ hostWindow: InstanceType<typeof electronMock.FakeHostWindow>; query: string }> = []
      const router = createPlansWindowRouter({
        frontendPluginManager: manager,
        openCatalogContributionWindow: async (contributionKey, targetWorkspacePath, extraParams) => {
          const standaloneHostWindow = new electronMock.FakeHostWindow()
          const query = new URLSearchParams({
            workspace_path: targetWorkspacePath,
            contribution: 'window',
            ...(extraParams ?? {}),
          }).toString()
          openedWindows.push({ hostWindow: standaloneHostWindow, query })
          return manager.openContributionWindow(standaloneHostWindow as never, contributionKey, {
            workspacePath: targetWorkspacePath,
            query: `?${query}`,
          })
        },
        migratePlansStorageState: async () => undefined,
        isPlansRecoveryEnabled: () => false,
        enterPlansRecovery: () => undefined,
        openLegacyPlanWindow: async () => undefined,
        warnMain: () => undefined,
      })
      manager.setOpenPlansWindowHandler((targetWorkspacePath, relPath) =>
        router.openPlanWindow(targetWorkspacePath, relPath),
      )
      manager.setPublicCapabilityHandler((plan) => manager.executePublicCapability(plan))
      const handle = await manager.openView(descriptor, leftView, {
        hostWindow: hostWindow as never,
        bounds: 'fill',
        workspacePath,
        capabilityContext: manager.plansCapabilityContext(packageVersion, workspacePath, leftView.id),
        query: `?workspace_path=${encodeURIComponent(workspacePath)}&contribution=left`,
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
        `/?workspace_path=${encodeURIComponent(workspacePath)}&contribution=left`,
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

        // A real left contribution uses the authenticated capability broker and
        // router to create a separate standalone Plans contribution.
        mock.invocations.length = 0
        await row.trigger('click')
        await flushPromises()

        expect(mock.invocations).toContainEqual(expect.objectContaining({
          channel: 'plugin:cap:call',
          payload: expect.objectContaining({
            ns: 'ui',
            method: 'openPlansWindow',
            args: { path: '.agent-team/plans/integration.html' },
          }),
        }))
        expect(openedWindows).toHaveLength(1)
        expect(openedWindows[0].hostWindow).not.toBe(hostWindow)
        expect(openedWindows[0].hostWindow.children).toHaveLength(1)
        const openedQuery = new URLSearchParams(openedWindows[0].query)
        expect(openedQuery.get('contribution')).toBe('window')
        expect(openedQuery.get('rel_path')).toBe('.agent-team/plans/integration.html')
        expect(mock.invocations).not.toContainEqual(expect.objectContaining({
          channel: 'plugin:cap:call',
          payload: expect.objectContaining({
            ns: 'ui',
            method: 'openInEditor',
          }),
        }))

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

  runProductionBackendTest(
    'launches the production Plans backend through descriptor/activation/supervisor and completes health and plans.list',
    async () => {
      const tempWorkspace = realpathSync(mkdtempSync(join(tmpdir(), 'navide-plans-packaged-workspace-')))
      const plansDir = join(tempWorkspace, '.agent-team', 'plans')
      mkdirSync(plansDir, { recursive: true })
      const planFile = join(plansDir, 'controlled-plan.html')
      const templateFile = join(plansDir, '_template.html')
      const planMeta = {
        schemaVersion: 1,
        name: 'Controlled Production Plan',
        overview: 'Self-contained integration test plan',
        stage: 'in-progress',
        todos: [
          { id: 't-1', title: 'First task', status: 'done' },
          { id: 't-2', title: 'Second task', status: 'in-progress' },
        ],
      }
      writeFileSync(
        planFile,
        `<!DOCTYPE html><html><head><script id="plan-meta" type="application/json">${JSON.stringify(planMeta)}</script></head><body><h1>Controlled Production Plan</h1></body></html>`,
        'utf8',
      )
      writeFileSync(
        templateFile,
        `<!DOCTYPE html><html><head><script id="plan-meta" type="application/json">{}</script></head><body><h1>{{PLAN_NAME}}</h1><p>{{ONE_SENTENCE_OVERVIEW}}</p><ul><li data-status="pending" data-todo-id="phase-a">Todos</li></ul></body></html>`,
        'utf8',
      )

      try {
        const manager = new FrontendPluginManager()
        managers.push(manager)
        const expectedPlanRoot = tempWorkspace
        const packageVersion = '0.1.0'
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
          capabilityPolicy: manifestV2CapabilityPolicy({
            system: ['fs', 'ui', 'aiCli'],
          }),
          devUrl: '',
          entryFile: view.entryFile,
          views: [view],
        }
        manager.registerDescriptor(descriptor, { builtin: true })
        manager.setBackendWsUrl('ws://plans-core-test')
        const filesystemPort = createTestPlansFilesystemPort()
        manager.configurePlansFilesystemService(filesystemPort)
        manager.setCapabilityGrantResolver((pluginId, version) => {
          if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
            return {
              packageVersion,
              system: ['fs', 'ui', 'aiCli'],
              storage: true,
            }
          }
          return null
        })
        let agentFsAllowed = true
        manager.setExecutionPolicyResolver((_workspacePath) => ({
          policy: {
            schemaVersion: 1,
            mode: 'allowlist',
            system: agentFsAllowed ? ['fs'] : [],
            shell: [],
          },
          revision: 1,
          state: 'user',
        }))

        const activation: BackendPluginLaunchSpec = {
          pluginId: descriptor.id,
          packageVersion,
          packageDir: expectedPlanRoot,
          entryFile: productionBackend,
          protocolVersion: 1,
          activation: 'startup',
          approvedMethods: [
            'plans.resolve_root',
            'plans.list',
            'plans.create',
            'plans.read',
            'plans.update_stage',
            'plans.update_todo',
            'plans.update_archive',
            'plans.delete',
            'fixture.echo',
          ],
          agentMethods: [
            'plans.list',
            'plans.create',
            'plans.read',
            'plans.update_stage',
            'plans.update_todo',
          ],
          approvedEvents: ['plans.changed'],
          approvedBridgePorts: ['filesystem'],
        }
        manager.registerBackendActivation(activation)

        expect(manager.getDescriptor(PLANS_PLUGIN_ID)).toBe(descriptor)
        expect(manager.hasBackendActivation(PLANS_PLUGIN_ID, packageVersion)).toBe(true)

        const supervisor = new PluginBackendSupervisor(activation, {
          environment: packagedBackendEnvironment,
          bridgeDispatcher: createProductionPlansBridgeDispatcher({
            filesystem: filesystemPort,
          }),
          authorizedPlanRoot: { value: expectedPlanRoot },
          resolveExecutionPolicy: (_runtime, workspacePath) => ({
            policy: {
              schemaVersion: 1,
              mode: 'allowlist',
              system: agentFsAllowed ? ['fs'] : [],
              shell: [],
            },
            revision: 1,
            state: 'user',
          }),
        })
        supervisors.push(supervisor)

        const health = await supervisor.start()
        expect(health).toMatchObject({
          value: {
            method: 'navide/health',
            protocolVersion: '2026-07-28',
            requestIdIsNonNull: true,
          },
          serverInfo: {
            name: 'navide.plans',
            version: '0.1.0',
          },
        })

        const runtime: BackendRuntimeContext = {
          pluginId: activation.pluginId,
          packageVersion: activation.packageVersion,
          workspaceId: 'workspace-prod-1',
          instanceId: 'instance-prod-1',
          contributionKey: `${PLANS_PLUGIN_ID}.window`,
          hostWindowId: 'window-prod-1',
          initiator: { kind: 'user', id: 'user-prod-1' },
        }
        const authenticatedRuntime = createAuthenticatedBackendRuntime(runtime)
        const client = supervisor.clientFor(authenticatedRuntime, {
          workspacePath: expectedPlanRoot,
          authorizedPlanRoot: expectedPlanRoot,
        })

        const rootResult = await client.call('plans.resolve_root', {
          workspace_path: expectedPlanRoot,
        })
        expect(rootResult).toEqual({ ok: true, root: expectedPlanRoot })

        const list = (await client.call('plans.list', {})) as Array<{
          rel_path: string
          name: string
          stage?: string
          overview?: string
          todos?: { total: number; by_status: Record<string, number> }
          mtime?: number
          kind: string
          meta?: { schemaVersion?: number; name?: string; stage?: string }
        }>

        expect(Array.isArray(list)).toBe(true)
        expect(list).toHaveLength(1)

        // Verify the production artifact is used rather than the dist-test-fixtures binary:
        // 1. Production artifact path verified:
        expect(activation.entryFile).toBe(productionBackend)
        expect(activation.entryFile).not.toBe(packagedFixture)
        expect(productionBackend).toContain('dist-plugins/navide-plans/backend')

        // 2. Production serverInfo version is 0.1.0, not fixture 0.1.92:
        expect(health.serverInfo?.version).toBe('0.1.0')
        expect(health.serverInfo?.version).not.toBe('0.1.92')

        // 3. The fixture returns a hardcoded mock 'Integration Plan' document;
        //    the production artifact invokes the real filesystem bridge and parses the controlled plan file:
        expect(list).not.toContainEqual(expect.objectContaining({ name: 'Integration Plan' }))
        expect(list[0]).toMatchObject({
          rel_path: '.agent-team/plans/controlled-plan.html',
          name: 'Controlled Production Plan',
          stage: 'in-progress',
          overview: 'Self-contained integration test plan',
          kind: 'plan',
          meta: planMeta,
          todos: {
            total: 2,
            by_status: {
              done: 1,
              'in-progress': 1,
            },
          },
          mtime: expect.any(Number),
        })

        // 4. Fixture wire-test methods (e.g. fixture.echo) do not exist in the production binary:
        await expect(client.call('fixture.echo', { value: 'probe' })).rejects.toMatchObject({
          code: 'PROTOCOL_ERROR',
        })

        // 5. Real Agent CRUD: exercise executeAgentBackendCallForWorkspace against production backend
        const createResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-create-1',
            name: 'plans.create',
            args: {
              name: 'Agent Real Plan',
              overview: 'Self-contained agent plan',
              stage: 'draft',
              todos: [{ id: 'step-1', content: 'First step' }],
            },
          },
        )
        expect(createResponse).toMatchObject({
          reqId: 'agent-create-1',
          ok: true,
          result: {
            rel_path: expect.stringMatching(/^\.agent-team\/plans\/agent-real-plan_[0-9a-f]{6}\.html$/),
            name: 'Agent Real Plan',
            stage: 'draft',
          },
        })
        const createdRelPath = (createResponse as { result: { rel_path: string } }).result.rel_path

        const readResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-read-1',
            name: 'plans.read',
            args: { rel_path: createdRelPath },
          },
        )
        expect(readResponse).toMatchObject({
          reqId: 'agent-read-1',
          ok: true,
          result: {
            rel_path: createdRelPath,
            meta: expect.objectContaining({
              name: 'Agent Real Plan',
              stage: 'draft',
              todos: [expect.objectContaining({ id: 'step-1', content: 'First step', status: 'pending' })],
            }),
          },
        })

        const updateStageResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-stage-1',
            name: 'plans.update_stage',
            args: { rel_path: createdRelPath, stage: 'approved' },
          },
        )
        expect(updateStageResponse).toMatchObject({
          reqId: 'agent-stage-1',
          ok: true,
          result: {
            stage: 'approved',
            approvedAt: expect.any(String),
          },
        })

        const updateTodoResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-todo-1',
            name: 'plans.update_todo',
            args: { rel_path: createdRelPath, todo_id: 'step-1', status: 'done' },
          },
        )
        expect(updateTodoResponse).toMatchObject({
          reqId: 'agent-todo-1',
          ok: true,
          result: expect.objectContaining({ id: 'step-1', status: 'done' }),
        })

        // 6. Execution Policy denial: deny fs capability, assert CAPABILITY_DENIED and zero disk modification
        agentFsAllowed = false
        const createdDiskPath = join(tempWorkspace, createdRelPath)
        const diskContentBeforeDenial = readFileSync(createdDiskPath, 'utf8')
        const diskMtimeBeforeDenial = statSync(createdDiskPath).mtimeMs

        const deniedResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-denied-1',
            name: 'plans.update_stage',
            args: { rel_path: createdRelPath, stage: 'done' },
          },
        )
        expect(deniedResponse).toMatchObject({
          reqId: 'agent-denied-1',
          ok: false,
          error: { code: 'CAPABILITY_DENIED' },
        })

        expect(readFileSync(createdDiskPath, 'utf8')).toBe(diskContentBeforeDenial)
        expect(statSync(createdDiskPath).mtimeMs).toBe(diskMtimeBeforeDenial)

        // 7. Manual/User operation: invoke preload/SDK plansBackend.call on the running instance
        // Confirm manual operation succeeds while agent execution policy denies
        const hostWindow = new electronMock.FakeHostWindow()
        const capabilityContext = manager.plansCapabilityContext(packageVersion, tempWorkspace, view.contributionKey)
        const handle = await manager.openView(descriptor, view, {
          hostWindow: hostWindow as never,
          bounds: 'fill',
          workspacePath: tempWorkspace,
          query: `?window=plans&workspace_path=${encodeURIComponent(tempWorkspace)}&rel_path=${encodeURIComponent(createdRelPath)}`,
          ...(capabilityContext ? { capabilityContext } : {}),
        })
        await manager.waitForBackendBinding(handle.instanceId)
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
        window.history.replaceState(
          {},
          '',
          `/?window=plans&workspace_path=${encodeURIComponent(tempWorkspace)}&rel_path=${encodeURIComponent(createdRelPath)}`,
        )
        Object.defineProperty(globalThis, 'window', { value: window, configurable: true })
        Object.defineProperty(window, 'nav', { value: nav, configurable: true })
        Object.defineProperty(globalThis, 'nav', { value: nav, configurable: true })

        const { plansBackend } = (await import('../../plugins/navide-plans/src/backend')) as {
          plansBackend: {
            call(name: string, args?: unknown): Promise<unknown>
          }
        }

        const manualResult = await plansBackend.call('plans.update_stage', {
          rel_path: createdRelPath,
          stage: 'done',
        })
        expect(manualResult).toMatchObject({ stage: 'done' })
        expect(readFileSync(createdDiskPath, 'utf8')).toMatch(/"stage":\s*"done"/)
        manager.destroyInstance(handle.instanceId)
      } finally {
        rmSync(tempWorkspace, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
