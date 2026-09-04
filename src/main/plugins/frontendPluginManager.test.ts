import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// The manager imports electron for its view lifecycle. A functional stub backs
// both the registry tests (which touch none of it) and the view-lifecycle tests
// below, which drive open/hide/resize/death paths against fakes. The factory
// exports its captured state as `__mock` (hoisted, so it must be self-contained).
vi.mock('electron', () => {
  type Handler = (...args: unknown[]) => unknown
  const ipcHandlers = new Map<string, Handler>()
  const ipcListeners = new Map<string, Handler>()
  const views: unknown[] = []
  const windows: unknown[] = []
  let nextWebContentsId = 1000

  class FakeWebContents {
    id = nextWebContentsId++
    sent: Array<{ channel: string; args: unknown[] }> = []
    loads: string[] = []
    focusCount = 0
    private destroyed = false
    private listeners = new Map<string, Handler[]>()
    isDestroyed(): boolean {
      return this.destroyed
    }
    send(channel: string, ...args: unknown[]): void {
      this.sent.push({ channel, args })
    }
    focus(): void {
      this.focusCount++
    }
    loadURL(url: string): Promise<void> {
      this.loads.push(url)
      return Promise.resolve()
    }
    loadFile(file: string, opts?: { search?: string }): Promise<void> {
      this.loads.push(`${file}${opts?.search ?? ''}`)
      return Promise.resolve()
    }
    on(event: string, cb: Handler): this {
      const list = this.listeners.get(event) ?? []
      list.push(cb)
      this.listeners.set(event, list)
      return this
    }
    once(event: string, cb: Handler): this {
      const wrapper: Handler = (...args) => {
        this.removeListener(event, wrapper)
        return cb(...args)
      }
      return this.on(event, wrapper)
    }
    removeListener(event: string, cb: Handler): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== cb)
      )
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
    }
    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('destroyed')
    }
  }

  class WebContentsView {
    webContents = new FakeWebContents()
    bounds: unknown = null
    visible = false
    constructor(_opts?: unknown) {
      views.push(this)
    }
    setBounds(b: unknown): void {
      this.bounds = b
    }
    setVisible(v: boolean): void {
      this.visible = v
    }
  }

  // Constructed by the manager for dedicated plugin host windows (mini-IDE).
  class BrowserWindow {
    options: Record<string, unknown>
    title: string
    destroyed = false
    minimized = false
    shown = false
    focusCount = 0
    contentBounds = { x: 0, y: 0, width: 1000, height: 700 }
    children: unknown[] = []
    private listeners = new Map<string, Handler[]>()
    contentView = {
      addChildView: (v: unknown): void => {
        this.children.push(v)
      },
      removeChildView: (v: unknown): void => {
        this.children = this.children.filter((c) => c !== v)
      },
    }
    constructor(options?: Record<string, unknown>) {
      this.options = options ?? {}
      this.title = String(options?.title ?? '')
      windows.push(this)
    }
    setTitle(t: string): void {
      this.title = t
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    isMinimized(): boolean {
      return this.minimized
    }
    restore(): void {
      this.minimized = false
    }
    show(): void {
      this.shown = true
    }
    focus(): void {
      this.focusCount++
    }
    getContentBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.contentBounds }
    }
    on(event: string, cb: Handler): this {
      const list = this.listeners.get(event) ?? []
      list.push(cb)
      this.listeners.set(event, list)
      return this
    }
    once(event: string, cb: Handler): this {
      const wrapper: Handler = (...args) => {
        this.removeListener(event, wrapper)
        return cb(...args)
      }
      return this.on(event, wrapper)
    }
    removeListener(event: string, cb: Handler): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== cb)
      )
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
    }
    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
  }

  const ipcMain = {
    handle: (channel: string, fn: Handler): void => {
      ipcHandlers.set(channel, fn)
    },
    on: (channel: string, fn: Handler): void => {
      ipcListeners.set(channel, fn)
    },
  }

  return {
    WebContentsView,
    BrowserWindow,
    ipcMain,
    app: {},
    __mock: { ipcHandlers, ipcListeners, views, windows },
  }
})

const wsMock = vi.hoisted(() => {
  class FakeNodeWebSocket {
    static readonly OPEN = 1
    static readonly CONNECTING = 0
    static readonly CLOSED = 3
    static instances: FakeNodeWebSocket[] = []
    readonly url: string
    readonly sent: string[] = []
    readyState = FakeNodeWebSocket.CONNECTING
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>()

    constructor(url: string) {
      this.url = url
      FakeNodeWebSocket.instances.push(this)
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? []
      listeners.push(listener)
      this.listeners.set(type, listeners)
    }

    send(data: string): void {
      this.sent.push(data)
    }

    close(): void {
      this.readyState = FakeNodeWebSocket.CLOSED
      this.emit('close', {})
    }

    open(): void {
      this.readyState = FakeNodeWebSocket.OPEN
      this.emit('open', {})
    }

    receive(message: unknown): void {
      this.emit('message', { data: JSON.stringify(message) })
    }

    private emit(type: string, event: unknown): void {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    }
  }

  return { FakeNodeWebSocket }
})

vi.mock('ws', () => ({ WebSocket: wsMock.FakeNodeWebSocket }))

import * as electron from 'electron'
import type { BrowserWindow } from 'electron'
import {
  FrontendPluginManager,
  frontendPluginManager,
  isReservedPluginId,
  devPlansPluginDescriptor,
  openMiniIdePluginView,
  openPlansPluginView,
  plansQuery,
  openGitLeftPluginView,
  closeGitLeftPluginView,
  GIT_PLUGIN_ID,
  PLANS_PLUGIN_ID,
  MINI_IDE_PLUGIN_ID,
  bundledMiniIdeDir,
  registerBundledMiniIde,
  registerBundledPlans,
  createPluginBackendChildEnvironment,
  sanitizeDiagnosticLines,
  MAX_DIAGNOSTIC_LINE_CHARS,
  MAX_DIAGNOSTIC_LINES_PER_EMISSION,
  type PluginLaunchDescriptor,
} from './frontendPluginManager'
import { PluginBackendHost } from './pluginBackendHost'
import { BackendPluginError } from './pluginBackendSupervisor'
import type { PlansBridgeContext } from './plansBridge'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import {
  HOST_EVENT_SOURCE_PLUGIN_ID,
  type HostCapabilityContext,
  type StorageSnapshotTier,
} from './pluginCapabilityBroker'
import { PluginStorageError } from './pluginStorage'
import type { ExecutionPolicySnapshot } from './executionPolicy'

interface FakeWebContentsLike {
  id: number
  sent: Array<{ channel: string; args: unknown[] }>
  loads: string[]
  focusCount: number
  isDestroyed(): boolean
  focus(): void
  emit(event: string, ...args: unknown[]): void
  close(): void
}
interface FakeViewLike {
  webContents: FakeWebContentsLike
  bounds: { x: number; y: number; width: number; height: number } | null
  visible: boolean
}
interface FakeWindowLike {
  options: Record<string, unknown>
  title: string
  destroyed: boolean
  minimized: boolean
  shown: boolean
  focusCount: number
  children: unknown[]
  isDestroyed(): boolean
  close(): void
  emit(event: string, ...args: unknown[]): void
}
const { ipcHandlers, ipcListeners, views, windows } = (
  electron as unknown as {
    __mock: {
      ipcHandlers: Map<string, (...args: unknown[]) => unknown>
      ipcListeners: Map<string, (...args: unknown[]) => unknown>
      views: FakeViewLike[]
      windows: FakeWindowLike[]
    }
  }
).__mock

/** Host-window fake with just the surface the manager touches. */
class FakeBrowserWindow {
  title = ''
  destroyed = false
  minimized = false
  shown = false
  focusCount = 0
  contentBounds = { x: 0, y: 0, width: 1000, height: 700 }
  children: unknown[] = []
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  contentView = {
    addChildView: (v: unknown): void => {
      this.children.push(v)
    },
    removeChildView: (v: unknown): void => {
      this.children = this.children.filter((c) => c !== v)
    },
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  restore(): void {
    this.minimized = false
  }
  show(): void {
    this.shown = true
  }
  focus(): void {
    this.focusCount++
  }
  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.contentBounds }
  }
  setTitle(t: string): void {
    this.title = t
  }
  on(event: string, cb: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
    return this
  }
  once(event: string, cb: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.removeListener(event, wrapper)
      cb(...args)
    }
    return this.on(event, wrapper)
  }
  removeListener(event: string, cb: (...args: unknown[]) => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((l) => l !== cb)
    )
    return this
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
  }
}

function asHost(win: FakeBrowserWindow): BrowserWindow {
  return win as unknown as BrowserWindow
}

function descriptor(id: string): PluginLaunchDescriptor {
  return { id, requires: [], devUrl: '', entryFile: `/plugins/${id}/index.html` }
}

describe('backend Host session registration', () => {
  it('re-registers on the new socket when the previous registration is pending', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    mgr.open(
      asHost(host),
      { id: 'acme.host-session', requires: ['terminal'], devUrl: '', entryFile: '/plugins/acme.host-session/index.html' },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl('ws://backend-old')
    const oldSocket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    oldSocket.open()
    expect(oldSocket.sent.map((raw) => JSON.parse(raw).type)).toContain('host.register')
    expect(JSON.parse(oldSocket.sent[0]!).payload).toMatchObject({
      features: { plans_backend_v2: false },
    })

    mgr.setBackendWsUrl('ws://backend-new')
    const newSocket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    newSocket.open()

    expect(newSocket.sent.map((raw) => JSON.parse(raw).type)).toContain('host.register')
  })

  it('advertises Plans support only after its exact v2 backend activation is registered', () => {
    const mgr = new FrontendPluginManager()
    mgr.open(
      asHost(new FakeBrowserWindow()),
      { id: 'acme.host-session-plans', requires: ['terminal'], devUrl: '', entryFile: '/plugins/acme.host-session-plans/index.html' },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion: '1.0.0',
      packageDir: process.cwd(),
      requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '',
      entryFile: '/plugins/navide.plans/index.html',
      views: [],
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion: '1.0.0',
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: '1.0.0',
      system: ['fs'],
      storage: true,
    }))
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl('ws://backend-plans')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()

    const registration = socket.sent
      .map((raw) => JSON.parse(raw) as { type?: string; payload?: unknown })
      .find((message) => message.type === 'host.register')
    expect(registration?.payload).toMatchObject({
      features: { plans_backend_v2: true },
    })
  })

  it('withdraws Plans support after an unavailable child is observed', () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '',
      entryFile: '/plugins/navide.plans/index.html',
      views: [],
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion,
      system: ['fs'],
      storage: true,
    }))

    expect(mgr.isPlansBackendAvailable()).toBe(true)
    mgr.markPlansBackendUnavailable('child-crash')
    expect(mgr.isPlansBackendAvailable()).toBe(false)
  })
})

describe('createPluginBackendChildEnvironment', () => {
  it('keeps only the temporary-directory variables needed by packaged backends', () => {
    vi.stubEnv('TMPDIR', '/tmp/navide-plugin-backend')
    vi.stubEnv('TEMP', 'C:\\Users\\test\\AppData\\Local\\Temp')
    vi.stubEnv('TMP', 'C:\\Users\\test\\AppData\\Local\\Temp')
    vi.stubEnv('PATH', 'host-path-must-not-cross-boundary')

    try {
      expect(createPluginBackendChildEnvironment()).toEqual({
        TMPDIR: '/tmp/navide-plugin-backend',
        TEMP: 'C:\\Users\\test\\AppData\\Local\\Temp',
        TMP: 'C:\\Users\\test\\AppData\\Local\\Temp',
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('isReservedPluginId', () => {
  it('flags first-party and internal Host identities, not third-party ids', () => {
    expect(isReservedPluginId('navide.mini-ide')).toBe(true)
    expect(isReservedPluginId('navide.noop')).toBe(true)
    expect(isReservedPluginId('navide.plans')).toBe(true)
    expect(isReservedPluginId(HOST_EVENT_SOURCE_PLUGIN_ID)).toBe(true)
    expect(isReservedPluginId('acme.demo')).toBe(false)
  })
})

describe('plansCapabilityContext', () => {
  it('fails closed until the exact package-version grant is available', () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '2.0.0'
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/index.html',
      views: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs', 'ui', 'aiCli'] }),
    }, { builtin: true })

    expect(mgr.plansCapabilityContext(packageVersion, process.cwd())).toBeNull()

    const grant = {
      packageVersion,
      system: ['fs', 'ui', 'aiCli'] as const,
      storage: true,
    }
    mgr.setCapabilityGrantResolver(() => grant)

    expect(mgr.plansCapabilityContext(packageVersion, process.cwd())).toMatchObject({
      publisherEligible: true,
      userGrant: grant,
      runtimeBinding: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        audience: 'plans-window',
      },
    })
    expect(mgr.plansCapabilityContext('2.0.1', process.cwd())).toBeNull()
  })

  it('requires filesystem permission in both the Manifest policy and the Grant', () => {
    const policyWithoutFs = new FrontendPluginManager()
    policyWithoutFs.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion: '2.0.0',
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/index.html',
      views: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['ui'] }),
    }, { builtin: true })
    policyWithoutFs.setCapabilityGrantResolver(() => ({
      packageVersion: '2.0.0',
      system: ['ui'],
      storage: true,
    }))
    expect(policyWithoutFs.plansCapabilityContext('2.0.0', process.cwd())).toBeNull()

    const grantWithoutFs = new FrontendPluginManager()
    grantWithoutFs.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion: '2.0.0',
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/index.html',
      views: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs', 'ui'] }),
    }, { builtin: true })
    grantWithoutFs.setCapabilityGrantResolver(() => ({
      packageVersion: '2.0.0',
      system: ['ui'],
      storage: true,
    }))
    expect(grantWithoutFs.plansCapabilityContext('2.0.0', process.cwd())).toBeNull()
  })

  it('does not bind a v2 Plans view when the matched policy and Grant omit fs', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '2.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['ui'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['ui'] }),
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion, system: ['ui'], storage: true },
      runtimeBinding: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        workspaceId: mgr.workspaceIdForPath('/workspace'),
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView')
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        capabilityContext: context,
      })
      expect(bind).not.toHaveBeenCalled()
      mgr.destroyInstance(handle.instanceId)
    } finally {
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })
})

describe('Plans private filesystem grant revalidation', () => {
  it('denies a revoked Grant before the filesystem service can be called', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '2.0.0'
    const workspacePath = process.cwd()
    const grant = {
      packageVersion,
      system: ['fs'] as const,
      storage: true,
    }
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
      views: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    let activeGrant: typeof grant | null = grant
    mgr.setCapabilityGrantResolver(() => activeGrant)
    const service = vi
      .spyOn(
        mgr as unknown as {
          sendPublicBackend: (
            wsType: string,
            payload: Record<string, unknown>,
            beforeDispatch?: () => boolean,
          ) => Promise<unknown>
        },
        'sendPublicBackend',
      )
      .mockResolvedValue({ content: 'draft' })
    const internals = mgr as unknown as {
      sendPlansFilesystemService: (
        operation: string,
        payload: Record<string, unknown>,
        context: PlansBridgeContext,
      ) => Promise<unknown>
    }
    const context: PlansBridgeContext = {
      runtime: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        workspaceId: mgr.workspaceIdForPath(workspacePath),
        instanceId: 'plans-view-1',
        contributionKey: 'navide.plans.window',
        hostWindowId: 'window-1',
        initiator: { kind: 'user', id: 'user-1' },
      },
      workspacePath,
      authorizedPlanRoot: workspacePath,
      requestId: 'bridge-test-1',
      signal: new AbortController().signal,
      emit: () => undefined,
    }
    try {
      await expect(internals.sendPlansFilesystemService(
        'fs.read_file',
        { rel_path: 'draft.html' },
        context,
      )).resolves.toEqual({ content: 'draft' })
      expect(service).toHaveBeenCalledOnce()

      activeGrant = null
      await expect(internals.sendPlansFilesystemService(
        'fs.read_file',
        { rel_path: 'draft.html' },
        context,
      )).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      expect(service).toHaveBeenCalledOnce()
    } finally {
      service.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })
})

describe('devPlansPluginDescriptor', () => {
  it('describes the navide.plans dev bundle with the plans-only event grant', () => {
    const desc = devPlansPluginDescriptor()
    expect(desc.id).toBe(PLANS_PLUGIN_ID)
    expect(desc.id).toBe('navide.plans')
    expect(desc.requires).toEqual(['fs', 'ui', 'plans', 'terminal'])
    // Built separately (vite.plans.config.ts) — never served by the dev server.
    expect(desc.devUrl).toBe('')
    expect(desc.entryFile.endsWith('dist-plugins/plans/index.html')).toBe(true)
  })

  it('registers only via the builtin/official path (reserved id)', () => {
    const mgr = new FrontendPluginManager()
    expect(() => mgr.registerDescriptor(devPlansPluginDescriptor())).toThrow(/reserved/)
    expect(() =>
      mgr.registerDescriptor(devPlansPluginDescriptor(), { builtin: true })
    ).not.toThrow()
    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)?.id).toBe('navide.plans')
  })

  it('keeps fixed Host development bundles out of explicit-package inventory', () => {
    const mgr = new FrontendPluginManager()
    mgr.registerDeveloperDescriptor(devPlansPluginDescriptor())
    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)?.id).toBe(PLANS_PLUGIN_ID)
    expect(mgr.listInstalledPackages()).toEqual([])
  })

  it('registers the bundled Plans frontend without activating a backend fixture', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bundle-'))
    try {
      const dir = join(root, 'dist-plugins', 'plans')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({ id: PLANS_PLUGIN_ID, version: '0.1.92', entry: 'index.html', requires: [] }),
      )
      writeFileSync(join(dir, 'index.html'), '<!doctype html>')

      const mgr = new FrontendPluginManager()
      expect(registerBundledPlans(mgr, {
        isPackaged: false,
        resourcesPath: '',
        devRoot: root,
      })).toEqual({ registered: true })
      expect(mgr.getDescriptor(PLANS_PLUGIN_ID)?.packageVersion).toBeUndefined()
      expect(mgr.hasBackendActivity()).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('registers the already-verified installed Plans backend before bundled fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-installed-'))
    const packageDir = join(root, 'navide.plans')
    const backendEntry = join(packageDir, 'backend', 'navide-plans')
    try {
      mkdirSync(join(packageDir, 'frontend'), { recursive: true })
      mkdirSync(join(packageDir, 'backend'), { recursive: true })
      writeFileSync(join(packageDir, 'frontend', 'index.html'), '<!doctype html>')
      writeFileSync(join(packageDir, 'frontend', 'left.html'), '<!doctype html>')
      writeFileSync(backendEntry, '#!/bin/sh\n')
      chmodSync(backendEntry, 0o700)
      const canonicalPackageDir = realpathSync(packageDir)
      const packageVersion = '2.0.0'
      const mgr = new FrontendPluginManager()
      mgr.registerDescriptor(
        {
          id: PLANS_PLUGIN_ID,
          packageVersion,
          packageDir: canonicalPackageDir,
          requires: [],
          devUrl: '',
          entryFile: join(packageDir, 'frontend', 'index.html'),
          views: [
            {
              id: 'left',
              contributionKey: `${PLANS_PLUGIN_ID}.left`,
              kind: 'custom',
              location: 'left',
              title: 'Plans',
              entryFile: join(packageDir, 'frontend', 'left.html'),
            },
            {
              id: 'window',
              contributionKey: `${PLANS_PLUGIN_ID}.window`,
              kind: 'custom',
              location: 'window',
              title: 'Plans',
              entryFile: join(packageDir, 'frontend', 'index.html'),
            },
          ],
          capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs', 'ui'] }),
        },
        { official: true },
      )

      expect(registerBundledPlans(mgr, {
        isPackaged: false,
        resourcesPath: '',
        devRoot: join(root, 'no-bundled-copy'),
        installedActivation: {
          pluginId: PLANS_PLUGIN_ID,
          packageVersion,
          packageDir: canonicalPackageDir,
          views: [],
          backend: { entryFile: backendEntry, protocolVersion: 1, activation: 'startup' },
          provenance: 'official-registry',
          artifactDigest: 'ab'.repeat(32),
        },
      })).toEqual({ registered: true })
      expect(mgr.hasBackendActivation(PLANS_PLUGIN_ID, packageVersion)).toBe(true)
      await mgr.closeBackendPlugins()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a backend activation before its selected package descriptor exists', () => {
    const mgr = new FrontendPluginManager()

    expect(() => mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion: '1.0.0',
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_ACTIVATION',
      message: 'Backend activation has no selected package descriptor.',
    }))
    expect(mgr.hasBackendActivity()).toBe(false)
  })

  it('rejects a backend activation whose package root is not the selected descriptor root', () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: '/plugins/navide.plans/index.html',
      views: [],
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })

    expect(() => mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: join(process.cwd(), 'src'),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_ACTIVATION' }))
  })

  it('rejects and tears down a Plans view when backend binding fails', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion, system: ['fs'], storage: true },
      runtimeBinding: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        workspaceId: 'bound-workspace',
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      capabilityContext: context,
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion,
      system: ['fs'],
      storage: true,
    }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView').mockImplementation(() => {
      throw new Error('binding race')
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const host = new FakeBrowserWindow()
    try {
      await expect(mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
        capabilityContext: context,
      })).rejects.toThrow('binding race')

      expect((mgr as unknown as { running: Map<string, unknown> }).running.size).toBe(0)
      expect(bind).toHaveBeenCalledOnce()
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('could not bind'))
    } finally {
      warning.mockRestore()
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('rejects a package Plans call whose workspace path is not sender-bound', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion, system: ['fs'], storage: true },
      runtimeBinding: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        workspaceId: 'bound-workspace',
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      capabilityContext: context,
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion,
      system: ['fs'],
      storage: true,
    }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView').mockResolvedValue()
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call')
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
        capabilityContext: context,
      })
      const webContents = (host.children[0] as FakeViewLike).webContents
      const invalidTimeout = await ipcHandlers.get('plugin:backend:call')?.(
        { sender: { id: webContents.id } },
        {
          reqId: 'invalid-timeout-1',
          name: 'plans.resolve_root',
          args: { workspace_path: '/workspace' },
          timeoutMs: 0,
        },
      )
      expect(invalidTimeout).toMatchObject({
        reqId: 'invalid-timeout-1',
        ok: false,
        error: { code: 'INVALID_ARGUMENT' },
      })
      expect(hostCall).not.toHaveBeenCalled()
      const response = await ipcHandlers.get('plugin:backend:call')?.(
        { sender: { id: webContents.id } },
        {
          reqId: 'scope-1',
          name: 'plans.resolve_root',
          args: { workspace_path: '/other-workspace' },
        },
      )

      expect(response).toMatchObject({
        reqId: 'scope-1',
        ok: false,
        error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
      })
      expect(hostCall).not.toHaveBeenCalled()
      mgr.destroyInstance(handle.instanceId)
    } finally {
      bind.mockRestore()
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('applies the sender-bound workspace scope to agent Plans calls', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockResolvedValue(null)
    const host = new FakeBrowserWindow()

    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
      })
      const running = (mgr as unknown as {
        running: Map<string, { backendWorkspaceId: string | null }>
      }).running.get(handle.instanceId)
      expect(running).toBeDefined()
      running!.backendWorkspaceId = createHash('sha256').update(resolve('/workspace')).digest('hex')

      const response = await mgr.executeAgentBackendCall(handle.instanceId, {
        reqId: 'agent-scope-1',
        name: 'plans.resolve_root',
        args: { workspace_path: '/other-workspace' },
      })

      expect(response).toMatchObject({
        reqId: 'agent-scope-1',
        ok: false,
        error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
      })
      expect(hostCall).not.toHaveBeenCalled()
      mgr.destroyInstance(handle.instanceId)
    } finally {
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('requires the v2 Manifest context and package grant before an agent backend call', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.agent-backend'
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'main',
      contributionKey: `${pluginId}.main`,
      kind: 'custom',
      location: 'main',
      title: 'Agent backend',
      entryFile: '/plugins/acme.agent-backend/index.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: pluginId,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(descriptor)
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockResolvedValue(null)
    const host = new FakeBrowserWindow()

    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
      })

      await expect(mgr.executeAgentBackendCall(handle.instanceId, {
        reqId: 'agent-backend-context-1',
        name: 'fixture.echo',
        args: null,
      })).resolves.toMatchObject({
        reqId: 'agent-backend-context-1',
        ok: false,
        error: { code: 'CAPABILITY_DENIED' },
      })
      expect(hostCall).not.toHaveBeenCalled()
      mgr.destroyInstance(handle.instanceId)
    } finally {
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('maps a Host resource limit to the stable IPC error code', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockRejectedValue(
      new BackendPluginError('RESOURCE_LIMIT'),
    )
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
      })
      const webContents = (host.children[0] as FakeViewLike).webContents
      const response = await ipcHandlers.get('plugin:backend:call')?.(
        { sender: { id: webContents.id } },
        {
          reqId: 'resource-limit-1',
          name: 'plans.resolve_root',
          args: { workspace_path: '/workspace' },
        },
      )

      expect(response).toMatchObject({
        reqId: 'resource-limit-1',
        ok: false,
        error: { code: 'RESOURCE_LIMIT' },
      })
      mgr.destroyInstance(handle.instanceId)
    } finally {
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('preserves generic BACKEND_UNAVAILABLE semantics for renderer and fallback while emitting host-only diagnostics on startup failure', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: packageDescriptor.id,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })

    const spawnError = new Error('spawn /private/opt/plans ENOENT')
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockRejectedValue(
      new BackendPluginError('BACKEND_UNAVAILABLE', undefined, { cause: spawnError }),
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failureHandler = vi.fn()
    mgr.setPlansBackendFailureHandler(failureHandler)

    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
      })
      const webContents = (host.children[0] as FakeViewLike).webContents
      const response = await ipcHandlers.get('plugin:backend:call')?.(
        { sender: { id: webContents.id } },
        {
          reqId: 'call-unavailable-1',
          name: 'plans.resolve_root',
          args: { workspace_path: '/workspace' },
        },
      )

      expect(response).toEqual({
        reqId: 'call-unavailable-1',
        ok: false,
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message: 'Backend plugin is unavailable.',
        },
      })
      expect(JSON.stringify(response)).not.toContain('/private/opt/plans')

      // Simulate child failure callback to verify host-private diagnostic logging and fallback
      const hostInstance = (mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost
      const onStderr = (hostInstance as unknown as { onStderr?: (chunk: string) => void }).onStderr
      onStderr?.('test child stderr\n')
      expect(warnSpy).toHaveBeenCalledWith('[plugin-backend] test child stderr')

      const onBackendFailure = (hostInstance as unknown as { onBackendFailure?: (runtime: unknown, error: unknown) => void }).onBackendFailure
      onBackendFailure?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId: handle.instanceId },
        new BackendPluginError('BACKEND_UNAVAILABLE', undefined, { cause: spawnError }),
      )

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[plugin-backend] Backend child failure for navide.plans:'),
      )
      expect(failureHandler).toHaveBeenCalledWith(expect.objectContaining({
        instanceId: handle.instanceId,
        reason: 'Backend plugin is unavailable.',
      }))
      expect(failureHandler.mock.calls[0][0].reason).not.toContain('/private/opt/plans')

      mgr.destroyInstance(handle.instanceId)
    } finally {
      warnSpy.mockRestore()
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('sanitizes package-child stderr with control sequences and newlines, emitting each retained line with trusted host prefix and bounded retention', () => {
    const raw = '\x1b[31;1mfatal:\x1b[0m failed to load /internal/path/lib.so\x1b]0;title\x07\r\n\x00\x082026-09-03T12:00:00.000Z [auth] spoofed admin login\r\nline 3\r'
    const lines = sanitizeDiagnosticLines(raw)
    expect(lines).toEqual([
      'fatal: failed to load /internal/path/lib.so',
      '2026-09-03T12:00:00.000Z [auth] spoofed admin login',
      'line 3',
    ])

    // Verify line length bounding
    const longLine = 'a'.repeat(MAX_DIAGNOSTIC_LINE_CHARS + 50)
    const truncatedLine = sanitizeDiagnosticLines(longLine)
    expect(truncatedLine[0]).toHaveLength(MAX_DIAGNOSTIC_LINE_CHARS + '... [line truncated]'.length)
    expect(truncatedLine[0]).toContain('... [line truncated]')

    // Verify line count bounding
    const manyLines = Array.from({ length: MAX_DIAGNOSTIC_LINES_PER_EMISSION + 20 }, (_, i) => `line ${i}`).join('\n')
    const truncatedLines = sanitizeDiagnosticLines(manyLines)
    expect(truncatedLines).toHaveLength(MAX_DIAGNOSTIC_LINES_PER_EMISSION + 1)
    expect(truncatedLines[truncatedLines.length - 1]).toBe('... [diagnostic lines truncated]')

    // Verify emission via FrontendPluginManager onStderr
    const mgr = new FrontendPluginManager()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const hostInstance = (mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost
      const onStderr = (hostInstance as unknown as { onStderr?: (chunk: string) => void }).onStderr
      onStderr?.(raw)

      expect(warnSpy).toHaveBeenCalledTimes(3)
      for (const call of warnSpy.mock.calls) {
        expect(call[0]).toMatch(/^\[plugin-backend\] /)
        expect(call[0]).not.toContain('\x1b')
        expect(call[0]).not.toContain('\r')
        expect(call[0]).not.toContain('\n')
      }
      expect(warnSpy).toHaveBeenNthCalledWith(1, '[plugin-backend] fatal: failed to load /internal/path/lib.so')
      expect(warnSpy).toHaveBeenNthCalledWith(2, '[plugin-backend] 2026-09-03T12:00:00.000Z [auth] spoofed admin login')
      expect(warnSpy).toHaveBeenNthCalledWith(3, '[plugin-backend] line 3')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('sanitizes package-child failure cause and avoids duplicate full stack/cause entries in host diagnostics', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: packageDescriptor.id,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })

    const pathLikeError = new Error('spawn /custom/private/plans/start ENOENT\x1b[31m\x07\r\n    at Object.spawnProcess (test.ts:1:1)')
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockRejectedValue(
      new BackendPluginError('BACKEND_UNAVAILABLE', undefined, { cause: pathLikeError }),
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failureHandler = vi.fn()
    mgr.setPlansBackendFailureHandler(failureHandler)

    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
      })

      // Simulate onBackendFailure with path-like cause
      const hostInstance = (mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost
      const onBackendFailure = (hostInstance as unknown as { onBackendFailure?: (runtime: unknown, error: unknown) => void }).onBackendFailure
      const backendError = new BackendPluginError('BACKEND_UNAVAILABLE', undefined, { cause: pathLikeError })
      onBackendFailure?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId: handle.instanceId },
        backendError,
      )

      // Verified failure was logged with trusted prefix on each line, without ANSI or CR injection
      const failureCalls = warnSpy.mock.calls.filter(([arg]) => String(arg).includes('Backend child failure'))
      expect(failureCalls.length).toBeGreaterThanOrEqual(1)
      for (const call of warnSpy.mock.calls) {
        expect(call[0]).toMatch(/^\[plugin-backend\] /)
        expect(call[0]).not.toContain('\x1b')
        expect(call[0]).not.toContain('\r')
      }

      // Now verify that if another failure handler or view-bind catch runs with the same backendError,
      // it avoids duplicate full stack/cause entries
      const callCountBefore = warnSpy.mock.calls.length
      onBackendFailure?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId: handle.instanceId },
        backendError,
      )
      expect(warnSpy.mock.calls.length).toBe(callCountBefore)

      // Recovery payload stays generic and does not leak the path-like cause
      expect(failureHandler).toHaveBeenCalledWith(expect.objectContaining({
        instanceId: handle.instanceId,
        reason: 'Backend plugin is unavailable.',
      }))
      expect(failureHandler.mock.calls[0][0].reason).not.toContain('/custom/private/plans')

      mgr.destroyInstance(handle.instanceId)
    } finally {
      warnSpy.mockRestore()
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })
})

describe('production Plans agent backend routing', () => {
  it('denies non-allowlisted methods before binding and preserves the minted agent Initiator', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
      views: [],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list', 'plans.create', 'plans.delete'],
      agentMethods: ['plans.list', 'plans.create'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion,
      system: ['fs'],
      storage: true,
    }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace').mockResolvedValue('headless-plans-1')
    const call = vi.spyOn(PluginBackendHost.prototype, 'call').mockResolvedValue({
      rel_path: '.agent-team/plans/agent-plan.html',
    } as never)
    const provision = vi
      .spyOn(
        mgr as unknown as { provisionPlansAssets: (workspacePath: string) => Promise<boolean> },
        'provisionPlansAssets',
      )
      .mockResolvedValue(true)

    try {
      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        '/workspace',
        { reqId: 'agent-denied-1', name: 'plans.delete', args: { rel_path: 'plan.html' } },
      )).resolves.toMatchObject({
        reqId: 'agent-denied-1',
        ok: false,
        error: { code: 'CAPABILITY_DENIED' },
      })
      expect(bind).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()

      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        '/workspace',
        {
          reqId: 'agent-create-1',
          name: 'plans.create',
          args: { name: 'Agent plan', overview: '', todos: [] },
        },
      )).resolves.toEqual({
        reqId: 'agent-create-1',
        ok: true,
        result: { rel_path: '.agent-team/plans/agent-plan.html' },
      })
      expect(bind).toHaveBeenCalledOnce()
      expect(call).toHaveBeenCalledWith(
        'headless-plans-1',
        'plans.create',
        { name: 'Agent plan', overview: '', todos: [] },
        { initiator: expect.objectContaining({ kind: 'agent', source: 'mcp' }) },
      )

      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        '/workspace',
        { reqId: 'agent-list-1', name: 'plans.list', args: {} },
      )).resolves.toMatchObject({ reqId: 'agent-list-1', ok: true })
      expect(bind).toHaveBeenCalledOnce()

      call.mockRejectedValueOnce(new BackendPluginError(
        'PLUGIN_ERROR',
        'child denied',
        { pluginCode: 'CAPABILITY_DENIED' },
      ))
      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        '/workspace',
        { reqId: 'agent-denied-child-1', name: 'plans.list', args: {} },
      )).resolves.toMatchObject({
        reqId: 'agent-denied-child-1',
        ok: false,
        error: { code: 'CAPABILITY_DENIED' },
      })
    } finally {
      provision.mockRestore()
      call.mockRestore()
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('denies the headless route when the exact package Grant is missing', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
      views: [],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.create'],
      agentMethods: ['plans.create'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace')
    try {
      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        '/workspace',
        {
          reqId: 'agent-no-grant-1',
          name: 'plans.create',
          args: { name: 'Denied plan', overview: '', todos: [] },
        },
      )).resolves.toMatchObject({
        reqId: 'agent-no-grant-1',
        ok: false,
        error: { code: 'CAPABILITY_DENIED' },
      })
      expect(bind).not.toHaveBeenCalled()
    } finally {
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })
})

describe('package-version grant revocation', () => {
  it('disables and destroys only the revoked package version', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.revocable'
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${pluginId}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Revocable',
      entryFile: '/plugins/acme.revocable/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: null,
      runtimeBinding: {
        pluginId,
        packageVersion,
        workspaceId: 'workspace-1',
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    const descriptor: PluginLaunchDescriptor = {
      id: pluginId,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityContext: context,
    }
    mgr.registerDescriptor(descriptor)
    const revoke = vi
      .spyOn(PluginBackendHost.prototype, 'revokePackageVersion')
      .mockResolvedValue()
    const host = new FakeBrowserWindow()

    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        capabilityContext: context,
      })
      const surface = host.children[0] as FakeViewLike

      await mgr.revokePackageVersion(pluginId, packageVersion)

      expect(revoke).toHaveBeenCalledWith(pluginId, packageVersion)
      expect(surface.visible).toBe(false)
      expect(surface.webContents.isDestroyed()).toBe(true)
      expect((mgr as unknown as { running: Map<string, unknown> }).running.has(handle.instanceId)).toBe(false)
    } finally {
      revoke.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('blocks reopening while a package version is being revoked', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.revocation-gate'
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'main',
      contributionKey: `${pluginId}.main`,
      kind: 'custom',
      location: 'main',
      title: 'Revocation gate',
      entryFile: '/plugins/acme.revocation-gate/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: null,
      runtimeBinding: {
        pluginId,
        packageVersion,
        workspaceId: 'workspace-1',
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: pluginId,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityContext: context,
    }
    mgr.registerDescriptor(packageDescriptor)
    let finish!: () => void
    const revoke = vi
      .spyOn(PluginBackendHost.prototype, 'revokePackageVersion')
      .mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const host = new FakeBrowserWindow()

    try {
      await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        capabilityContext: context,
      })
      const revocation = mgr.revokePackageVersion(pluginId, packageVersion)
      await Promise.resolve()

      await expect(mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(new FakeBrowserWindow()),
        bounds: 'fill',
        workspacePath: '/workspace',
        capabilityContext: context,
      })).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })

      finish()
      await revocation
      expect(revoke).toHaveBeenCalledWith(pluginId, packageVersion)
    } finally {
      revoke.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('blocks contribution updates while a package version is being revoked', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.contribution-revocation-gate'
    const packageVersion = '1.0.0'
    const contributionKey = `${pluginId}.main`
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'main',
      contributionKey,
      kind: 'custom',
      location: 'main',
      title: 'Revocation update gate',
      entryFile: '/plugins/acme.contribution-revocation-gate/index.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: pluginId,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityPolicy: {
        kind: 'manifest-v2',
        system: ['fs'],
        grants: [{ permission: 'system', namespace: 'fs' }],
      },
    }
    mgr.registerDescriptor(descriptor)
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion,
      system: ['fs'],
      storage: true,
    }))
    const host = new FakeBrowserWindow()
    let finish!: () => void
    const revoke = vi
      .spyOn(PluginBackendHost.prototype, 'revokePackageVersion')
      .mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))

    try {
      await expect(mgr.openContribution(asHost(host), contributionKey, {
        bounds: { x: 0, y: 0, width: 300, height: 500 },
        workspacePath: '/workspace',
      })).resolves.toEqual({ ok: true })
      const revocation = mgr.revokePackageVersion(pluginId, packageVersion)

      expect(mgr.updateContribution(
        asHost(host),
        contributionKey,
        { x: 0, y: 0, width: 300, height: 500 },
        true,
      )).toEqual({ ok: false })

      await Promise.resolve()
      finish()
      await revocation
    } finally {
      revoke.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })
})

describe('registerDescriptor reserved-id guard', () => {
  it('refuses a third-party plugin claiming a reserved built-in id', () => {
    const mgr = new FrontendPluginManager()
    expect(() => mgr.registerDescriptor(descriptor('navide.mini-ide'))).toThrow(/reserved/)
    expect(() => mgr.registerDescriptor(descriptor(HOST_EVENT_SOURCE_PLUGIN_ID))).toThrow(
      /not a plugin id/
    )
    expect(() =>
      mgr.registerDescriptor(descriptor(HOST_EVENT_SOURCE_PLUGIN_ID), { builtin: true })
    ).toThrow(/not a plugin id/)
    expect(mgr.getDescriptor('navide.mini-ide')).toBeUndefined()
  })

  it('allows the host itself to register a built-in id', () => {
    const mgr = new FrontendPluginManager()
    expect(() =>
      mgr.registerDescriptor(descriptor('navide.mini-ide'), { builtin: true })
    ).not.toThrow()
    expect(mgr.getDescriptor('navide.mini-ide')?.id).toBe('navide.mini-ide')
  })

  it('allows an officially-verified install to register a reserved id', () => {
    const mgr = new FrontendPluginManager()
    expect(() =>
      mgr.registerDescriptor(descriptor('navide.mini-ide'), { official: true })
    ).not.toThrow()
    expect(mgr.getDescriptor('navide.mini-ide')?.id).toBe('navide.mini-ide')
  })

  it('keeps a bundled frontend inactive until an official backend-only install is removed', () => {
    const mgr = new FrontendPluginManager()
    const bundled = devPlansPluginDescriptor()
    mgr.registerInstalledPackage(
      { id: PLANS_PLUGIN_ID, requires: [] },
      undefined,
      { official: true }
    )

    mgr.registerBuiltin(bundled)

    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)).toBeUndefined()
    expect(mgr.listInstalledPackages()).toEqual([{ id: PLANS_PLUGIN_ID, requires: [] }])

    mgr.removeInstalledPlugin(PLANS_PLUGIN_ID)

    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)).toBe(bundled)
    expect(mgr.listInstalledPackages()).toEqual([])
  })

  it('can remove an installed package without restoring its remembered builtin', () => {
    const mgr = new FrontendPluginManager()
    const bundled = devPlansPluginDescriptor()
    mgr.registerBuiltin(bundled)
    mgr.registerInstalledPackage(
      { id: PLANS_PLUGIN_ID, requires: [], provenance: 'official-registry' },
      undefined,
      { official: true },
    )

    mgr.removeInstalledPlugin(PLANS_PLUGIN_ID, { restoreBuiltin: false })

    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)).toBeUndefined()
    expect(mgr.listInstalledPackages()).toEqual([])
  })

  it('registers an ordinary third-party descriptor', () => {
    const mgr = new FrontendPluginManager()
    mgr.registerDescriptor(descriptor('acme.demo'))
    expect(mgr.getDescriptor('acme.demo')?.id).toBe('acme.demo')
  })

  it('lists validated Manifest v2 view contributions for Host discovery', () => {
    const mgr = new FrontendPluginManager()
    mgr.registerDescriptor({
      ...descriptor('acme.files'),
      views: [
        {
          id: 'left',
          contributionKey: 'acme.files.left',
          kind: 'custom',
          location: 'left',
          title: 'Files',
          entryFile: '/plugins/acme.files/frontend/left/index.html',
        },
        {
          id: 'window',
          contributionKey: 'acme.files.window',
          kind: 'custom',
          location: 'window',
          title: 'Files window',
          entryFile: '/plugins/acme.files/frontend/window/index.html',
        },
      ],
    })
    expect(mgr.listViewContributions()).toEqual([
      expect.objectContaining({
        contributionKey: 'acme.files.left',
        location: 'left',
      }),
      expect.objectContaining({
        contributionKey: 'acme.files.window',
        location: 'window',
      }),
    ])
    expect(mgr.listContributionCatalog()).toEqual([
      {
        pluginId: 'acme.files',
        packageVersion: null,
        contributionKey: 'acme.files.left',
        title: 'Files',
        iconFile: null,
        kind: 'custom',
        location: 'left',
        manifestOrder: 0,
      },
      {
        pluginId: 'acme.files',
        packageVersion: null,
        contributionKey: 'acme.files.window',
        title: 'Files window',
        iconFile: null,
        kind: 'custom',
        location: 'window',
        manifestOrder: 1,
      },
    ])
  })

  it('derives an exact per-instance context when a catalog contribution opens', async () => {
    const mgr = new FrontendPluginManager()
    const packageDescriptor: PluginLaunchDescriptor = {
      ...descriptor('acme.files'),
      packageVersion: '1.2.3',
      capabilityPolicy: {
        kind: 'manifest-v2',
        system: ['fs'],
        grants: [{ permission: 'system', namespace: 'fs' }],
      },
      views: [{
        id: 'left',
        contributionKey: 'acme.files.left',
        kind: 'custom',
        location: 'left',
        title: 'Files',
        entryFile: '/plugins/acme.files/frontend/left/index.html',
      }],
    }
    mgr.registerInstalledPackage(
      { id: 'acme.files', requires: ['fs'], provenance: 'official-registry' },
      packageDescriptor,
    )
    const resolveGrant = vi.fn(() => ({
      packageVersion: '1.2.3',
      system: ['fs'] as const,
      storage: true,
    }))
    mgr.setCapabilityGrantResolver(resolveGrant)
    const host = new FakeBrowserWindow()

    await expect(mgr.openContribution(asHost(host), 'acme.files.left', {
      bounds: { x: 0, y: 0, width: 300, height: 500 },
      workspacePath: '/workspace',
    })).resolves.toEqual({ ok: true })

    expect(resolveGrant).toHaveBeenCalledWith('acme.files', '1.2.3')
    const running = [...(mgr as unknown as {
      running: Map<string, { capabilityContext: HostCapabilityContext | null }>
    }).running.values()]
    expect(running[0].capabilityContext).toMatchObject({
      publisherEligible: false,
      userGrant: { packageVersion: '1.2.3', system: ['fs'], storage: true },
      runtimeBinding: {
        pluginId: 'acme.files',
        packageVersion: '1.2.3',
        instanceId: expect.any(String),
        workspaceId: expect.any(String),
        audience: 'acme.files.left',
      },
      storageSnapshotTier: 'active',
    })
  })

  it('derives the same workspace identity across manager instances', () => {
    const first = new FrontendPluginManager().gitCapabilityContext(
      '1.0.0',
      '/workspace/project/../project',
      'git-left',
    )
    const second = new FrontendPluginManager().gitCapabilityContext(
      '1.0.0',
      '/workspace/project',
      'git-window',
    )

    expect(first.runtimeBinding?.workspaceId).toBe(second.runtimeBinding?.workspaceId)
    expect(first.runtimeBinding?.workspaceId).toMatch(/^[a-f0-9]{64}$/)
  })

  it('fails closed when a catalog contribution lacks an exact approved grant', async () => {
    const mgr = new FrontendPluginManager()
    const packageDescriptor: PluginLaunchDescriptor = {
      ...descriptor('acme.files'),
      packageVersion: '1.2.3',
      capabilityPolicy: { kind: 'manifest-v2', system: ['fs'], grants: [] },
      views: [{
        id: 'left',
        contributionKey: 'acme.files.left',
        kind: 'custom',
        location: 'left',
        title: 'Files',
        entryFile: '/plugins/acme.files/frontend/left/index.html',
      }],
    }
    mgr.registerInstalledPackage(
      { id: 'acme.files', requires: ['fs'], provenance: 'official-registry' },
      packageDescriptor,
    )
    mgr.setCapabilityGrantResolver(() => null)

    await expect(mgr.openContribution(asHost(new FakeBrowserWindow()), 'acme.files.left', {
      bounds: { x: 0, y: 0, width: 300, height: 500 },
      workspacePath: '/workspace',
    })).resolves.toEqual({ ok: false, error: 'package-version capability grant is missing' })
  })

  it('reports an early selected-v2 activation failure exactly once', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor: PluginLaunchDescriptor = {
      id: 'navide.git',
      packageVersion: '1.0.0',
      requires: ['fs'],
      capabilityPolicy: { kind: 'manifest-v2', system: ['fs'], grants: [] },
      devUrl: '',
      entryFile: '/plugins/navide.git/frontend/left/index.html',
      views: [{
        id: 'left',
        contributionKey: 'navide.git.left',
        kind: 'custom',
        location: 'left',
        title: 'Git',
        entryFile: '/plugins/navide.git/frontend/left/index.html',
      }],
    }
    mgr.registerInstalledPackage(
      { id: 'navide.git', requires: ['fs'], provenance: 'official-registry' },
      descriptor,
      { official: true },
    )
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: '1.0.0', system: ['fs'], storage: true,
    }))
    const onFailure = vi.fn()
    mgr.setActivationFailureHandler(onFailure)
    const host = new FakeBrowserWindow()
    await mgr.openContribution(asHost(host), 'navide.git.left', {
      bounds: { x: 0, y: 0, width: 300, height: 500 },
      workspacePath: '/workspace',
    })
    const webContents = (host.children[0] as FakeViewLike).webContents as unknown as {
      emit(event: string, ...args: unknown[]): void
    }

    webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'file:///plugin', true)
    webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'file:///plugin', true)

    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure).toHaveBeenCalledWith({
      pluginId: 'navide.git',
      packageVersion: '1.0.0',
      reason: 'entry load failed: NAME_NOT_RESOLVED (-105)',
    })
  })

  it('starts the v2 readiness timeout only after the entry finishes loading', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDescriptor: PluginLaunchDescriptor = {
        ...descriptor('navide.git'),
        packageVersion: '1.0.0',
        capabilityPolicy: { kind: 'manifest-v2', system: ['fs'], grants: [] },
        views: [{
          id: 'left',
          contributionKey: 'navide.git.left',
          kind: 'custom',
          location: 'left',
          title: 'Git',
          entryFile: '/plugins/navide.git/frontend/left/index.html',
        }],
      }
      mgr.registerInstalledPackage(
        { id: 'navide.git', requires: ['fs'], provenance: 'official-registry' },
        packageDescriptor,
        { official: true },
      )
      mgr.setCapabilityGrantResolver(() => ({
        packageVersion: '1.0.0', system: ['fs'], storage: true,
      }))
      const onFailure = vi.fn()
      mgr.setActivationFailureHandler(onFailure)
      const host = new FakeBrowserWindow()
      await mgr.openContribution(asHost(host), 'navide.git.left', {
        bounds: { x: 0, y: 0, width: 300, height: 500 },
        workspacePath: '/workspace',
      })
      const webContents = (host.children[0] as FakeViewLike).webContents as unknown as {
        emit(event: string, ...args: unknown[]): void
      }

      await vi.advanceTimersByTimeAsync(10_000)
      expect(onFailure).not.toHaveBeenCalled()

      webContents.emit('did-finish-load')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(onFailure).toHaveBeenCalledWith({
        pluginId: 'navide.git',
        packageVersion: '1.0.0',
        reason: 'plugin readiness handshake timed out',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a timeout when readiness arrives before did-finish-load', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDescriptor: PluginLaunchDescriptor = {
        ...descriptor('navide.git'),
        packageVersion: '1.0.0',
        capabilityPolicy: { kind: 'manifest-v2', system: ['fs'], grants: [] },
        views: [{
          id: 'left',
          contributionKey: 'navide.git.left',
          kind: 'custom',
          location: 'left',
          title: 'Git',
          entryFile: '/plugins/navide.git/frontend/left/index.html',
        }],
      }
      mgr.registerInstalledPackage(
        { id: 'navide.git', requires: ['fs'], provenance: 'official-registry' },
        packageDescriptor,
        { official: true },
      )
      mgr.setCapabilityGrantResolver(() => ({
        packageVersion: '1.0.0', system: ['fs'], storage: true,
      }))
      const onFailure = vi.fn()
      mgr.setActivationFailureHandler(onFailure)
      const host = new FakeBrowserWindow()
      await mgr.openContribution(asHost(host), 'navide.git.left', {
        bounds: { x: 0, y: 0, width: 300, height: 500 },
        workspacePath: '/workspace',
      })
      const webContents = (host.children[0] as FakeViewLike).webContents as unknown as {
        id: number
        emit(event: string, ...args: unknown[]): void
      }

      ipcListeners.get('plugin:ready')?.({ sender: { id: webContents.id } })
      webContents.emit('did-finish-load')
      await vi.advanceTimersByTimeAsync(10_000)

      expect(onFailure).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('loadInstalledPlugins official receipt gate', () => {
  const official = generateKeyPairSync('ed25519')
  const officialPem = official.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  let root: string
  let envBefore: string | undefined

  function writePlugin(id: string, receipt?: Record<string, unknown>): void {
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ id, version: '1.0.0', entry: 'index.html', requires: [] })
    )
    writeFileSync(join(dir, 'index.html'), '<!doctype html>')
    if (receipt) writeFileSync(join(dir, '.navide-receipt.json'), JSON.stringify(receipt))
  }

  function writeV2Plugin(
    directory: string,
    options: {
      id: string
      version?: string
      frontend?: boolean
      backend?: boolean
      receipt?: Record<string, unknown>
    }
  ): void {
    const dir = join(root, directory)
    const version = options.version ?? '1.0.0'
    const manifest = {
      schemaVersion: 2,
      apiVersion: '^1.0.0',
      id: options.id,
      name: options.id,
      version,
      publisher: options.id.split('.')[0],
      permissions: {},
      marketplace: { description: `${options.id} test plugin`, license: 'MIT' },
      contributes: options.frontend
        ? {
            views: [
              {
                id: 'main',
                kind: 'custom',
                location: 'main',
                title: 'Main',
                entry: 'frontend/index.html',
              },
            ],
          }
        : undefined,
      backend: options.backend
        ? {
            entry: 'backend/plugin',
            protocolVersion: 1,
            activation: 'startup',
          }
        : undefined,
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    if (options.frontend) {
      mkdirSync(join(dir, 'frontend'), { recursive: true })
      writeFileSync(join(dir, 'frontend', 'index.html'), '<!doctype html>')
    }
    if (options.backend) {
      mkdirSync(join(dir, 'backend'), { recursive: true })
      const backendPath = join(dir, 'backend', 'plugin')
      writeFileSync(backendPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      chmodSync(backendPath, 0o700)
    }
    if (options.receipt) {
      writeFileSync(join(dir, '.navide-receipt.json'), JSON.stringify(options.receipt))
    }
  }

  function officialReceipt(id: string): Record<string, unknown> {
    const digest = 'ab'.repeat(32)
    const signature = edSign(null, Buffer.from(digest, 'ascii'), official.privateKey).toString(
      'base64'
    )
    return { id, version: '1.0.0', digest, signature }
  }

  it('loads a validated Host-bundled Manifest v2 package through the installed runtime', () => {
    writeV2Plugin('factory-git', { id: 'navide.git', frontend: true })
    const mgr = new FrontendPluginManager()

    const result = mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git')

    expect(result).toMatchObject({ loaded: true, pluginId: 'navide.git', packageVersion: '1.0.0' })
    expect(mgr.getDescriptor('navide.git')?.packageVersion).toBe('1.0.0')
    expect(mgr.listInstalledPackages()).toEqual([
      {
        id: 'navide.git',
        requires: [],
        packageVersion: '1.0.0',
        manifestPermissions: { system: [] },
        provenance: 'factory-bundled',
      },
    ])
  })

  it('treats the App-bundled Git package as publisher-eligible only after an exact grant', async () => {
    writeV2Plugin('factory-git', { id: 'navide.git', frontend: true })
    const mgr = new FrontendPluginManager()
    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git').loaded).toBe(true)
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: '1.0.0',
      system: [],
      storage: true,
    }))
    const host = new FakeBrowserWindow()

    await expect(mgr.openContribution(asHost(host), 'navide.git.main', {
      bounds: { x: 0, y: 0, width: 300, height: 500 },
      workspacePath: '/workspace',
    })).resolves.toEqual({ ok: true })

    const running = [...(mgr as unknown as {
      running: Map<string, { capabilityContext: HostCapabilityContext | null }>
    }).running.values()]
    expect(running[0].capabilityContext).toMatchObject({
      publisherEligible: true,
      userGrant: { packageVersion: '1.0.0', system: [], storage: true },
      runtimeBinding: { pluginId: 'navide.git', packageVersion: '1.0.0' },
    })
  })

  it('does not let a Host-bundled package replace an active Registry package', () => {
    writeV2Plugin('factory-git', { id: 'navide.git', version: '1.0.0', frontend: true })
    const mgr = new FrontendPluginManager()
    mgr.registerInstalledPackage(
      { id: 'navide.git', requires: [], provenance: 'official-registry' },
      {
        ...descriptor('navide.git'),
        packageVersion: '2.0.0',
        capabilityPolicy: { kind: 'manifest-v2', system: [], grants: [] },
      },
      { official: true },
    )

    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git')).toMatchObject({
      loaded: false,
      reason: 'installed package is active',
    })
    expect(mgr.getDescriptor('navide.git')?.packageVersion).toBe('2.0.0')
  })

  it('restores the factory package after legacy recovery, which the plain load refuses', () => {
    writeV2Plugin('factory-git', { id: 'navide.git', frontend: true })
    const mgr = new FrontendPluginManager()
    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git').loaded).toBe(true)
    // Recovery replaces the descriptor but leaves the package registered, so
    // the plain factory load has no way back — this was why a downgraded
    // session could only reach v2 again by restarting the App.
    mgr.replaceBuiltinForRecovery(descriptor('navide.git'))
    expect(mgr.getDescriptor('navide.git')?.packageVersion).toBeUndefined()
    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git')).toMatchObject({
      loaded: false,
      reason: 'installed package is active',
    })

    expect(mgr.restoreFactoryAfterRecovery(join(root, 'factory-git'), 'navide.git')).toMatchObject({
      restored: true,
      activation: { pluginId: 'navide.git', packageVersion: '1.0.0' },
    })
    expect(mgr.getDescriptor('navide.git')?.packageVersion).toBe('1.0.0')
  })

  it('refuses to restore a factory package that is not in legacy recovery', () => {
    writeV2Plugin('factory-git', { id: 'navide.git', frontend: true })
    const mgr = new FrontendPluginManager()
    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git').loaded).toBe(true)

    expect(mgr.restoreFactoryAfterRecovery(join(root, 'factory-git'), 'navide.git')).toEqual({
      restored: false,
      reason: 'plugin is not in legacy recovery',
    })
  })

  it('rejects a factory package whose manifest claims another identity', () => {
    writeV2Plugin('factory-git', { id: 'acme.git', frontend: true })
    const mgr = new FrontendPluginManager()

    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git')).toMatchObject({
      loaded: false,
      reason: expect.stringMatching(/expected.*navide\.git/i),
    })
    expect(mgr.listInstalledPackages()).toEqual([])
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-plugins-'))
    envBefore = process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY'] = officialPem
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (envBefore === undefined) delete process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    else process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY'] = envBefore
  })

  it('registers a navide. plugin whose receipt verifies against the pinned key', () => {
    writePlugin('navide.mini-ide', officialReceipt('navide.mini-ide'))
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(errors).toEqual([])
    expect(loaded).toContain('navide.mini-ide')
    expect(mgr.getDescriptor('navide.mini-ide')).toBeDefined()
  })

  it('does not let a self-hosted Registry context activate a reserved legacy package', () => {
    writePlugin('navide.mini-ide', officialReceipt('navide.mini-ide'))
    const mgr = new FrontendPluginManager()
    const result = mgr.loadInstalledPlugins(root, {
      provenance: 'official-registry',
      trust: {
        pinnedRootKey: officialPem,
        snapshot: null,
        registryAuthority: 'self-hosted',
        officialRegistryUrl: 'https://registry.navide.dev',
      },
    })
    expect(result.loaded).toEqual([])
    expect(result.errors.join(' ')).toMatch(/App-authorized Official Registry/)
    expect(mgr.getDescriptor('navide.mini-ide')).toBeUndefined()
  })

  it('refuses a navide. plugin without a receipt', () => {
    writePlugin('navide.mini-ide')
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(loaded).toEqual([])
    expect(errors.join(' ')).toMatch(/receipt/)
    expect(mgr.getDescriptor('navide.mini-ide')).toBeUndefined()
  })

  it('refuses a navide. plugin whose receipt was signed by a different key', () => {
    const rogue = generateKeyPairSync('ed25519')
    const digest = 'cd'.repeat(32)
    const signature = edSign(null, Buffer.from(digest, 'ascii'), rogue.privateKey).toString(
      'base64'
    )
    writePlugin('navide.mini-ide', { id: 'navide.mini-ide', version: '1.0.0', digest, signature })
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(loaded).toEqual([])
    expect(errors.join(' ')).toMatch(/pinned official key/)
  })

  it('falls back to the shipped pin when no env override is set', () => {
    // Without an override the pin comes from OFFICIAL_PUBLISHER_KEY_PEM, so this
    // test-only key is refused for MISMATCHING the pin — not for the absence of
    // one. That distinction is what proves the shipped constant is wired in; if
    // it were ever emptied, the message would revert to "no pinned official".
    delete process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    writePlugin('navide.mini-ide', officialReceipt('navide.mini-ide'))
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(loaded).toEqual([])
    expect(errors.join(' ')).toMatch(/pinned official key/)
    expect(errors.join(' ')).not.toMatch(/no pinned official/)
  })

  it('loads third-party plugins with no receipt requirement', () => {
    writePlugin('acme.demo')
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(errors).toEqual([])
    expect(loaded).toEqual(['acme.demo'])
  })

  it('returns validated frontend-only, backend-only, and combined v2 activations', () => {
    writeV2Plugin('backend-only', { id: 'acme.skills', backend: true })
    writeV2Plugin('combined', { id: 'acme.files', frontend: true, backend: true })
    writeV2Plugin('frontend-only', { id: 'acme.viewer', frontend: true })

    const mgr = new FrontendPluginManager()
    const { loaded, errors, activationCatalog } = mgr.loadInstalledPlugins(root, {
      provenance: 'developer-local-unpacked',
    })

    expect(errors).toEqual([])
    expect([...loaded].sort()).toEqual(['acme.files', 'acme.viewer'])
    expect(activationCatalog.map((entry) => entry.pluginId).sort()).toEqual([
      'acme.files',
      'acme.skills',
      'acme.viewer',
    ])
    expect(
      activationCatalog.find((entry) => entry.pluginId === 'acme.skills')?.backend
    ).toMatchObject({ protocolVersion: 1, activation: 'startup' })
    expect(
      activationCatalog.find((entry) => entry.pluginId === 'acme.viewer')?.backend
    ).toBeUndefined()
    expect(mgr.listInstalledPackages().map((pkg) => pkg.id).sort()).toEqual([
      'acme.files',
      'acme.skills',
      'acme.viewer',
    ])
  })

  describe('explicit Developer Mode package selection', () => {
    it('loads one explicitly selected frontend package only when opted in', () => {
      writeV2Plugin('viewer', { id: 'acme.viewer', frontend: true })
      const mgr = new FrontendPluginManager()

      expect(mgr.loadExplicitDeveloperPlugin(join(root, 'viewer'), false)).toMatchObject({
        loaded: false,
        error: expect.stringMatching(/opt-in/),
      })
      expect(mgr.loadExplicitDeveloperPlugin(join(root, 'viewer'), true)).toEqual({
        loaded: true,
        pluginId: 'acme.viewer',
      })
      expect(mgr.listInstalledPackages()).toEqual([
        {
          id: 'acme.viewer',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'developer-local-unpacked',
          warning: 'Unsigned local unpacked plugin — Developer Mode only',
        },
      ])
    })

    it('loads a legacy v1 sideload only with explicit local provenance', () => {
      writePlugin('legacy', undefined)
      const manifestPath = join(root, 'legacy', 'manifest.json')
      writeFileSync(
        manifestPath,
        JSON.stringify({ id: 'acme.legacy', version: '1.0.0', entry: 'index.html', requires: [] })
      )
      const mgr = new FrontendPluginManager()
      expect(mgr.loadExplicitDeveloperPlugin(join(root, 'legacy'), true)).toEqual({
        loaded: true,
        pluginId: 'acme.legacy',
      })
      expect(mgr.listInstalledPackages()).toEqual([
        {
          id: 'acme.legacy',
          requires: [],
          provenance: 'developer-local-unpacked',
          warning: 'Unsigned local unpacked plugin — Developer Mode only',
        },
      ])
    })

    it('does not scan a selected parent directory', () => {
      writeV2Plugin('viewer', { id: 'acme.viewer', frontend: true })
      const mgr = new FrontendPluginManager()
      expect(mgr.loadExplicitDeveloperPlugin(root, true)).toMatchObject({
        loaded: false,
        error: expect.stringMatching(/manifest/),
      })
      expect(mgr.listInstalledPackages()).toEqual([])
    })

    it.each([
      ['missing path', undefined, /explicit package directory/],
      ['reserved id', 'navide-spoof', /reserved/],
      ['backend package', 'backend', /backend/],
    ])('rejects Developer Mode %s', (_label, selected, expected) => {
      if (selected === 'navide-spoof') {
        writeV2Plugin(selected, { id: 'navide.spoof', frontend: true })
      } else if (selected === 'backend') {
        writeV2Plugin(selected, { id: 'acme.backend', backend: true })
      }
      const mgr = new FrontendPluginManager()
      const selectedPath = selected === undefined ? undefined : join(root, selected)
      expect(mgr.loadExplicitDeveloperPlugin(selectedPath, true)).toMatchObject({
        loaded: false,
        error: expect.stringMatching(expected),
      })
      expect(mgr.listInstalledPackages()).toEqual([])
    })

    it('rejects invalid manifests before registering a local package', () => {
      const dir = join(root, 'invalid')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'manifest.json'), '{"schemaVersion":2}')
      const mgr = new FrontendPluginManager()
      expect(mgr.loadExplicitDeveloperPlugin(dir, true)).toMatchObject({
        loaded: false,
        error: expect.stringMatching(/manifest|invalid/),
      })
      expect(mgr.listInstalledPackages()).toEqual([])
    })
  })

  it('rejects duplicate package identities without blocking unrelated v2 packages', () => {
    writeV2Plugin('files-v1', {
      id: 'acme.files',
      version: '1.0.0',
      frontend: true,
      backend: true,
    })
    writeV2Plugin('files-v2', {
      id: 'acme.files',
      version: '2.0.0',
      frontend: true,
      backend: true,
    })
    writeV2Plugin('viewer', { id: 'acme.viewer', frontend: true })

    const mgr = new FrontendPluginManager()
    const { loaded, errors, activationCatalog } = mgr.loadInstalledPlugins(root, {
      provenance: 'developer-local-unpacked',
    })

    expect(errors.join(' ')).toMatch(/duplicate plugin packages/)
    expect(errors.join(' ')).toContain(join(root, 'files-v1'))
    expect(errors.join(' ')).toContain(join(root, 'files-v2'))
    expect(loaded).toEqual(['acme.viewer'])
    expect(activationCatalog.map((entry) => entry.pluginId)).toEqual(['acme.viewer'])
    expect(mgr.getDescriptor('acme.files')).toBeUndefined()
    expect(mgr.listInstalledPackages().map((pkg) => pkg.id)).toEqual(['acme.viewer'])
  })

  it('rejects a v1 frontend and v2 backend-only package with the same id', () => {
    writePlugin('acme.demo')
    writeV2Plugin('backend-copy', { id: 'acme.demo', backend: true })
    writeV2Plugin('viewer', { id: 'acme.viewer', frontend: true })

    const mgr = new FrontendPluginManager()
    const { loaded, errors, activationCatalog } = mgr.loadInstalledPlugins(root, {
      provenance: 'developer-local-unpacked',
    })

    expect(errors.join(' ')).toMatch(/acme\.demo: duplicate plugin packages/)
    expect(errors.join(' ')).toContain(join(root, 'acme.demo'))
    expect(errors.join(' ')).toContain(join(root, 'backend-copy'))
    expect(loaded).toEqual(['acme.viewer'])
    expect(activationCatalog.map((entry) => entry.pluginId)).toEqual(['acme.viewer'])
    expect(mgr.getDescriptor('acme.demo')).toBeUndefined()
    expect(mgr.listInstalledPackages().map((pkg) => pkg.id)).toEqual(['acme.viewer'])
  })

  it('removes a stale frontend descriptor when an install becomes backend-only', () => {
    const mgr = new FrontendPluginManager()
    mgr.registerInstalledPackage(
      { id: 'acme.demo', requires: ['git'] },
      descriptor('acme.demo')
    )
    expect(mgr.getDescriptor('acme.demo')).toBeDefined()

    mgr.registerInstalledPackage({ id: 'acme.demo', requires: [] })

    expect(mgr.getDescriptor('acme.demo')).toBeUndefined()
    expect(mgr.listInstalledPackages()).toEqual([{ id: 'acme.demo', requires: [] }])
  })

  it('keeps a reserved backend-only package behind the official receipt gate', () => {
    writeV2Plugin('navide-skills', { id: 'navide.skills', backend: true })
    const mgr = new FrontendPluginManager()

    const { loaded, errors, activationCatalog } = mgr.loadInstalledPlugins(root)

    expect(loaded).toEqual([])
    expect(activationCatalog).toEqual([])
    expect(errors.join(' ')).toMatch(/Registry trust context/)
    expect(mgr.listInstalledPackages()).toEqual([])
  })

  it('does not accept a legacy digest receipt for a v2 reserved package', () => {
    writeV2Plugin('navide-skills', {
      id: 'navide.skills',
      backend: true,
      receipt: officialReceipt('navide.skills'),
    })
    const mgr = new FrontendPluginManager()

    const { loaded, errors, activationCatalog } = mgr.loadInstalledPlugins(root)

    expect(loaded).toEqual([])
    expect(errors.join(' ')).toMatch(/Registry trust context/)
    expect(activationCatalog).toEqual([])
    expect(mgr.listInstalledPackages()).toEqual([])
  })

  it('stops and unregisters a v2 frontend when refreshed trust quarantines it', () => {
    writeV2Plugin('viewer', { id: 'acme.viewer', frontend: true })
    const mgr = new FrontendPluginManager()
    const loaded = mgr.loadInstalledPlugins(root, {
      provenance: 'developer-local-unpacked',
    })
    expect(loaded.loaded).toEqual(['acme.viewer'])

    const decisions = mgr.refreshInstalledPluginTrust(root, {
      pinnedRootKey: officialPem,
      snapshot: null,
    })

    expect(decisions).toEqual([
      expect.objectContaining({ pluginId: 'acme.viewer', action: 'quarantine' }),
    ])
    expect(mgr.getDescriptor('acme.viewer')).toBeUndefined()
    expect(mgr.listInstalledPackages()).toEqual([])
  })
})

describe('bundled mini-IDE builtin resolution', () => {
  let root: string

  /** Write a valid bundled mini-IDE dir (manifest + entry) under `dir`. */
  function writeBundled(dir: string, manifest?: Record<string, unknown>): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(
        manifest ?? {
          id: MINI_IDE_PLUGIN_ID,
          version: '1.0.0',
          entry: 'index.html',
          requires: ['fs', 'git'],
        }
      )
    )
    writeFileSync(join(dir, 'index.html'), '<!doctype html>')
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-bundled-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves resourcesPath/plugins/mini-ide when packaged', () => {
    expect(bundledMiniIdeDir({ isPackaged: true, resourcesPath: '/res' })).toBe(
      join('/res', 'plugins', 'mini-ide')
    )
  })

  it('resolves dist-plugins/mini-ide under the dev root when unpackaged', () => {
    expect(
      bundledMiniIdeDir({ isPackaged: false, resourcesPath: '/res', devRoot: '/repo' })
    ).toBe(join('/repo', 'dist-plugins', 'mini-ide'))
  })

  it('registers the bundled copy as builtin when nothing is installed (packaged)', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    writeBundled(dir)
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })
    expect(result.registered).toBe(true)
    const desc = mgr.getDescriptor(MINI_IDE_PLUGIN_ID)
    expect(desc?.entryFile).toBe(join(dir, 'index.html'))
    expect(desc?.requires).toEqual(['fs', 'git'])
  })

  it('registers the dev dist-plugins copy when unpackaged', () => {
    const dir = join(root, 'dist-plugins', 'mini-ide')
    writeBundled(dir)
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, {
      isPackaged: false,
      resourcesPath: '/unused',
      devRoot: root,
    })
    expect(result.registered).toBe(true)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)?.entryFile).toBe(join(dir, 'index.html'))
  })

  it('an already-installed (official) copy takes precedence over the bundled copy', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    writeBundled(dir)
    const mgr = new FrontendPluginManager()
    const installed: PluginLaunchDescriptor = {
      id: MINI_IDE_PLUGIN_ID,
      requires: ['fs'],
      devUrl: '',
      entryFile: '/userData/plugins/navide.mini-ide/index.html',
    }
    mgr.registerDescriptor(installed, { official: true })

    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })
    expect(result.registered).toBe(true)
    // Installed copy stays active; the bundled one is only the fallback.
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)?.entryFile).toBe(installed.entryFile)
  })

  it('removing the installed override reverts to the bundled builtin', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    writeBundled(dir)
    const mgr = new FrontendPluginManager()
    mgr.registerDescriptor(
      {
        id: MINI_IDE_PLUGIN_ID,
        requires: ['fs'],
        devUrl: '',
        entryFile: '/userData/plugins/navide.mini-ide/index.html',
      },
      { official: true }
    )
    registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })

    mgr.removeInstalledPlugin(MINI_IDE_PLUGIN_ID)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)?.entryFile).toBe(join(dir, 'index.html'))
  })

  it('a missing bundled dir is refused without crashing (dialog fallback)', () => {
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })
    expect(result.registered).toBe(false)
    expect(result.reason).toBeTruthy()
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)).toBeUndefined()
  })

  it('an invalid bundled manifest is refused without crashing', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), 'not json at all')
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })
    expect(result.registered).toBe(false)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)).toBeUndefined()
  })

  it('a bundled manifest claiming a different id is refused', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    writeBundled(dir, {
      id: 'acme.impostor',
      version: '1.0.0',
      entry: 'index.html',
      requires: [],
    })
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })
    expect(result.registered).toBe(false)
    expect(result.reason).toMatch(/acme\.impostor/)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)).toBeUndefined()
  })

  it('a bundled dir whose entry file is missing is refused', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ id: MINI_IDE_PLUGIN_ID, version: '1.0.0', entry: 'index.html', requires: [] })
    )
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })
    expect(result.registered).toBe(false)
    expect(result.reason).toMatch(/entry file missing/)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)).toBeUndefined()
  })
})

describe('view lifecycle (open / hideSelf / resize / death paths)', () => {
  const OPEN_TARGET = 'plugin:openTarget'

  function openView(
    mgr: FrontendPluginManager,
    host: FakeBrowserWindow,
    id: string,
    query?: string
  ): FakeViewLike {
    const before = views.length
    mgr.open(asHost(host), { ...descriptor(id), query }, 'fill')
    // Existing-view opens create no new fake; return the plugin's current view.
    return views.length > before ? views[views.length - 1] : views[before - 1]
  }

  function openTargets(view: FakeViewLike): Record<string, string>[] {
    return view.webContents.sent
      .filter((m) => m.channel === OPEN_TARGET)
      .map((m) => m.args[0] as Record<string, string>)
  }

  it('leaves the host title alone when mirrorTitle is not requested', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    host.title = 'my-repo — Navide'
    const view = openView(mgr, host, 'acme.a', '?workspace_path=/ws')
    // A plugin embedded in a shared window must never rename that window.
    view.webContents.emit('page-title-updated', {}, 'something — Acme')
    expect(host.title).toBe('my-repo — Navide')
  })

  it('hideSelf hides only the calling sender view', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openView(mgr, host, 'acme.a', '?workspace_path=/ws')
    const before = views.length
    mgr.open(asHost(host), descriptor('acme.b'), { x: 0, y: 0, width: 10, height: 10 })
    const viewB = views[before]
    expect(viewA.visible).toBe(true)
    expect(viewB.visible).toBe(true)

    const hide = ipcListeners.get('plugin:hideSelf')
    expect(hide).toBeDefined()
    hide!({ sender: { id: viewA.webContents.id } })
    expect(viewA.visible).toBe(false)
    expect(viewB.visible).toBe(true)

    // Unknown sender → no-op (never hides someone else's view).
    hide!({ sender: { id: 999999 } })
    expect(viewB.visible).toBe(true)
  })

  it('drops the running record when the webContents dies and reopen recreates', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const first = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    expect(first.webContents.loads).toHaveLength(1)

    // Simulate renderer death (any path other than manager.destroy()).
    first.webContents.close()

    const countBefore = views.length
    const second = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    expect(views.length).toBe(countBefore + 1) // recreated, not reused
    expect(second).not.toBe(first)
    expect(second.webContents.loads).toHaveLength(1)
  })

  it('delivers a changed open target to the running view without reloading', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws&http_url=http://x')
    view.webContents.emit('did-finish-load')

    openView(mgr, host, 'acme.editor', '?workspace_path=/ws&filepath=src/a.ts&line=7')
    expect(view.webContents.loads).toHaveLength(1) // no reload
    expect(openTargets(view)).toEqual([
      { workspace_path: '/ws', filepath: 'src/a.ts', line: '7' },
    ])
  })

  it('queues an open target racing the first load and flushes on did-finish-load', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    // Second open arrives before the entry finished loading.
    openView(mgr, host, 'acme.editor', '?workspace_path=/ws&filepath=b.ts')
    expect(openTargets(view)).toEqual([])

    view.webContents.emit('did-finish-load')
    expect(openTargets(view)).toEqual([{ workspace_path: '/ws', filepath: 'b.ts' }])
  })

  it('delivers an out-of-workspace open (file_ws) in-page without reloading', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws&http_url=http://x')
    view.webContents.emit('did-finish-load')

    // `file_ws` names the external file's own root; the workspace is unchanged,
    // so the view must keep its open tabs and just receive the target.
    openView(mgr, host, 'acme.editor', '?workspace_path=/ws&file_ws=/elsewhere&filepath=notes.md')
    expect(view.webContents.loads).toHaveLength(1) // no reload
    expect(openTargets(view)).toEqual([
      { workspace_path: '/ws', file_ws: '/elsewhere', filepath: 'notes.md' },
    ])
  })

  it('reloads the entry when the workspace changes (legacy routing)', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws-a')
    view.webContents.emit('did-finish-load')

    openView(mgr, host, 'acme.editor', '?workspace_path=/ws-b')
    expect(view.webContents.loads).toHaveLength(2) // reloaded with new params
    expect(openTargets(view)).toEqual([]) // no in-page delivery on reload
  })

  it('sizes a fill view to the host content bounds and tracks host resize', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    host.contentBounds = { x: 0, y: 0, width: 800, height: 600 }
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 800, height: 600 })

    host.contentBounds = { x: 0, y: 0, width: 1024, height: 768 }
    host.emit('resize')
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1024, height: 768 })

    // Hidden views stop tracking (listener removed on hide).
    mgr.deactivate('acme.editor')
    host.contentBounds = { x: 0, y: 0, width: 500, height: 400 }
    host.emit('resize')
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1024, height: 768 })
  })

  it('re-opening a running view reveals and focuses the hosting window', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    host.minimized = true
    host.shown = false

    openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    expect(view.visible).toBe(true)
    expect(host.minimized).toBe(false)
    expect(host.shown).toBe(true)
    expect(host.focusCount).toBeGreaterThan(0)
  })

  it('cross-window open keeps the view on its original host and focuses that host', () => {
    const mgr = new FrontendPluginManager()
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    const view = openView(mgr, hostA, 'acme.editor', '?workspace_path=/ws')

    openView(mgr, hostB, 'acme.editor', '?workspace_path=/ws&filepath=c.ts')
    expect(hostA.children).toContain(view)
    expect(hostB.children).not.toContain(view)
    expect(hostA.focusCount).toBeGreaterThan(0)
    expect(hostB.focusCount).toBe(0)
  })
})

describe('opaque view instance ownership', () => {
  function dispatchEvent(mgr: FrontendPluginManager, event: string, payload: unknown): void {
    ;(mgr as unknown as { dispatchEvent(event: string, payload: unknown): void }).dispatchEvent(
      event,
      payload
    )
  }

  function eventsOf(
    view: FakeViewLike,
    type: string
  ): Array<{ type: string; data: Record<string, unknown> }> {
    return view.webContents.sent
      .filter((message) => message.channel === 'plugin:cap:event')
      .map((message) => message.args[0] as { type: string; data: Record<string, unknown> })
      .filter((event) => event.type === type)
  }

  function output(id: string, data: string): Record<string, unknown> {
    return { terminal_session_id: id, pane_id: 'p', sequence: 1, data, stream: 'stdout' }
  }

  function packageDescriptor(id = 'acme.multi-view'): PluginLaunchDescriptor {
    return {
      id,
      packageVersion: '1.0.0',
      requires: [],
      devUrl: '',
      entryFile: `/plugins/${id}/fallback.html`,
      views: [
        {
          id: 'left',
          contributionKey: `${id}.left`,
          kind: 'custom',
          location: 'left',
          title: 'Left',
          entryFile: `/plugins/${id}/left.html`,
        },
        {
          id: 'window',
          contributionKey: `${id}.window`,
          kind: 'custom',
          location: 'window',
          title: 'Window',
          entryFile: `/plugins/${id}/window.html`,
        },
      ],
    }
  }

  function v2Context(options: {
    pluginId?: string
    packageVersion?: string
    workspaceId?: string
    audience?: string
    sessionId?: string
  } = {}): HostCapabilityContext {
    const binding = {
      pluginId: options.pluginId ?? 'acme.multi-view',
      packageVersion: options.packageVersion ?? '1.0.0',
      workspaceId: options.workspaceId ?? 'workspace-1',
      instanceId: 'host-placeholder',
      audience: options.audience ?? 'shared-audience',
    }
    return {
      publisherEligible: true,
      userGrant: { packageVersion: binding.packageVersion, system: ['fs', 'aiCli'] },
      runtimeBinding: binding,
      ...(options.sessionId
        ? { sessionBindings: new Map([[options.sessionId, binding]]) }
        : {}),
    }
  }

  function v2PackageDescriptor(id = 'acme.multi-view'): PluginLaunchDescriptor {
    return {
      ...packageDescriptor(id),
      requires: ['terminal'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs', 'aiCli'] }),
      capabilityContext: v2Context({ pluginId: id }),
    }
  }

  it('creates independently addressable opaque instances for one package', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()

    const left = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(hostA),
      bounds: { x: 1, y: 2, width: 300, height: 400 },
    })
    const window = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(hostB),
      bounds: { x: 5, y: 6, width: 700, height: 500 },
    })

    expect(left.instanceId).toBeTruthy()
    expect(window.instanceId).toBeTruthy()
    expect(left.instanceId).not.toBe(window.instanceId)
    expect(left.instanceId).not.toBe(packageDesc.id)
    expect(window.instanceId).not.toBe(packageDesc.id)
    expect(hostA.children).toHaveLength(1)
    expect(hostB.children).toHaveLength(1)
    expect((hostA.children[0] as FakeViewLike).webContents.loads).toEqual([
      packageDesc.views![0].entryFile,
    ])
    expect((hostB.children[0] as FakeViewLike).webContents.loads).toEqual([
      packageDesc.views![1].entryFile,
    ])
    expect(hostA.focusCount).toBeGreaterThan(0)
    expect(hostB.focusCount).toBeGreaterThan(0)
    expect((hostA.children[0] as FakeViewLike).webContents.focusCount).toBeGreaterThan(0)
    expect((hostB.children[0] as FakeViewLike).webContents.focusCount).toBeGreaterThan(0)
  })

  it('resolves stale catalog objects against the current registered package', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)

    const stalePackage: PluginLaunchDescriptor = {
      ...packageDesc,
      views: packageDesc.views!.map((view) => ({
        ...view,
        entryFile: '/plugins/stale/forged.html',
      })),
    }
    mgr.setCapabilityContext(packageDesc.id, null)

    const host = new FakeBrowserWindow()
    await mgr.openView(stalePackage, stalePackage.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
    })

    expect((host.children[0] as FakeViewLike).webContents.loads).toEqual([
      packageDesc.views![0].entryFile,
    ])
  })

  it('targets bounds, visibility, focus, and destruction by handle only', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    const left = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(hostA),
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    })
    const window = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(hostB),
      bounds: { x: 10, y: 20, width: 200, height: 150 },
    })
    const leftView = hostA.children[0] as FakeViewLike
    const windowView = hostB.children[0] as FakeViewLike

    mgr.setBounds(left.instanceId, { x: 1, y: 2, width: 300, height: 250 })
    expect(leftView.bounds).toEqual({ x: 1, y: 2, width: 300, height: 250 })
    expect(windowView.bounds).toEqual({ x: 10, y: 20, width: 200, height: 150 })

    mgr.deactivate(left.instanceId)
    expect(leftView.visible).toBe(false)
    expect(windowView.visible).toBe(true)
    const hostFocusBeforeActivate = hostA.focusCount
    const viewFocusBeforeActivate = leftView.webContents.focusCount
    mgr.activate(left.instanceId)
    expect(leftView.visible).toBe(true)
    expect(hostA.focusCount).toBe(hostFocusBeforeActivate)
    expect(leftView.webContents.focusCount).toBe(viewFocusBeforeActivate)

    mgr.focusInstance(left.instanceId)
    expect(hostA.focusCount).toBeGreaterThan(hostFocusBeforeActivate)
    expect(leftView.webContents.focusCount).toBeGreaterThan(viewFocusBeforeActivate)

    mgr.destroyInstance(left.instanceId)
    expect(leftView.webContents.isDestroyed()).toBe(true)
    expect(hostA.children).not.toContain(leftView)
    expect(windowView.webContents.isDestroyed()).toBe(false)
    expect(hostB.children).toContain(windowView)

    mgr.setBounds(window.instanceId, { x: 9, y: 8, width: 700, height: 600 })
    expect(windowView.bounds).toEqual({ x: 9, y: 8, width: 700, height: 600 })
  })

  it('cleans a dead v2 instance without disturbing its sibling', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    const left = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(hostA),
      bounds: 'fill',
    })
    const window = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(hostB),
      bounds: 'fill',
    })
    const leftView = hostA.children[0] as FakeViewLike
    const windowView = hostB.children[0] as FakeViewLike
    const staleSender = leftView.webContents.id

    leftView.webContents.close()

    expect(leftView.webContents.isDestroyed()).toBe(true)
    expect(hostA.children).not.toContain(leftView)
    expect(windowView.webContents.isDestroyed()).toBe(false)
    mgr.setBounds(window.instanceId, { x: 4, y: 5, width: 600, height: 400 })
    expect(windowView.bounds).toEqual({ x: 4, y: 5, width: 600, height: 400 })

    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()
    await expect(
      call!({ sender: { id: staleSender } }, { reqId: 'dead', ns: 'ping', method: 'ping', args: {} })
    ).resolves.toEqual({
      reqId: '',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'unknown plugin sender' },
    })
    expect(window.instanceId).toBeTruthy()
  })

  it('destroys every live instance when a package is removed', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(hostA),
      bounds: 'fill',
    })
    await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(hostB),
      bounds: 'fill',
    })
    const leftView = hostA.children[0] as FakeViewLike
    const windowView = hostB.children[0] as FakeViewLike

    mgr.removeInstalledPlugin(packageDesc.id)

    expect(leftView.webContents.isDestroyed()).toBe(true)
    expect(windowView.webContents.isDestroyed()).toBe(true)
    expect(hostA.children).toHaveLength(0)
    expect(hostB.children).toHaveLength(0)
  })

  it('keeps v1 and v2 instances independent for the same package id', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const legacyHost = new FakeBrowserWindow()
    const v2Host = new FakeBrowserWindow()
    mgr.open(
      asHost(legacyHost),
      { id: packageDesc.id, requires: [], devUrl: '', entryFile: '/plugins/legacy/index.html' },
      'fill'
    )
    const legacyView = legacyHost.children[0] as FakeViewLike
    const v2 = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(v2Host),
      bounds: 'fill',
    })
    const v2View = v2Host.children[0] as FakeViewLike

    mgr.destroy(v2.instanceId)
    expect(v2View.webContents.isDestroyed()).toBe(false)
    mgr.destroyInstance(v2.instanceId)
    expect(legacyView.webContents.isDestroyed()).toBe(false)
    expect(v2View.webContents.isDestroyed()).toBe(true)

    mgr.destroy(packageDesc.id)
    expect(legacyView.webContents.isDestroyed()).toBe(true)
  })

  it('routes v2 events to their authenticated instance and audience', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = v2PackageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    const leftContext = v2Context({ audience: 'left-audience', sessionId: 'left-session' })
    const windowContext = v2Context({ audience: 'window-audience', sessionId: 'window-session' })
    const left = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(hostA),
      bounds: 'fill',
      capabilityContext: leftContext,
    })
    const window = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(hostB),
      bounds: 'fill',
      capabilityContext: windowContext,
    })
    const leftView = hostA.children[0] as FakeViewLike
    const windowView = hostB.children[0] as FakeViewLike

    const leftSource = { ...leftContext.runtimeBinding!, instanceId: left.instanceId }
    const windowSource = { ...windowContext.runtimeBinding!, instanceId: window.instanceId }
    mgr.dispatchPublicCapabilityEvent(
      packageDesc.id,
      'aiCli.output',
      { sessionId: 'left-session', data: 'left only' },
      leftSource
    )
    expect(eventsOf(leftView, 'aiCli.output')).toHaveLength(1)
    expect(eventsOf(windowView, 'aiCli.output')).toHaveLength(0)

    mgr.dispatchPublicCapabilityEvent(
      packageDesc.id,
      'aiCli.output',
      { sessionId: 'window-session', data: 'window only' },
      windowSource
    )
    expect(eventsOf(leftView, 'aiCli.output')).toHaveLength(1)
    expect(eventsOf(windowView, 'aiCli.output')).toHaveLength(1)

    // Shared backend fan-out carries no authenticated public-event source and
    // must not be treated as an AI CLI event source.
    dispatchEvent(mgr, 'aiCli.output', { sessionId: 'left-session', data: 'unbound' })
    expect(eventsOf(leftView, 'aiCli.output')).toHaveLength(1)

    mgr.dispatchPublicCapabilityEvent(
      packageDesc.id,
      'aiCli.output',
      { sessionId: 'left-session', data: 'stale' },
      { ...leftSource, instanceId: 'stale-instance' }
    )
    expect(eventsOf(leftView, 'aiCli.output')).toHaveLength(1)

    const fileEvent = { changes: [{ path: 'README.md', kind: 'changed' }] }
    mgr.dispatchPublicCapabilityEvent(packageDesc.id, 'workspace.filesChanged', fileEvent, {
      pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
      packageVersion: '1.0.0',
      workspaceId: 'workspace-1',
      instanceId: null,
      audience: null,
    })
    expect(eventsOf(leftView, 'workspace.filesChanged')).toHaveLength(1)
    expect(eventsOf(windowView, 'workspace.filesChanged')).toHaveLength(1)

    mgr.dispatchPublicCapabilityEvent(packageDesc.id, 'workspace.filesChanged', fileEvent, {
      pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
      packageVersion: '2.0.0',
      workspaceId: 'workspace-1',
      instanceId: null,
      audience: null,
    })
    expect(eventsOf(leftView, 'workspace.filesChanged')).toHaveLength(1)
    expect(eventsOf(windowView, 'workspace.filesChanged')).toHaveLength(1)
  })

  it('does not route workspace events across packages sharing version and workspace', async () => {
    const mgr = new FrontendPluginManager()
    const firstPackage = v2PackageDescriptor('acme.files-one')
    const secondPackage = v2PackageDescriptor('acme.files-two')
    mgr.registerDescriptor(firstPackage)
    mgr.registerDescriptor(secondPackage)
    const firstHost = new FakeBrowserWindow()
    const secondHost = new FakeBrowserWindow()

    await mgr.openView(firstPackage, firstPackage.views![0], {
      hostWindow: asHost(firstHost),
      bounds: 'fill',
      capabilityContext: v2Context({ pluginId: firstPackage.id }),
    })
    await mgr.openView(secondPackage, secondPackage.views![0], {
      hostWindow: asHost(secondHost),
      bounds: 'fill',
      capabilityContext: v2Context({ pluginId: secondPackage.id }),
    })

    const payload = { changes: [{ path: 'README.md', kind: 'changed' }] }
    mgr.dispatchPublicCapabilityEvent(firstPackage.id, 'workspace.filesChanged', payload, {
      pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
      packageVersion: '1.0.0',
      workspaceId: 'workspace-1',
      instanceId: null,
      audience: null,
    })

    expect(eventsOf(firstHost.children[0] as FakeViewLike, 'workspace.filesChanged')).toHaveLength(1)
    expect(eventsOf(secondHost.children[0] as FakeViewLike, 'workspace.filesChanged')).toHaveLength(0)
  })

  it('treats omitted and undefined context as the registry context, while null denies access', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = v2PackageDescriptor()
    const registryContext = v2Context({ audience: 'registry-audience', sessionId: 'registry-session' })
    mgr.registerDescriptor({ ...packageDesc, capabilityContext: registryContext })

    const omittedHost = new FakeBrowserWindow()
    const undefinedHost = new FakeBrowserWindow()
    const deniedHost = new FakeBrowserWindow()
    const omitted = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(omittedHost),
      bounds: 'fill',
    })
    const withUndefined = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(undefinedHost),
      bounds: 'fill',
      capabilityContext: undefined,
    })
    await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(deniedHost),
      bounds: 'fill',
      capabilityContext: null,
    })

    const source = (instanceId: string) => ({
      ...registryContext.runtimeBinding!,
      instanceId,
    })
    mgr.dispatchPublicCapabilityEvent(
      packageDesc.id,
      'aiCli.output',
      { sessionId: 'registry-session', data: 'allowed' },
      source(omitted.instanceId)
    )
    mgr.dispatchPublicCapabilityEvent(
      packageDesc.id,
      'aiCli.output',
      { sessionId: 'registry-session', data: 'also allowed' },
      source(withUndefined.instanceId)
    )

    expect(eventsOf(omittedHost.children[0] as FakeViewLike, 'aiCli.output')).toHaveLength(1)
    expect(eventsOf(undefinedHost.children[0] as FakeViewLike, 'aiCli.output')).toHaveLength(1)
    expect(eventsOf(deniedHost.children[0] as FakeViewLike, 'aiCli.output')).toHaveLength(0)
  })

  it('rejects an override whose package identity or grant version is not canonical', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = v2PackageDescriptor()
    mgr.registerDescriptor(packageDesc)

    for (const context of [
      v2Context({ pluginId: 'acme.other' }),
      v2Context({ packageVersion: '2.0.0' }),
      {
        ...v2Context(),
        userGrant: { packageVersion: '2.0.0', system: ['fs', 'aiCli'] as const },
      },
    ]) {
      await expect(
        mgr.openView(packageDesc, packageDesc.views![0], {
          hostWindow: asHost(new FakeBrowserWindow()),
          bounds: 'fill',
          capabilityContext: context,
        })
      ).rejects.toThrow(/context/i)
    }
  })

  it('validates v2 identity and rebinds context even under a legacy policy', async () => {
    const mgr = new FrontendPluginManager()
    const context = v2Context({ audience: 'legacy-policy-audience' })
    const packageDesc = { ...packageDescriptor(), capabilityContext: context }
    mgr.registerDescriptor(packageDesc)
    const host = new FakeBrowserWindow()

    mgr.open(asHost(host), packageDesc, 'fill')
    const legacyView = host.children[0] as FakeViewLike
    const running = (mgr as unknown as {
      running: Map<string, { instanceId: string; capabilityContext: HostCapabilityContext | null }>
    }).running
    const instance = [...running.values()].find(
      (candidate) => candidate.capabilityContext?.runtimeBinding?.audience === 'legacy-policy-audience'
    )
    expect(instance?.capabilityContext?.runtimeBinding?.instanceId).toBeTruthy()
    expect(instance?.capabilityContext?.runtimeBinding?.instanceId).not.toBe(
      context.runtimeBinding?.instanceId
    )
    expect(legacyView.webContents.isDestroyed()).toBe(false)
    expect(() =>
      mgr.open(
        asHost(host),
        { ...packageDesc, capabilityContext: v2Context({ pluginId: 'acme.other' }) },
        'fill'
      )
    ).toThrow(/context/i)

    await expect(
      mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(new FakeBrowserWindow()),
        bounds: 'fill',
        capabilityContext: v2Context({ packageVersion: '2.0.0' }),
      })
    ).rejects.toThrow(/context/i)
  })

  it('keeps v2 PTY restrictions when opened through the legacy adapter', () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = v2PackageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const host = new FakeBrowserWindow()

    mgr.open(asHost(host), packageDesc, 'fill')
    mgr.noteTerminalRoutes(packageDesc.id, 'terminal.create', {
      terminal_session_id: 'legacy-open-v2-session',
    })

    expect(
      mgr.filterTerminalReattachPayload(packageDesc.id, {
        terminal_session_ids: ['legacy-open-v2-session', 'unknown'],
      }).terminal_session_ids
    ).toEqual(['legacy-open-v2-session'])

    mgr.setCapabilityContext(
      packageDesc.id,
      v2Context({ audience: 'changed-audience' })
    )

    expect(
      mgr.filterTerminalReattachPayload(packageDesc.id, {
        terminal_session_ids: ['legacy-open-v2-session', 'unknown'],
      }).terminal_session_ids
    ).toEqual([])
  })

  it('leaves the running context unchanged when a replacement context is invalid', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = v2PackageDescriptor()
    const context = v2Context({ audience: 'stable-audience', sessionId: 'stable-session' })
    mgr.registerDescriptor({ ...packageDesc, capabilityContext: context })
    const host = new FakeBrowserWindow()
    const handle = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
    })

    expect(() =>
      mgr.setCapabilityContext(packageDesc.id, v2Context({ packageVersion: '2.0.0' }))
    ).toThrow(/context/i)
    const source = { ...context.runtimeBinding!, instanceId: handle.instanceId }
    mgr.dispatchPublicCapabilityEvent(
      packageDesc.id,
      'aiCli.output',
      { sessionId: 'stable-session', data: 'unchanged' },
      source
    )
    expect(eventsOf(host.children[0] as FakeViewLike, 'aiCli.output')).toHaveLength(1)
  })

  it('updates session bindings without detaching a route with the same live tuple', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDesc = v2PackageDescriptor()
      const oldContext = v2Context({ audience: 'same-audience', sessionId: 'old-session' })
      mgr.registerDescriptor({ ...packageDesc, capabilityContext: oldContext })
      const host = new FakeBrowserWindow()
      const handle = await mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(host),
        bounds: 'fill',
      })
      mgr.noteTerminalRoutes(handle.instanceId, 'terminal.create', {
        terminal_session_id: 'stable-route',
      })

      const newContext = v2Context({ audience: 'same-audience', sessionId: 'new-session' })
      mgr.setCapabilityContext(packageDesc.id, newContext)
      dispatchEvent(mgr, 'terminal.output', output('stable-route', 'still attached'))
      vi.advanceTimersByTime(12)

      expect(eventsOf(host.children[0] as FakeViewLike, 'terminal.output')).toHaveLength(1)
      const source = { ...newContext.runtimeBinding!, instanceId: handle.instanceId }
      mgr.dispatchPublicCapabilityEvent(
        packageDesc.id,
        'aiCli.output',
        { sessionId: 'new-session', data: 'new binding reached the view' },
        source
      )
      expect(eventsOf(host.children[0] as FakeViewLike, 'aiCli.output')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('detaches routes when the tuple changes or the grant is revoked', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDesc = v2PackageDescriptor()
      const context = v2Context({ audience: 'original-audience' })
      mgr.registerDescriptor({ ...packageDesc, capabilityContext: context })
      const host = new FakeBrowserWindow()
      const handle = await mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(host),
        bounds: 'fill',
      })
      const view = host.children[0] as FakeViewLike
      mgr.noteTerminalRoutes(handle.instanceId, 'terminal.create', {
        terminal_session_id: 'detached-route',
      })

      mgr.setCapabilityContext(
        packageDesc.id,
        v2Context({ audience: 'new-audience' })
      )
      dispatchEvent(mgr, 'terminal.output', output('detached-route', 'must drop'))
      vi.advanceTimersByTime(12)
      expect(eventsOf(view, 'terminal.output')).toHaveLength(0)

      mgr.noteTerminalRoutes(handle.instanceId, 'terminal.reattach', {
        alive: ['detached-route'],
      })
      mgr.setCapabilityContext(packageDesc.id, {
        ...v2Context({ audience: 'new-audience' }),
        userGrant: null,
      })
      expect(
        mgr.filterTerminalReattachPayload(handle.instanceId, {
          terminal_session_ids: ['detached-route'],
        }).terminal_session_ids
      ).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an empty workspace or audience binding before mounting', async () => {
    for (const context of [
      v2Context({ workspaceId: '' }),
      v2Context({ audience: '' }),
    ]) {
      const mgr = new FrontendPluginManager()
      const packageDesc = v2PackageDescriptor()
      mgr.registerDescriptor({ ...packageDesc, capabilityContext: context })
      const host = new FakeBrowserWindow()
      await expect(
        mgr.openView(packageDesc, packageDesc.views![0], {
          hostWindow: asHost(host),
          bounds: 'fill',
        })
      ).rejects.toThrow(/context/i)
      expect(host.children).toHaveLength(0)
    }
  })

  it('drops a v2 instance batch without affecting a sibling', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDesc = v2PackageDescriptor()
      mgr.registerDescriptor(packageDesc)
      const hostA = new FakeBrowserWindow()
      const hostB = new FakeBrowserWindow()
      const left = await mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(hostA),
        bounds: 'fill',
        capabilityContext: v2Context({ audience: 'left-audience' }),
      })
      await mgr.openView(packageDesc, packageDesc.views![1], {
        hostWindow: asHost(hostB),
        bounds: 'fill',
        capabilityContext: v2Context({ audience: 'window-audience' }),
      })
      const leftView = hostA.children[0] as FakeViewLike
      const windowView = hostB.children[0] as FakeViewLike

      mgr.noteTerminalRoutes(left.instanceId, 'terminal.create', { terminal_session_id: 't-14-batch' })
      ;(
        mgr as unknown as {
          dispatchEvent(event: string, payload: unknown): void
        }
      ).dispatchEvent('terminal.output', {
        terminal_session_id: 't-14-batch',
        data: 'sibling output',
        sequence: 1,
      })
      leftView.webContents.close()
      vi.advanceTimersByTime(12)

      expect(leftView.webContents.isDestroyed()).toBe(true)
      expect(windowView.webContents.isDestroyed()).toBe(false)
      const outputs = windowView.webContents.sent
        .filter((message) => message.channel === 'plugin:cap:event')
        .map((message) => message.args[0] as { type: string; data: Record<string, unknown> })
        .filter((event) => event.type === 'terminal.output')
      expect(outputs).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reattaches a detached v2 PTY only with the full ownership tuple', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDesc = v2PackageDescriptor()
      mgr.registerDescriptor(packageDesc)
      const originalHost = new FakeBrowserWindow()
      const siblingHost = new FakeBrowserWindow()
      const originalContext = v2Context({ audience: 'left-audience' })
      const siblingContext = v2Context({ audience: 'sibling-audience' })
      const original = await mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(originalHost),
        bounds: 'fill',
        capabilityContext: originalContext,
      })
      const sibling = await mgr.openView(packageDesc, packageDesc.views![1], {
        hostWindow: asHost(siblingHost),
        bounds: 'fill',
        capabilityContext: siblingContext,
      })
      const originalView = originalHost.children[0] as FakeViewLike
      const siblingView = siblingHost.children[0] as FakeViewLike
      mgr.noteTerminalRoutes(original.instanceId, 'terminal.create', {
        terminal_session_id: 't-v2-reconnect',
      })
      originalView.webContents.close()

      expect(
        mgr.filterTerminalReattachPayload(sibling.instanceId, {
          terminal_session_ids: ['t-v2-reconnect'],
        }).terminal_session_ids
      ).toEqual([])

      for (const context of [
        v2Context({ workspaceId: 'workspace-2', audience: 'left-audience' }),
        v2Context({ audience: 'other-audience' }),
      ]) {
        const wrongOwner = await mgr.openView(packageDesc, packageDesc.views![0], {
          hostWindow: asHost(new FakeBrowserWindow()),
          bounds: 'fill',
          capabilityContext: context,
        })
        expect(
          mgr.filterTerminalReattachPayload(wrongOwner.instanceId, {
            terminal_session_ids: ['t-v2-reconnect'],
          }).terminal_session_ids
        ).toEqual([])
      }

      const reopenedHost = new FakeBrowserWindow()
      const reopened = await mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(reopenedHost),
        bounds: 'fill',
        capabilityContext: v2Context({ audience: 'left-audience' }),
      })
      expect(
        mgr.filterTerminalReattachPayload(reopened.instanceId, {
          terminal_session_ids: ['t-v2-reconnect', 'unknown'],
        }).terminal_session_ids
      ).toEqual(['t-v2-reconnect'])

      mgr.noteTerminalRoutes(reopened.instanceId, 'terminal.reattach', {
        alive: ['t-v2-reconnect'],
        dead: [],
      })
      dispatchEvent(mgr, 'terminal.output', output('t-v2-reconnect', 'reconnected'))
      vi.advanceTimersByTime(12)
      expect(eventsOf(reopenedHost.children[0] as FakeViewLike, 'terminal.output')).toHaveLength(1)
      expect(eventsOf(siblingView, 'terminal.output')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('disposes subscriptions for only the destroyed instance', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const left = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(new FakeBrowserWindow()),
      bounds: 'fill',
    })
    const sibling = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(new FakeBrowserWindow()),
      bounds: 'fill',
    })
    const leftDispose = vi.fn()
    const siblingDispose = vi.fn()
    const unregisterLeft = mgr.registerInstanceSubscription(left.instanceId, leftDispose)
    mgr.registerInstanceSubscription(sibling.instanceId, siblingDispose)

    unregisterLeft()
    expect(leftDispose).toHaveBeenCalledTimes(1)

    mgr.destroyInstance(left.instanceId)

    expect(leftDispose).toHaveBeenCalledTimes(1)
    expect(siblingDispose).not.toHaveBeenCalled()
  })

  it('loads each v2 contribution entry file in renderer dev mode', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://renderer.test')
    try {
      const mgr = new FrontendPluginManager()
      const packageDesc = { ...packageDescriptor(), devUrl: 'http://package.test' }
      mgr.registerDescriptor(packageDesc)
      const host = new FakeBrowserWindow()

      await mgr.openView(packageDesc, packageDesc.views![1], {
        hostWindow: asHost(host),
        bounds: 'fill',
      })

      expect((host.children[0] as FakeViewLike).webContents.loads).toEqual([
        packageDesc.views![1].entryFile,
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects unknown contribution keys and plugin-supplied or sibling instance ids', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    const left = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(hostA),
      bounds: 'fill',
    })
    const window = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(hostB),
      bounds: 'fill',
    })
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    await expect(
      mgr.openView(
        packageDesc,
        { ...packageDesc.views![0], contributionKey: 'acme.multi-view.spoof' },
        {
          hostWindow: asHost(new FakeBrowserWindow()),
          bounds: 'fill',
        }
      )
    ).rejects.toThrow(/not registered by the Host package descriptor/)

    const response = await call!(
      { sender: { id: (hostB.children[0] as FakeViewLike).webContents.id } },
      { reqId: 'spoofed', instanceId: left.instanceId, ns: 'ping', method: 'ping', args: {} }
    )
    expect(response).toEqual({
      reqId: 'spoofed',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'instance identity is Host-owned' },
    })
    await expect(
      call!(
        { sender: { id: (hostB.children[0] as FakeViewLike).webContents.id } },
        { reqId: 'undefined-instance', instanceId: undefined, ns: 'ping', method: 'ping', args: {} }
      )
    ).resolves.toEqual({
      reqId: 'undefined-instance',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'instance identity is Host-owned' },
    })
    expect(window.instanceId).not.toBe(left.instanceId)

    const staleSender = (hostB.children[0] as FakeViewLike).webContents.id
    mgr.destroyInstance(window.instanceId)
    await expect(
      call!({ sender: { id: staleSender } }, { reqId: 'stale', ns: 'ping', method: 'ping', args: {} })
    ).resolves.toEqual({
      reqId: '',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'unknown plugin sender' },
    })
  })

  it('rebinds v2 capability context to the Host-generated instance', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc: PluginLaunchDescriptor = {
      ...packageDescriptor(),
      id: 'acme.runtime-view',
      requires: ['shell'],
      capabilityPolicy: manifestV2CapabilityPolicy({ shell: 'allowlist' }),
      capabilityContext: {
        publisherEligible: false,
        userGrant: { packageVersion: '1.0.0', system: [], shell: 'allowlist' },
        runtimeBinding: {
          pluginId: 'acme.runtime-view',
          packageVersion: '1.0.0',
          workspaceId: 'workspace-1',
          instanceId: 'plugin-supplied-instance',
          audience: 'audience-1',
        },
      },
    }
    mgr.registerDescriptor(packageDesc)
    const host = new FakeBrowserWindow()
    const handle = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
    })
    const plans: unknown[] = []
    mgr.setPublicCapabilityHandler((plan) => {
      plans.push(plan)
      return { accepted: true }
    })
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    const response = await call!(
      { sender: { id: (host.children[0] as FakeViewLike).webContents.id } },
      { reqId: 'r1', ns: 'shell', method: 'run', args: { command: 'git status' } }
    )
    expect(response).toMatchObject({ ok: true, result: { accepted: true } })
    expect(plans[0]).toMatchObject({ runtime: { instanceId: handle.instanceId } })
    expect(plans[0]).not.toMatchObject({ runtime: { instanceId: 'plugin-supplied-instance' } })
  })
})

describe('terminal PTY routing + output micro-batching', () => {
  const CAP_EVENT = 'plugin:cap:event'

  interface DispatchSeam {
    dispatchEvent(event: string, payload: unknown): void
  }

  function dispatch(mgr: FrontendPluginManager, event: string, payload: unknown): void {
    ;(mgr as unknown as DispatchSeam).dispatchEvent(event, payload)
  }

  function eventsOf(
    view: FakeViewLike,
    type: string
  ): Array<{ type: string; data: Record<string, unknown> }> {
    return view.webContents.sent
      .filter((m) => m.channel === CAP_EVENT)
      .map((m) => m.args[0] as { type: string; data: Record<string, unknown> })
      .filter((e) => e.type === type)
  }

  function openTerminalPlugin(
    mgr: FrontendPluginManager,
    host: FakeBrowserWindow,
    id: string,
    requires: string[] = ['terminal']
  ): FakeViewLike {
    const before = views.length
    mgr.open(
      asHost(host),
      { id, requires, devUrl: '', entryFile: `/plugins/${id}/index.html` },
      { x: 0, y: 0, width: 10, height: 10 }
    )
    return views.length > before ? views[views.length - 1] : views[before - 1]
  }

  function output(id: string, data: string, sequence = 1): Record<string, unknown> {
    return { terminal_session_id: id, pane_id: 'p', sequence, data, stream: 'stdout' }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers batched output ONLY to the plugin whose create bound the session', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')

    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })
    dispatch(mgr, 'terminal.output', output('t-1', 'hi'))
    vi.advanceTimersByTime(12)

    expect(eventsOf(viewA, 'terminal.output')).toHaveLength(1)
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0)
  })

  it('coalesces an output burst into one IPC send with concatenated data', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openTerminalPlugin(mgr, host, 'acme.term-a')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })

    dispatch(mgr, 'terminal.output', output('t-1', 'he', 1))
    dispatch(mgr, 'terminal.output', output('t-1', 'll', 2))
    dispatch(mgr, 'terminal.output', output('t-1', 'o', 3))
    expect(eventsOf(view, 'terminal.output')).toHaveLength(0) // still batching
    vi.advanceTimersByTime(12)

    const got = eventsOf(view, 'terminal.output')
    expect(got).toHaveLength(1)
    expect(got[0].data.data).toBe('hello')
    expect(got[0].data.sequence).toBe(3) // last event's fields ride along
  })

  it('flushes pending output before terminal.exit and retires the route', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })

    dispatch(mgr, 'terminal.output', output('t-1', 'bye'))
    dispatch(mgr, 'terminal.exit', { terminal_session_id: 't-1', exit_code: 0 })

    // Output landed BEFORE exit despite the batch window (ordering barrier).
    const all = viewA.webContents.sent
      .filter((m) => m.channel === CAP_EVENT)
      .map((m) => (m.args[0] as { type: string }).type)
    expect(all).toEqual(['terminal.output', 'terminal.exit'])
    expect(eventsOf(viewB, 'terminal.exit')).toHaveLength(0)

    // The route is gone: later output for the id is DROPPED (never fanned out).
    dispatch(mgr, 'terminal.output', output('t-1', 'late'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(viewA, 'terminal.output')).toHaveLength(1) // just the flush
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0)
  })

  it('drops output/exit for sessions no plugin bound (no fan-out)', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')

    dispatch(mgr, 'terminal.output', output('t-9', 'orphan'))
    dispatch(mgr, 'terminal.exit', { terminal_session_id: 't-9', exit_code: 0 })
    vi.advanceTimersByTime(12)

    expect(eventsOf(viewA, 'terminal.output')).toHaveLength(0)
    expect(eventsOf(viewA, 'terminal.exit')).toHaveLength(0)
  })

  it('registers every alive session from a reattach response', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-b', 'terminal.reattach', { alive: ['t-1', 't-2'], dead: [] })

    dispatch(mgr, 'terminal.output', output('t-1', 'a'))
    dispatch(mgr, 'terminal.output', output('t-2', 'b'))
    vi.advanceTimersByTime(12)

    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(2)
    expect(eventsOf(viewA, 'terminal.output')).toHaveLength(0)
  })

  it('destroy drops pending batches and keeps the route marked — output never leaks', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })

    dispatch(mgr, 'terminal.output', output('t-1', 'secret'))
    mgr.destroy('acme.term-a')
    vi.advanceTimersByTime(12)
    // The dead view's pending batch is dropped, never fanned out to others.
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0)

    // The route entry is RETAINED with the dead owner: later output for the id
    // is dropped, not delivered to unrelated plugins.
    dispatch(mgr, 'terminal.output', output('t-1', 'later'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0)
  })

  it('a renderer crash runs the same terminal teardown as destroy()', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })

    dispatch(mgr, 'terminal.output', output('t-1', 'secret'))
    viewA.webContents.close() // crash path — fires the 'destroyed' hook
    vi.advanceTimersByTime(12)
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0) // batch dropped

    // Route retained: the crashed plugin's session is still owned by it, so a
    // sibling's reattach may not claim it (see the filter test below).
    const filtered = mgr.filterTerminalReattachPayload('acme.term-b', {
      terminal_session_ids: ['t-1'],
      cols: 0,
      rows: 0,
    })
    expect(filtered.terminal_session_ids).toEqual([])
  })

  it('re-claim after teardown: the SAME plugin reattaches and delivery resumes', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    openTerminalPlugin(mgr, host, 'acme.term-a')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })
    mgr.destroy('acme.term-a')

    // A stale sender cannot use the retained route as an authentication token.
    expect(
      mgr.filterTerminalReattachPayload('acme.term-a', {
        terminal_session_ids: ['t-1'],
      }).terminal_session_ids
    ).toEqual([])

    // Reopened view of the same plugin: its own retained id passes the filter…
    const reopened = openTerminalPlugin(mgr, host, 'acme.term-a')
    const payload = mgr.filterTerminalReattachPayload('acme.term-a', {
      terminal_session_ids: ['t-1'],
    })
    expect(payload.terminal_session_ids).toEqual(['t-1'])

    // …and after the reattach response re-registers, delivery resumes.
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.reattach', { alive: ['t-1'], dead: [] })
    dispatch(mgr, 'terminal.output', output('t-1', 'back'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(reopened, 'terminal.output')).toHaveLength(1)
  })

  it('reattach filter strips ids owned by another plugin, keeps own and unknown ids', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    openTerminalPlugin(mgr, host, 'acme.term-a')
    openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-a' })
    mgr.noteTerminalRoutes('acme.term-b', 'terminal.create', { terminal_session_id: 't-b' })

    const payload = mgr.filterTerminalReattachPayload('acme.term-b', {
      terminal_session_ids: ['t-a', 't-b', 't-unknown'],
      cols: 80,
      rows: 24,
    })
    // The live sibling's session is stripped; own + never-seen ids pass
    // (never-seen covers app-restart re-claims and non-broker PTYs).
    expect(payload.terminal_session_ids).toEqual(['t-b', 't-unknown'])
    expect(payload.cols).toBe(80) // other fields untouched

    // A payload without an ids array passes through unchanged.
    const untouched = { cols: 80 }
    expect(mgr.filterTerminalReattachPayload('acme.term-b', untouched)).toBe(untouched)

    const fresh = openTerminalPlugin(mgr, host, 'acme.term-fresh')
    expect(
      mgr.filterTerminalReattachPayload('acme.term-fresh', {
        terminal_session_ids: ['after-host-restart'],
      }).terminal_session_ids
    ).toEqual(['after-host-restart'])
    expect(fresh.webContents.isDestroyed()).toBe(false)
  })

  it('cancels an in-flight create and kills a late committed success exactly once', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openTerminalPlugin(mgr, host, 'acme.term-pending')
    mgr.setBackendWsUrl('ws://plugin-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    const create = call!({ sender: { id: view.webContents.id } }, {
      reqId: 'create',
      ns: 'terminal',
      method: 'create',
      args: { pane_id: 'pane-pending', create_generation: 'generation-1' },
    }) as Promise<unknown>
    await Promise.resolve()
    const createRequest = JSON.parse(socket.sent.at(-1)!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(createRequest.type).toBe('terminal.create')

    mgr.destroy('acme.term-pending')
    const cancelRequest = JSON.parse(socket.sent.at(-1)!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(cancelRequest.type).toBe('terminal.create.cancel')
    expect(cancelRequest.payload).toEqual({
      pane_id: 'pane-pending',
      create_generation: 'generation-1',
    })
    expect(socket.sent.map((raw) => JSON.parse(raw).type)).not.toContain('terminal.kill')

    socket.receive({
      id: cancelRequest.id,
      type: 'terminal.create.cancel',
      ok: true,
      payload: { cancelled: false },
      error: null,
      timestamp: '',
    })
    socket.receive({
      id: createRequest.id,
      type: 'terminal.create',
      ok: true,
      payload: {
        terminal_session_id: 'late-session',
        pane_id: 'pane-pending',
        create_generation: 'generation-1',
      },
      error: null,
      timestamp: '',
    })
    await expect(create).resolves.toMatchObject({ ok: true })

    const killRequests = socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> })
      .filter((request) => request.type === 'terminal.kill')
    expect(killRequests).toHaveLength(1)
    expect(killRequests[0].payload).toEqual({
      terminal_session_id: 'late-session',
      force: true,
    })

    // A duplicate late response cannot trigger a second cleanup request.
    socket.receive({
      id: createRequest.id,
      type: 'terminal.create',
      ok: true,
      payload: {
        terminal_session_id: 'late-session',
        pane_id: 'pane-pending',
        create_generation: 'generation-1',
      },
      error: null,
      timestamp: '',
    })
    expect(
      socket.sent.map((raw) => JSON.parse(raw).type).filter((type) => type === 'terminal.kill')
    ).toHaveLength(1)

    dispatch(mgr, 'terminal.output', output('late-session', 'must drop'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(view, 'terminal.output')).toHaveLength(0)
    expect(
      mgr.filterTerminalReattachPayload('acme.term-pending', {
        terminal_session_ids: ['late-session'],
      }).terminal_session_ids
    ).toEqual([])
  })

  it('does not kill a late create response with invalid ownership metadata', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openTerminalPlugin(mgr, host, 'acme.term-invalid-late')
    mgr.setBackendWsUrl('ws://plugin-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    const create = call!({ sender: { id: view.webContents.id } }, {
      reqId: 'create-invalid-late',
      ns: 'terminal',
      method: 'create',
      args: { pane_id: 'pane-invalid-late', create_generation: 'generation-invalid-late' },
    }) as Promise<unknown>
    await Promise.resolve()
    const createRequest = JSON.parse(socket.sent.at(-1)!) as { id: string }
    mgr.destroy('acme.term-invalid-late')
    const cancelRequest = JSON.parse(socket.sent.at(-1)!) as { id: string }

    socket.receive({
      id: cancelRequest.id,
      type: 'terminal.create.cancel',
      ok: true,
      payload: { cancelled: false },
      error: null,
      timestamp: '',
    })
    socket.receive({
      id: createRequest.id,
      type: 'terminal.create',
      ok: true,
      payload: {
        terminal_session_id: 42,
        pane_id: 'pane-invalid-late',
        create_generation: 'generation-invalid-late',
      },
      error: null,
      timestamp: '',
    })
    await expect(create).resolves.toMatchObject({ ok: true })
    expect(socket.sent.map((raw) => JSON.parse(raw).type)).not.toContain('terminal.kill')
  })

  it('invalidates an in-flight reattach without sending a kill or reviving its routes', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openTerminalPlugin(mgr, host, 'acme.term-reattach')
    mgr.setBackendWsUrl('ws://plugin-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    const reattach = call!({ sender: { id: view.webContents.id } }, {
      reqId: 'reattach',
      ns: 'terminal',
      method: 'reattach',
      args: { terminal_session_ids: ['late-session'] },
    }) as Promise<unknown>
    await Promise.resolve()
    const request = JSON.parse(socket.sent.at(-1)!) as { id: string; type: string }
    expect(request.type).toBe('terminal.reattach')
    mgr.destroy('acme.term-reattach')
    expect(socket.sent.map((raw) => JSON.parse(raw).type)).not.toContain('terminal.kill')

    socket.receive({
      id: request.id,
      type: 'terminal.reattach',
      ok: true,
      payload: { alive: ['late-session'], dead: [] },
      error: null,
      timestamp: '',
    })
    await expect(reattach).resolves.toMatchObject({ ok: true })
    dispatch(mgr, 'terminal.output', output('late-session', 'must drop'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(view, 'terminal.output')).toHaveLength(0)
  })
})

describe('cast channel (IPC_CAST / handleCast)', () => {
  function openPlugin(
    mgr: FrontendPluginManager,
    host: FakeBrowserWindow,
    id: string,
    requires: string[]
  ): FakeViewLike {
    const before = views.length
    mgr.open(
      asHost(host),
      { id, requires, devUrl: '', entryFile: `/plugins/${id}/index.html` },
      { x: 0, y: 0, width: 10, height: 10 }
    )
    return views.length > before ? views[views.length - 1] : views[before - 1]
  }

  function castPayload(ns: string, method: string): Record<string, unknown> {
    return { ns, method, args: { terminal_session_id: 't-1', data: 'x' }, reqId: 'r1' }
  }

  it('accepts whitelisted casts from a known sender (terminal.input / log_sent)', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.term', ['terminal'])
    mgr.noteTerminalRoutes('acme.term', 'terminal.create', { terminal_session_id: 't-1' })
    // No backend transport in tests — reaching 'no-backend' proves the cast
    // passed sender, shape, scoping AND the whitelist.
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'input'))).toBe('no-backend')
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'log_sent'))).toBe(
      'no-backend'
    )
  })

  it('rejects non-whitelisted backend types (mirror of the shim CAST_TYPES)', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.term', ['terminal'])
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'resize'))).toBe(
      'not-castable'
    )
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'kill'))).toBe(
      'not-castable'
    )
  })

  it('rejects casts for namespaces the manifest never granted', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.fsonly', ['fs'])
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'input'))).toBe('denied')
  })

  it('rejects terminal request controls from a sibling route owner', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const owner = openPlugin(mgr, host, 'acme.term-owner', ['terminal'])
    const sibling = openPlugin(mgr, host, 'acme.term-sibling', ['terminal'])
    mgr.noteTerminalRoutes('acme.term-owner', 'terminal.create', { terminal_session_id: 't-owner' })
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    await expect(
      call!({ sender: { id: sibling.webContents.id } }, {
        reqId: 'foreign',
        ns: 'terminal',
        method: 'resize',
        args: { terminal_session_id: 't-owner', cols: 80, rows: 24 },
      })
    ).resolves.toEqual({
      reqId: 'foreign',
      ok: false,
      error: { code: 'CAPABILITY_DENIED', message: 'terminal session is not owned by this view' },
    })
    expect(owner.webContents.isDestroyed()).toBe(false)
  })

  it('rejects unmapped methods, unknown senders and malformed payloads', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.term', ['terminal'])
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'nope'))).toBe('unmapped')
    expect(mgr.handleCast(999999, castPayload('terminal', 'input'))).toBe('unknown-sender')
    expect(mgr.handleCast(view.webContents.id, { nope: true })).toBe('malformed')
  })

  it('is wired to the plugin:cap:cast IPC channel', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.term', ['terminal'])
    const cast = ipcListeners.get('plugin:cap:cast')
    expect(cast).toBeDefined()
    expect(() =>
      cast!({ sender: { id: view.webContents.id } }, castPayload('terminal', 'input'))
    ).not.toThrow()
  })
})

describe('mini-IDE dedicated window (openMiniIdePluginView)', () => {
  // These tests exercise the module-level singleton + dedicated-window path, so
  // each test must close the live window (module state resets via 'closed').
  beforeEach(() => {
    frontendPluginManager.registerBuiltin({
      id: MINI_IDE_PLUGIN_ID,
      requires: [],
      devUrl: '',
      entryFile: '/plugins/mini-ide/index.html',
    })
  })

  afterEach(() => {
    for (const win of windows) {
      if (!win.isDestroyed()) win.close()
    }
    frontendPluginManager.destroy(MINI_IDE_PLUGIN_ID)
  })

  function lastWindow(): FakeWindowLike {
    return windows[windows.length - 1]
  }
  function lastView(): FakeViewLike {
    return views[views.length - 1]
  }

  it('creates a dedicated host window with the legacy editor options', () => {
    const winsBefore = windows.length
    const ok = openMiniIdePluginView('/ws', 'http://h:1')
    expect(ok).toBe(true)
    expect(windows.length).toBe(winsBefore + 1)
    const win = lastWindow()
    expect(win.options).toMatchObject({
      width: 1100,
      height: 760,
      title: 'Mini-IDE',
      titleBarStyle: 'hidden',
      backgroundColor: '#0d1117',
    })
    // The view attaches to the dedicated window and fills its content bounds.
    const view = lastView()
    expect(win.children).toContain(view)
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
  })

  it('passes the current theme in the entry query', () => {
    openMiniIdePluginView('/ws', '', {}, 'light')
    expect(lastView().webContents.loads[0]).toContain('theme=light')
  })

  it('mirrors the plugin page title onto the dedicated host window', () => {
    openMiniIdePluginView('/ws', 'http://h:1')
    const win = lastWindow()
    // The host's own webContents is blank; without mirroring the window would
    // keep its creation-time title in the macOS Window menu forever.
    expect(win.title).toBe('Mini-IDE')
    lastView().webContents.emit('page-title-updated', {}, 'main.ts — Mini-IDE')
    expect(win.title).toBe('main.ts — Mini-IDE')
  })

  it('ignores an empty page title so the window keeps its feature name', () => {
    openMiniIdePluginView('/ws', 'http://h:1')
    const win = lastWindow()
    lastView().webContents.emit('page-title-updated', {}, '')
    expect(win.title).toBe('Mini-IDE')
  })

  it('reopen restores and focuses the dedicated window without reloading', () => {
    openMiniIdePluginView('/ws', '', {}, 'light')
    const win = lastWindow()
    const view = lastView()
    view.webContents.emit('did-finish-load')
    win.minimized = true

    const winsBefore = windows.length
    openMiniIdePluginView('/ws', '', { filepath: 'a.ts' }, 'light')
    expect(windows.length).toBe(winsBefore) // same window reused
    expect(win.minimized).toBe(false)
    expect(win.focusCount).toBeGreaterThan(0)
    expect(view.webContents.loads).toHaveLength(1) // no reload
    const targets = view.webContents.sent.filter((m) => m.channel === 'plugin:openTarget')
    expect(targets).toHaveLength(1)
    expect(targets[0].args[0]).toMatchObject({ workspace_path: '/ws', filepath: 'a.ts' })
  })

  it('a theme change alone does not reload the running view', () => {
    openMiniIdePluginView('/ws', '', {}, 'light')
    const view = lastView()
    view.webContents.emit('did-finish-load')

    openMiniIdePluginView('/ws', '', {}, 'dark-github')
    expect(view.webContents.loads).toHaveLength(1) // still the first load
  })

  it('hideSelf closes the dedicated window and tears the view down', () => {
    openMiniIdePluginView('/ws')
    const win = lastWindow()
    const view = lastView()

    const hide = ipcListeners.get('plugin:hideSelf')
    expect(hide).toBeDefined()
    hide!({ sender: { id: view.webContents.id } })
    expect(win.destroyed).toBe(true)
    expect(view.webContents.isDestroyed()).toBe(true)
  })

  it('close then reopen recreates the window and view cleanly', () => {
    openMiniIdePluginView('/ws')
    const win1 = lastWindow()
    win1.close()

    const winsBefore = windows.length
    const viewsBefore = views.length
    const ok = openMiniIdePluginView('/ws')
    expect(ok).toBe(true)
    expect(windows.length).toBe(winsBefore + 1) // fresh window
    expect(views.length).toBe(viewsBefore + 1) // fresh view
    expect(lastWindow()).not.toBe(win1)
    expect(lastView().webContents.loads).toHaveLength(1)
  })
})

describe('ui.open_in_editor host capability — workspace containment / caller root', () => {
  const CALL = 'plugin:cap:call'

  /** Open a `ui`-granted view bound to /ws and return the call seam. */
  function openUiPlugin(): {
    mgr: FrontendPluginManager
    view: FakeViewLike
    opens: Array<Record<string, string>>
    call: (args: Record<string, unknown>) => Promise<{
      ok?: boolean
      result?: unknown
      error?: { code: string; message: string }
    }>
  } {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    mgr.open(
      asHost(host),
      {
        id: 'acme.viewer',
        requires: ['ui'],
        devUrl: '',
        entryFile: '/plugins/acme.viewer/index.html',
        query: '?workspace_path=/ws',
      },
      'fill'
    )
    const view = views[views.length - 1]
    const opens: Array<Record<string, string>> = []
    mgr.setOpenInEditorHandler((params) => {
      opens.push(params)
      return true
    })
    const handler = ipcHandlers.get(CALL)
    expect(handler).toBeDefined()
    return {
      mgr,
      view,
      opens,
      call: async (args) =>
        (await handler!({ sender: { id: view.webContents.id } }, {
          reqId: 'r1',
          ns: 'ui',
          method: 'open_in_editor',
          args,
        })) as { ok?: boolean; error?: { code: string; message: string } },
    }
  }

  it('uses the host-assigned workspace when the call names no root', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: 'src/app.ts' })
    expect(resp.error).toBeUndefined()
    expect(opens).toEqual([{ workspace_path: '/ws', filepath: 'src/app.ts' }])
  })

  it('rejects a traversal that escapes the workspace', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: '../../Users/neillu/.ssh/id_rsa' })
    expect(resp.error?.code).toBe('BAD_REQUEST')
    expect(opens).toEqual([])
  })

  it('rejects an absolute path outside the workspace', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: '/etc/passwd' })
    expect(resp.error?.code).toBe('BAD_REQUEST')
    expect(opens).toEqual([])
  })

  it('honours a call-supplied root', async () => {
    const { opens, call } = openUiPlugin()
    // Opening a file that lives outside the view's workspace: the caller names
    // the file's own root, and the target is normalized against it.
    const resp = await call({ workspace_path: '/elsewhere', filepath: 'notes/todo.md' })
    expect(resp.error).toBeUndefined()
    expect(opens).toEqual([{ workspace_path: '/elsewhere', filepath: 'notes/todo.md' }])
  })

  it('rejects a traversal that escapes a call-supplied root', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ workspace_path: '/elsewhere', filepath: '../secrets/key' })
    expect(resp.error?.code).toBe('BAD_REQUEST')
    expect(opens).toEqual([])
  })

  it('normalizes an absolute filepath against a call-supplied root', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ workspace_path: '/elsewhere', filepath: '/elsewhere/notes/todo.md' })
    expect(resp.error).toBeUndefined()
    expect(opens).toEqual([{ workspace_path: '/elsewhere', filepath: 'notes/todo.md' }])
  })

  it('normalizes an in-workspace path before handing it downstream', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: 'src/../README.md' })
    expect(resp.error).toBeUndefined()
    expect(opens).toEqual([{ workspace_path: '/ws', filepath: 'README.md' }])
  })

  it('rejects a bare workspace reference (no file to open)', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: '.' })
    expect(resp.error?.code).toBe('BAD_REQUEST')
    expect(opens).toEqual([])
  })
})

describe('Manifest v2 capability runtime deferral', () => {
  const CALL = 'plugin:cap:call'

  function openV2External(): {
    view: FakeViewLike
    opened: string[]
    call: (url: string) => Promise<{ ok?: boolean; error?: { code: string; message?: string } }>
  } {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    mgr.open(
      asHost(host),
      {
        id: 'acme.links',
        requires: ['ui'],
        capabilityPolicy: manifestV2CapabilityPolicy({ system: ['ui'] }),
        devUrl: '',
        entryFile: '/plugins/acme.links/index.html',
      },
      'fill'
    )
    const view = views[views.length - 1]
    const opened: string[] = []
    mgr.setHostShellHandlers({
      openExternal: async (url) => {
        opened.push(url)
        return { ok: true }
      },
      revealPath: () => ({ ok: true }),
      openWorkspace: () => ({ ok: true }),
      pickFolder: async () => null,
    })
    const handler = ipcHandlers.get(CALL)
    expect(handler).toBeDefined()
    return {
      view,
      opened,
      call: async (url) =>
        (await handler!({ sender: { id: view.webContents.id } }, {
          reqId: 'r1',
          ns: 'ui',
          method: 'open_external',
          args: { url },
        })) as { ok?: boolean; error?: { code: string; message?: string } },
    }
  }

  it('denies deferred v2 host capabilities before reaching the host', async () => {
    const { opened, call } = openV2External()
    expect((await call('https://example.com')).error?.code).toBe('CAPABILITY_DENIED')
    expect(opened).toEqual([])
  })

  it('passes an authenticated public plan to the Host-owned executor', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    mgr.open(
      asHost(host),
      {
        id: 'acme.shell',
        requires: ['shell'],
        capabilityPolicy: manifestV2CapabilityPolicy({ shell: 'allowlist' }),
        capabilityContext: {
          publisherEligible: false,
          userGrant: { packageVersion: '1.0.0', system: [], shell: 'allowlist' },
          runtimeBinding: {
            pluginId: 'acme.shell',
            packageVersion: '1.0.0',
            workspaceId: 'workspace-1',
            instanceId: 'instance-1',
            audience: 'audience-1',
          },
        },
        devUrl: '',
        entryFile: '/plugins/acme.shell/index.html',
      },
      'fill'
    )
    const view = views[views.length - 1]
    const plans: unknown[] = []
    mgr.setPublicCapabilityHandler((plan) => {
      plans.push(plan)
      return { accepted: true }
    })
    const handler = ipcHandlers.get(CALL)
    expect(handler).toBeDefined()
    const response = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'r1',
      ns: 'shell',
      method: 'run',
      args: { command: 'git status' },
    })
    expect(response).toMatchObject({ ok: true, result: { accepted: true } })
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ kind: 'public', address: 'shell.run' })

    mgr.setPublicCapabilityHandler(() => {
      throw new Error('sensitive host detail')
    })
    const failed = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'r2',
      ns: 'shell',
      method: 'run',
      args: { command: 'git status' },
    })
    expect(failed).toEqual({
      reqId: 'r2',
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'public capability failed' },
    })
  })

  it('routes an authorized storage call to the durable storage seam', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const storageSnapshots = new Map<StorageSnapshotTier, string>([
      ['candidate', '2.0.0'],
      ['active', '1.0.0'],
      ['previous', '0.9.0'],
    ])
    mgr.open(
      asHost(host),
      {
        id: 'acme.storage',
        packageVersion: '1.0.0',
        requires: [],
        capabilityPolicy: manifestV2CapabilityPolicy({ system: [] }),
        capabilityContext: {
          publisherEligible: false,
          userGrant: { packageVersion: '1.0.0', system: [], storage: true },
          runtimeBinding: {
            pluginId: 'acme.storage',
            packageVersion: '1.0.0',
            workspaceId: 'workspace-1',
            instanceId: 'instance-1',
            audience: 'audience-1',
          },
          storageSnapshots,
          storageSnapshotTier: 'active',
        },
        devUrl: '',
        entryFile: '/plugins/acme.storage/index.html',
        views: [
          {
            id: 'main',
            contributionKey: 'acme.storage.main',
            kind: 'custom',
            location: 'main',
            title: 'Storage',
            entryFile: '/plugins/acme.storage/index.html',
          },
        ],
      },
      'fill'
    )
    const view = views[views.length - 1]
    const executions: unknown[] = []
    mgr.setPublicStorageHandler((execution) => {
      executions.push(execution)
      return null
    })
    const handler = ipcHandlers.get(CALL)
    expect(handler).toBeDefined()

    const response = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'storage-1',
      ns: 'storage',
      method: 'set',
      args: { scope: 'workspace', key: 'layout', value: { compact: true } },
    })
    expect(response).toEqual({ reqId: 'storage-1', ok: true, result: null })
    expect(executions[0]).toMatchObject({
      address: 'storage.set',
      partition: { pluginId: 'acme.storage', workspaceId: 'workspace-1', key: 'layout' },
      snapshot: { tier: 'active', packageVersion: '1.0.0' },
    })

    mgr.setPublicStorageHandler(() => {
      throw new PluginStorageError('STORAGE_QUOTA_EXCEEDED', 'storage quota exceeded')
    })
    const failed = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'storage-2',
      ns: 'storage',
      method: 'set',
      args: { scope: 'workspace', key: 'layout', value: { compact: true } },
    })
    expect(failed).toEqual({
      reqId: 'storage-2',
      ok: false,
      error: { code: 'STORAGE_QUOTA_EXCEEDED', message: 'storage quota exceeded' },
    })

    let nested: unknown = null
    for (let index = 0; index < 129; index += 1) nested = [nested]
    const invalidDepth = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'storage-depth',
      ns: 'storage',
      method: 'set',
      args: { scope: 'plugin', key: 'depth', value: nested },
    })
    expect(invalidDepth).toEqual({
      reqId: 'storage-depth',
      ok: false,
      error: { code: 'INVALID_ARGUMENT', message: "invalid request for 'storage.set'" },
    })
  })

  it('keeps the selected storage tier fixed for a live v2 instance', async () => {
    const mgr = new FrontendPluginManager()
    const activeContext: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion: '1.0.0', system: [], storage: true },
      runtimeBinding: {
        pluginId: 'acme.storage-tier',
        packageVersion: '1.0.0',
        workspaceId: 'workspace-1',
        instanceId: null,
        audience: 'audience-1',
      },
      storageSnapshots: new Map([
        ['candidate', '1.0.0'],
        ['active', '1.0.0'],
      ]),
      storageSnapshotTier: 'active',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: 'acme.storage-tier',
      packageVersion: '1.0.0',
      requires: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: [] }),
      capabilityContext: activeContext,
      devUrl: '',
      entryFile: '/plugins/acme.storage-tier/index.html',
      views: [
        {
          id: 'main',
          contributionKey: 'acme.storage-tier.main',
          kind: 'custom',
          location: 'main',
          title: 'Storage tier',
          entryFile: '/plugins/acme.storage-tier/index.html',
        },
      ],
    }
    mgr.registerDescriptor(descriptor)
    await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(new FakeBrowserWindow()),
      bounds: 'fill',
    })
    expect(() =>
      mgr.setCapabilityContext('acme.storage-tier', {
        ...activeContext,
        storageSnapshotTier: 'candidate',
      })
    ).toThrow(/tier is fixed/)
  })

  it('routes workspace events only with a matching Host source binding', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const binding = {
      pluginId: 'acme.files',
      packageVersion: '1.0.0',
      workspaceId: 'workspace-1',
      instanceId: null,
      audience: null,
    } as const
    mgr.open(
      asHost(host),
      {
        id: 'acme.files',
        requires: ['fs'],
        capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
        capabilityContext: {
          publisherEligible: false,
          userGrant: { packageVersion: '1.0.0', system: ['fs'] },
          runtimeBinding: binding,
        },
        devUrl: '',
        entryFile: '/plugins/acme.files/index.html',
      },
      'fill'
    )
    const view = views[views.length - 1]
    const eventPayload = { changes: [{ path: 'README.md', kind: 'changed' }] }
    mgr.dispatchPublicCapabilityEvent('acme.files', 'workspace.filesChanged', eventPayload, {
      ...binding,
      pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
    })
    expect(view.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{ type: 'workspace.filesChanged', data: eventPayload }],
    })

    const before = view.webContents.sent.length
    mgr.dispatchPublicCapabilityEvent('acme.files', 'workspace.filesChanged', eventPayload, {
      ...binding,
      pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
      workspaceId: 'workspace-2',
    })
    expect(view.webContents.sent).toHaveLength(before)
  })
})

describe('first-party Git private bridge', () => {
  const HOST_CALL = 'plugin:host:call'
  const CAPABILITY_CALL = 'plugin:cap:call'

  function gitDescriptor(
    mgr: FrontendPluginManager,
    workspacePath = '/workspace',
    audience = 'git-left',
    packageVersion = '1.0.0',
  ): PluginLaunchDescriptor {
    return {
      id: 'navide.git',
      packageVersion,
      requires: ['terminal'],
      capabilityPolicy: manifestV2CapabilityPolicy({
        system: ['fs', 'ui', 'aiCli'],
        shell: 'allowlist',
      }),
      capabilityContext: mgr.gitCapabilityContext(packageVersion, workspacePath, audience),
      devUrl: '',
      entryFile: '/plugins/navide.git/index.html',
      views: [
        {
          id: 'left',
          contributionKey: 'navide.git.left',
          kind: 'custom',
          location: 'left',
          title: 'Git',
          entryFile: '/plugins/navide.git/left.html',
        },
      ],
    }
  }

  async function openGitView(workspacePath = '/workspace', audience = 'git-left'): Promise<{
    mgr: FrontendPluginManager
    view: FakeViewLike
    host: FakeBrowserWindow
    sent: Array<{ channel: string; args: unknown[] }>
    instanceId: string
  }> {
    const mgr = new FrontendPluginManager()
    const descriptor = gitDescriptor(mgr, workspacePath, audience)
    mgr.registerDescriptor(descriptor, { builtin: true })
    const host = new FakeBrowserWindow()
    const sent: Array<{ channel: string; args: unknown[] }> = []
    ;(host as unknown as { webContents: { send: (channel: string, ...args: unknown[]) => void } }).webContents = {
      send: (channel, ...args) => sent.push({ channel, args }),
    }
    const handle = await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath,
      capabilityContext: descriptor.capabilityContext,
    })
    return { mgr, view: host.children[0] as FakeViewLike, host, sent, instanceId: handle.instanceId }
  }

  function plansDescriptor(
    mgr: FrontendPluginManager,
    workspacePath = '/workspace',
    audience = 'plans-window',
  ): PluginLaunchDescriptor {
    const packageVersion = '0.1.0'
    const view = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom' as const,
      location: 'window' as const,
      title: 'Plans',
      entryFile: '/path/to/plans/window.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: '/path/to/plans',
      requires: ['fs', 'ui', 'plans', 'terminal'],
      capabilityPolicy: {
        kind: 'manifest-v2',
        system: ['fs', 'ui', 'aiCli'],
        shell: 'allowlist',
        grants: [],
      },
      devUrl: '',
      entryFile: '/path/to/plans/window.html',
      views: [view],
    }
    mgr.setCapabilityGrantResolver((pluginId, version) => {
      if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
        return {
          packageVersion,
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          storage: true,
        }
      }
      return null
    })
    descriptor.capabilityContext = mgr.plansCapabilityContext(packageVersion, workspacePath, audience)
    return descriptor
  }

  async function openPlansView(workspacePath = '/workspace', audience = 'plans-window'): Promise<{
    mgr: FrontendPluginManager
    view: FakeViewLike
    host: FakeBrowserWindow
    sent: Array<{ channel: string; args: unknown[] }>
    instanceId: string
  }> {
    const mgr = new FrontendPluginManager()
    const descriptor = plansDescriptor(mgr, workspacePath, audience)
    mgr.registerDescriptor(descriptor, { builtin: true })
    const capabilityContext = mgr.plansCapabilityContext(descriptor.packageVersion!, workspacePath, audience)
    const host = new FakeBrowserWindow()
    const sent: Array<{ channel: string; args: unknown[] }> = []
    ;(host as unknown as { webContents: { send: (channel: string, ...args: unknown[]) => void } }).webContents = {
      send: (channel, ...args) => sent.push({ channel, args }),
    }
    const handle = await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath,
      capabilityContext,
    })
    return { mgr, view: host.children[0] as FakeViewLike, host, sent, instanceId: handle.instanceId }
  }

  async function call(
    view: FakeViewLike,
    action: string,
    args: Record<string, unknown>,
    reqId = 'git-1'
  ): Promise<Record<string, unknown>> {
    const handler = ipcHandlers.get(HOST_CALL)
    expect(handler).toBeDefined()
    return (await handler!({ sender: { id: view.webContents.id } }, {
      reqId,
      action,
      args,
    })) as Record<string, unknown>
  }

  it('keeps manual calls usable while denying the equivalent agent operation', async () => {
    const { mgr, view, instanceId } = await openGitView()
    const plans: unknown[] = []
    mgr.setExecutionPolicyResolver((): ExecutionPolicySnapshot => ({
      policy: { schemaVersion: 1, mode: 'denylist', system: ['fs'], shell: [] },
      revision: 7,
      state: 'user',
    }))
    mgr.setPublicCapabilityHandler((plan) => {
      plans.push(plan)
      return null
    })
    const capabilityHandler = ipcHandlers.get('plugin:cap:call')
    expect(capabilityHandler).toBeDefined()

    await expect(mgr.executeAgentCapability(instanceId, {
      reqId: 'agent-fs',
      ns: 'fs',
      method: 'listFilesFlat',
      args: { query: '', maxResults: 1 },
    })).resolves.toMatchObject({
      reqId: 'agent-fs',
      ok: false,
      error: { code: 'CAPABILITY_DENIED', message: 'agent execution policy denied the operation' },
    })
    expect(plans).toEqual([])

    await expect(capabilityHandler!({ sender: { id: view.webContents.id } }, {
      reqId: 'manual-fs',
      ns: 'fs',
      method: 'listFilesFlat',
      args: { query: '', maxResults: 1 },
    })).resolves.toMatchObject({ reqId: 'manual-fs', ok: true })
    expect(plans[0]).toMatchObject({
      initiator: { kind: 'user' },
    })

    await expect(mgr.executeAgentCapability(instanceId, {
      reqId: 'forged-agent',
      ns: 'fs',
      method: 'listFilesFlat',
      args: { query: '', maxResults: 1 },
      initiator: { kind: 'user', id: 'forged' },
    })).resolves.toMatchObject({
      reqId: 'forged-agent',
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })
  })

  it('rechecks a stale agent policy before invoking the public handler', async () => {
    const { mgr, instanceId } = await openGitView()
    let reads = 0
    const allow = (): ExecutionPolicySnapshot => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] },
      revision: 1,
      state: 'user',
    })
    const deny = (): ExecutionPolicySnapshot => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: [] },
      revision: 2,
      state: 'user',
    })
    mgr.setExecutionPolicyResolver(() => {
      reads += 1
      return reads === 1 ? allow() : deny()
    })
    const handler = vi.fn()
    mgr.setPublicCapabilityHandler(handler)

    await expect(mgr.executeAgentCapability(instanceId, {
      reqId: 'stale-agent-policy',
      ns: 'fs',
      method: 'listFilesFlat',
      args: { query: '', maxResults: 1 },
    })).resolves.toMatchObject({
      reqId: 'stale-agent-policy',
      ok: false,
      error: { code: 'CAPABILITY_DENIED', message: 'agent execution policy denied the operation' },
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('uses the global policy for an agent plugin-scoped UI call without a workspace', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.plugin-ui'
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'main',
      contributionKey: `${pluginId}.main`,
      kind: 'custom',
      location: 'main',
      title: 'Plugin UI',
      entryFile: '/plugins/acme.plugin-ui/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion, system: ['ui'] },
      runtimeBinding: {
        pluginId,
        packageVersion,
        workspaceId: null,
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    const descriptor: PluginLaunchDescriptor = {
      id: pluginId,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['ui'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['ui'] }),
      capabilityContext: context,
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(descriptor)
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['ui'], shell: [] },
      revision: 1,
      state: 'user',
    }))
    const handler = vi.fn()
    mgr.setPublicCapabilityHandler(handler)
    const host = new FakeBrowserWindow()

    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        capabilityContext: context,
      })

      await expect(mgr.executeAgentCapability(handle.instanceId, {
        reqId: 'agent-plugin-ui-1',
        ns: 'ui',
        method: 'openExternal',
        args: { url: 'https://example.com' },
      })).resolves.toMatchObject({ reqId: 'agent-plugin-ui-1', ok: true })
      expect(handler).toHaveBeenCalledOnce()
    } finally {
      await mgr.closeBackendPlugins()
    }
  })

  it('denies Git storage writes outside the approved preference ownership', async () => {
    const { mgr, view } = await openGitView()
    const executions: unknown[] = []
    mgr.setPublicStorageHandler((execution) => {
      executions.push(execution)
      return null
    })
    const handler = ipcHandlers.get(CAPABILITY_CALL)
    expect(handler).toBeDefined()

    const response = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'git-storage-host-key',
      ns: 'storage',
      method: 'set',
      args: { scope: 'plugin', key: 'agentTeam.yolo', value: '0' },
    })

    expect(response).toMatchObject({
      reqId: 'git-storage-host-key',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    expect(executions).toEqual([])
  })

  it('routes only Host-owned read-only settings to Git v2 views', async () => {
    const { mgr, view } = await openGitView()

    mgr.dispatchHostSettingsChanged({
      settings: {
        'agentTeam.yolo': '0',
        'agentTeam.analyzerModel': 'qwen2:latest',
        'agentTeam.git.autoCommit': '1',
        'unknown.setting': 'ignored',
      },
    })

    expect(view.webContents.sent).toEqual([{
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agentTeam.yolo': '0',
            'agentTeam.analyzerModel': 'qwen2:latest',
          },
        },
      }],
    }])
  })

  it('does not route Host-owned language settings changes to v2 Git views', async () => {
    const { mgr, view } = await openGitView()

    mgr.dispatchHostSettingsChanged({
      settings: {
        'agent-team:language': 'zh-TW',
        'unknown.setting': 'ignored',
      },
    })

    expect(view.webContents.sent).toHaveLength(0)
  })

  it('routes Host-owned language settings changes to active Plans v2 views', async () => {
    const { mgr, view } = await openPlansView()

    mgr.dispatchHostSettingsChanged({
      settings: {
        'agent-team:language': 'zh-TW',
        'unknown.setting': 'ignored',
      },
    })

    expect(view.webContents.sent).toEqual([{
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agent-team:language': 'zh-TW',
          },
        },
      }],
    }])
  })

  it('preserves Git package-private settings contract: Plans receives only Host language and never Git settings or storage', async () => {
    const mgr = new FrontendPluginManager()
    const workspacePath = '/workspace'
    const gitDesc = gitDescriptor(mgr, workspacePath, 'git-left')
    mgr.registerDescriptor(gitDesc, { builtin: true })
    const gitHost = new FakeBrowserWindow()
    const gitSent: Array<{ channel: string; args: unknown[] }> = []
    ;(gitHost as unknown as { webContents: { send: (channel: string, ...args: unknown[]) => void } }).webContents = {
      send: (channel, ...args) => gitSent.push({ channel, args }),
    }
    await mgr.openView(gitDesc, gitDesc.views![0], {
      hostWindow: asHost(gitHost),
      bounds: 'fill',
      workspacePath,
      capabilityContext: gitDesc.capabilityContext,
    })
    const gitView = gitHost.children[0] as FakeViewLike

    const plansDesc = plansDescriptor(mgr, workspacePath, 'plans-window')
    mgr.registerDescriptor(plansDesc, { builtin: true })
    const plansCapabilityContext = mgr.plansCapabilityContext(plansDesc.packageVersion!, workspacePath, 'plans-window')
    const plansHost = new FakeBrowserWindow()
    const plansSent: Array<{ channel: string; args: unknown[] }> = []
    ;(plansHost as unknown as { webContents: { send: (channel: string, ...args: unknown[]) => void } }).webContents = {
      send: (channel, ...args) => plansSent.push({ channel, args }),
    }
    await mgr.openView(plansDesc, plansDesc.views![0], {
      hostWindow: asHost(plansHost),
      bounds: 'fill',
      workspacePath,
      capabilityContext: plansCapabilityContext,
    })
    const plansView = plansHost.children[0] as FakeViewLike

    gitView.webContents.sent.length = 0
    plansView.webContents.sent.length = 0

    // 1. Git-only Host settings: Git receives them, Plans receives nothing
    mgr.dispatchHostSettingsChanged({
      settings: {
        'agentTeam.yolo': '0',
        'agentTeam.analyzerModel': 'qwen2:latest',
        'agent-team:theme': 'dark',
      },
    })
    expect(gitView.webContents.sent).toHaveLength(1)
    expect(gitView.webContents.sent[0]).toEqual({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agentTeam.yolo': '0',
            'agentTeam.analyzerModel': 'qwen2:latest',
            'agent-team:theme': 'dark',
          },
        },
      }],
    })
    expect(plansView.webContents.sent).toHaveLength(0)

    gitView.webContents.sent.length = 0
    plansView.webContents.sent.length = 0

    // 2. Mixed Host settings: Git receives git settings, Plans receives ONLY language
    mgr.dispatchHostSettingsChanged({
      settings: {
        'agentTeam.yolo': '1',
        'agent-team:language': 'zh-TW',
      },
    })
    expect(gitView.webContents.sent).toEqual([{
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agentTeam.yolo': '1',
          },
        },
      }],
    }])
    expect(plansView.webContents.sent).toEqual([{
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agent-team:language': 'zh-TW',
          },
        },
      }],
    }])

    gitView.webContents.sent.length = 0
    plansView.webContents.sent.length = 0

    // 3. Plugin-storage settings: Git receives git user preference, Plans receives nothing
    mgr.setPublicStorageHandler(() => null)
    const handler = ipcHandlers.get(CAPABILITY_CALL)
    await handler!(
      { sender: { id: gitView.webContents.id } },
      {
        reqId: 'git-storage-1',
        ns: 'storage',
        method: 'set',
        args: { scope: 'plugin', key: 'agentTeam.git.logScope', value: 'all' },
      },
    )
    expect(gitView.webContents.sent).toHaveLength(1)
    expect(gitView.webContents.sent[0].args[0]).toMatchObject({
      type: 'ui.settings_changed',
      data: { source: 'plugin-storage' },
    })
    expect(plansView.webContents.sent).toHaveLength(0)
  })

  it('preserves legacy Git host settings filtering without language entering legacy Git fan-out', async () => {
    const mgr = new FrontendPluginManager()
    const workspacePath = '/workspace'

    // 1. Register and open legacy (recovery) Git view
    const legacyGit: PluginLaunchDescriptor = {
      id: GIT_PLUGIN_ID,
      requires: ['ui', 'git'],
      devUrl: '',
      entryFile: '/plugins/git/index.html',
    }
    mgr.registerDescriptor(legacyGit, { builtin: true })
    const gitHost = new FakeBrowserWindow()
    const gitSent: Array<{ channel: string; args: unknown[] }> = []
    ;(gitHost as unknown as { webContents: { send: (channel: string, ...args: unknown[]) => void } }).webContents = {
      send: (channel, ...args) => gitSent.push({ channel, args }),
    }
    await mgr.open(asHost(gitHost), legacyGit, 'fill')
    const legacyGitView = gitHost.children[0] as FakeViewLike

    // 2. Register and open Plans v2 view
    const plans = plansDescriptor(mgr, workspacePath, 'plans-window')
    mgr.registerDescriptor(plans, { builtin: true })
    const plansCapabilityContext = mgr.plansCapabilityContext(plans.packageVersion!, workspacePath, 'plans-window')
    const plansHost = new FakeBrowserWindow()
    await mgr.openView(plans, plans.views![0], {
      hostWindow: asHost(plansHost),
      bounds: 'fill',
      workspacePath,
      capabilityContext: plansCapabilityContext,
    })
    const plansView = plansHost.children[0] as FakeViewLike

    legacyGitView.webContents.sent.length = 0
    plansView.webContents.sent.length = 0

    // 3. Dispatch mixed host settings with both git settings and language
    mgr.dispatchHostSettingsChanged({
      settings: {
        'agentTeam.yolo': '1',
        'agent-team:language': 'zh-TW',
      },
    })

    // Plans v2 receives only language
    expect(plansView.webContents.sent).toEqual([{
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agent-team:language': 'zh-TW',
          },
        },
      }],
    }])

    // Explicit recovery Git receives only git read-only settings; language MUST NOT enter legacy Git fan-out
    expect(legacyGitView.webContents.sent).toEqual([{
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agentTeam.yolo': '1',
          },
        },
      }],
    }])

    legacyGitView.webContents.sent.length = 0
    plansView.webContents.sent.length = 0

    // 4. Dispatch language-only settings change
    mgr.dispatchHostSettingsChanged({
      settings: {
        'agent-team:language': 'en-US',
      },
    })

    // Plans v2 receives language
    expect(plansView.webContents.sent).toEqual([{
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agent-team:language': 'en-US',
          },
        },
      }],
    }])

    // Legacy Git fan-out receives NOTHING (language is completely blocked from legacy Git)
    expect(legacyGitView.webContents.sent).toHaveLength(0)
  })

  it('routes Host-owned language settings changes to legacy Plans plugin bundle while keeping legacy Git isolated', async () => {
    const mgr = new FrontendPluginManager()

    // 1. Register and open legacy Plans view
    const legacyPlans: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      requires: ['fs', 'ui', 'plans', 'terminal'],
      devUrl: '',
      entryFile: '/plugins/plans/index.html',
    }
    mgr.registerDescriptor(legacyPlans, { builtin: true })
    const plansHost = new FakeBrowserWindow()
    await mgr.open(asHost(plansHost), legacyPlans, 'fill')
    const legacyPlansView = plansHost.children[0] as FakeViewLike

    // 2. Register and open legacy Git view
    const legacyGit: PluginLaunchDescriptor = {
      id: GIT_PLUGIN_ID,
      requires: ['ui', 'git'],
      devUrl: '',
      entryFile: '/plugins/git/index.html',
    }
    mgr.registerDescriptor(legacyGit, { builtin: true })
    const gitHost = new FakeBrowserWindow()
    await mgr.open(asHost(gitHost), legacyGit, 'fill')
    const legacyGitView = gitHost.children[0] as FakeViewLike

    legacyPlansView.webContents.sent.length = 0
    legacyGitView.webContents.sent.length = 0

    // 3. Dispatch language setting change
    mgr.dispatchHostSettingsChanged({
      settings: {
        'agent-team:language': 'en-US',
      },
    })

    // Legacy Plans receives language update
    expect(legacyPlansView.webContents.sent).toEqual([{
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agent-team:language': 'en-US',
          },
        },
      }],
    }])

    // Legacy Git receives nothing (language never enters Git)
    expect(legacyGitView.webContents.sent).toHaveLength(0)
  })

  it('dispatches authenticated navide.plans.left ui.openPlansWindow call to registered handler', async () => {
    const mgr = new FrontendPluginManager()
    const workspacePath = '/workspace'
    const packageVersion = '0.1.0'
    const viewLeft = {
      id: 'left',
      contributionKey: 'navide.plans.left',
      kind: 'custom' as const,
      location: 'left' as const,
      title: 'Plans',
      entryFile: '/path/to/plans/left.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: '/path/to/plans',
      requires: ['fs', 'ui', 'plans', 'terminal'],
      capabilityPolicy: {
        kind: 'manifest-v2',
        system: ['fs', 'ui', 'aiCli'],
        shell: 'allowlist',
        grants: [],
      },
      devUrl: '',
      entryFile: viewLeft.entryFile,
      views: [viewLeft],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.setCapabilityGrantResolver((pluginId, version) => {
      if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
        return {
          packageVersion,
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          storage: true,
        }
      }
      return null
    })
    const capabilityContext = mgr.plansCapabilityContext(packageVersion, workspacePath, 'plans-left')
    const host = new FakeBrowserWindow()
    await mgr.openView(descriptor, viewLeft, {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath,
      capabilityContext,
    })
    const leftView = host.children[0] as FakeViewLike

    const opens: Array<{ workspacePath: string; relPath?: string }> = []
    mgr.setOpenPlansWindowHandler(async (ws, rel) => {
      opens.push({ workspacePath: ws, relPath: rel })
      return true
    })
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))

    const handler = ipcHandlers.get(CAPABILITY_CALL)
    expect(handler).toBeDefined()

    const response = await handler!(
      { sender: { id: leftView.webContents.id } },
      {
        reqId: 'open-plan-left',
        ns: 'ui',
        method: 'openPlansWindow',
        args: { path: '.agent-team/plans/feature.html' },
      },
    )

    expect(response).toEqual({
      reqId: 'open-plan-left',
      ok: true,
      result: { opened: true },
    })
    expect(opens).toEqual([{
      workspacePath,
      relPath: '.agent-team/plans/feature.html',
    }])
  })

  it('routes ui.openPlansWindow for nested repos strictly with .git directory and blocks .git file/symlink escape', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'navide-open-plans-test-'))
    const extDir = mkdtempSync(join(tmpdir(), 'navide-open-ext-test-'))

    try {
      const mgr = new FrontendPluginManager()
      const packageVersion = '0.1.0'
      const viewLeft = {
        id: 'left',
        contributionKey: 'navide.plans.left',
        kind: 'custom' as const,
        location: 'left' as const,
        title: 'Plans',
        entryFile: '/path/to/plans/left.html',
      }
      const descriptor: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: '/path/to/plans',
        requires: ['fs', 'ui', 'plans', 'terminal'],
        capabilityPolicy: {
          kind: 'manifest-v2',
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          grants: [],
        },
        devUrl: '',
        entryFile: viewLeft.entryFile,
        views: [viewLeft],
      }
      mgr.registerDescriptor(descriptor, { builtin: true })
      mgr.setCapabilityGrantResolver((pluginId, version) => {
        if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
          return {
            packageVersion,
            system: ['fs', 'ui', 'aiCli'],
            shell: 'allowlist',
            storage: true,
          }
        }
        return null
      })
      const capabilityContext = mgr.plansCapabilityContext(packageVersion, tempDir, 'plans-left')
      const host = new FakeBrowserWindow()
      await mgr.openView(descriptor, viewLeft, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: tempDir,
        capabilityContext,
      })
      const leftView = host.children[0] as FakeViewLike

      const opens: Array<{ workspacePath: string; relPath?: string }> = []
      mgr.setOpenPlansWindowHandler(async (ws, rel) => {
        opens.push({ workspacePath: ws, relPath: rel })
        return true
      })
      mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
      const handler = ipcHandlers.get(CAPABILITY_CALL)!

      // 1. Nested repo with .git directory: ALLOWED
      const nestedDir = join(tempDir, 'packages/subrepo')
      mkdirSync(join(nestedDir, '.git'), { recursive: true })
      mkdirSync(join(nestedDir, '.agent-team/plans'), { recursive: true })
      writeFileSync(join(nestedDir, '.agent-team/plans/nested.html'), '<html></html>')

      const resAllowed = await handler(
        { sender: { id: leftView.webContents.id } },
        {
          reqId: 'open-nested-allowed',
          ns: 'ui',
          method: 'openPlansWindow',
          args: { path: 'packages/subrepo/.agent-team/plans/nested.html' },
        },
      )
      expect(resAllowed).toEqual({
        reqId: 'open-nested-allowed',
        ok: true,
        result: { opened: true },
      })
      expect(opens).toContainEqual({
        workspacePath: tempDir,
        relPath: 'packages/subrepo/.agent-team/plans/nested.html',
      })

      // 2. Nested repo with .git FILE (submodule/worktree): REJECTED
      const subDir = join(tempDir, 'packages/submodule')
      mkdirSync(join(subDir, '.agent-team/plans'), { recursive: true })
      writeFileSync(join(subDir, '.git'), 'gitdir: ../../.git/modules/submodule\n')
      writeFileSync(join(subDir, '.agent-team/plans/sub.html'), '<html></html>')

      const resGitFile = await handler(
        { sender: { id: leftView.webContents.id } },
        {
          reqId: 'open-git-file-rejected',
          ns: 'ui',
          method: 'openPlansWindow',
          args: { path: 'packages/submodule/.agent-team/plans/sub.html' },
        },
      )
      expect(resGitFile).toEqual({
        reqId: 'open-git-file-rejected',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'public capability failed' },
      })

      // 3. Symlink escape: REJECTED
      const extPlanDir = join(extDir, '.agent-team/plans')
      mkdirSync(extPlanDir, { recursive: true })
      writeFileSync(join(extPlanDir, 'ext.html'), '<html></html>')
      symlinkSync(extPlanDir, join(tempDir, 'linked-plans'), 'dir')

      const resSymlink = await handler(
        { sender: { id: leftView.webContents.id } },
        {
          reqId: 'open-symlink-rejected',
          ns: 'ui',
          method: 'openPlansWindow',
          args: { path: 'linked-plans/ext.html' },
        },
      )
      expect(resSymlink).toEqual({
        reqId: 'open-symlink-rejected',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'public capability failed' },
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(extDir, { recursive: true, force: true })
    }
  })

  it('routes ui.openInEditor rejecting raw workspace absolute path and accepting relative path', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'navide-open-editor-test-'))
    try {
      const plansDir = join(tempDir, '.agent-team/plans')
      mkdirSync(plansDir, { recursive: true })
      writeFileSync(join(plansDir, 'feature.html'), '<html></html>')

      const mgr = new FrontendPluginManager()
      const packageVersion = '0.1.0'
      const viewLeft = {
        id: 'left',
        contributionKey: 'navide.plans.left',
        kind: 'custom' as const,
        location: 'left' as const,
        title: 'Plans',
        entryFile: '/path/to/plans/left.html',
      }
      const descriptor: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: '/path/to/plans',
        requires: ['fs', 'ui', 'plans', 'terminal'],
        capabilityPolicy: {
          kind: 'manifest-v2',
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          grants: [],
        },
        devUrl: '',
        entryFile: viewLeft.entryFile,
        views: [viewLeft],
      }
      mgr.registerDescriptor(descriptor, { builtin: true })
      mgr.setCapabilityGrantResolver((pluginId, version) => {
        if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
          return {
            packageVersion,
            system: ['fs', 'ui', 'aiCli'],
            shell: 'allowlist',
            storage: true,
          }
        }
        return null
      })
      const capabilityContext = mgr.plansCapabilityContext(packageVersion, tempDir, 'plans-left')
      const host = new FakeBrowserWindow()
      await mgr.openView(descriptor, viewLeft, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: tempDir,
        capabilityContext,
      })
      const leftView = host.children[0] as FakeViewLike

      const editorCalls: Array<Record<string, string>> = []
      mgr.setOpenInEditorHandler((params) => {
        editorCalls.push(params)
        return true
      })
      mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))

      const handler = ipcHandlers.get(CAPABILITY_CALL)
      expect(handler).toBeDefined()

      // 1. Raw absolute path within workspace: REJECTED, handler NOT called
      const absPath = join(tempDir, '.agent-team/plans/feature.html')
      const resAbs = await handler!(
        { sender: { id: leftView.webContents.id } },
        {
          reqId: 'open-editor-abs-rejected',
          ns: 'ui',
          method: 'openInEditor',
          args: { path: absPath },
        },
      )
      expect(resAbs).toEqual({
        reqId: 'open-editor-abs-rejected',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'public capability failed' },
      })
      expect(editorCalls).toHaveLength(0)

      // 2. Valid relative plan path: ACCEPTED, handler called with normalized relative path
      const resRel = await handler!(
        { sender: { id: leftView.webContents.id } },
        {
          reqId: 'open-editor-rel-accepted',
          ns: 'ui',
          method: 'openInEditor',
          args: { path: '.agent-team/plans/feature.html' },
        },
      )
      expect(resRel).toEqual({
        reqId: 'open-editor-rel-accepted',
        ok: true,
        result: { opened: true },
      })
      expect(editorCalls).toEqual([
        {
          workspace_path: resolve(tempDir),
          filepath: '.agent-team/plans/feature.html',
        },
      ])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('labels plugin storage changes so the settings facade accepts only its owned scope', async () => {
    const { mgr, view } = await openGitView()
    mgr.setPublicStorageHandler(() => null)
    const handler = ipcHandlers.get(CAPABILITY_CALL)
    expect(handler).toBeDefined()

    const response = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'git-storage-owned-key',
      ns: 'storage',
      method: 'set',
      args: { scope: 'plugin', key: 'agentTeam.git.logScope', value: 'all' },
    })

    expect(response).toEqual({ reqId: 'git-storage-owned-key', ok: true, result: null })
    expect(view.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'plugin-storage',
          scope: 'plugin',
          settings: { 'agentTeam.git.logScope': 'all' },
        },
      }],
    })
  })

  it('routes a validated contribution to its own Host window only', async () => {
    const first = await openGitView()
    const descriptor = gitDescriptor(first.mgr)
    const secondHost = new FakeBrowserWindow()
    const secondSent: Array<{ channel: string; args: unknown[] }> = []
    ;(secondHost as unknown as { webContents: { send: (channel: string, ...args: unknown[]) => void } }).webContents = {
      send: (channel, ...args) => secondSent.push({ channel, args }),
    }
    await first.mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(secondHost),
      bounds: 'fill',
      workspacePath: '/other',
      capabilityContext: first.mgr.gitCapabilityContext('1.0.0', '/other', 'git-window'),
    })

    const response = await call(first.view, 'git.contribution', {
      operation: 'changes_count',
      payload: { count: 4, workspace_path: '/workspace' },
    })

    expect(response).toEqual({ reqId: 'git-1', ok: true, result: { accepted: true } })
    expect(first.sent).toEqual([{
      channel: 'git:contribution-action',
      args: [{ operation: 'changes_count', payload: { count: 4, workspace_path: '/workspace' } }],
    }])
    expect(secondSent).toEqual([])

    const windowResponse = await call(secondHost.children[0] as FakeViewLike, 'git.contribution', {
      operation: 'changes_count',
      payload: { count: 1, workspace_path: '/other' },
    }, 'git-window-contribution')
    expect(windowResponse).toMatchObject({
      reqId: 'git-window-contribution',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })

    const handler = ipcHandlers.get(HOST_CALL)
    const rejected = await handler!({ sender: { id: first.view.webContents.id } }, {
      reqId: 'git-2',
      action: 'git.contribution',
      args: {
        operation: 'changes_count',
        payload: { count: 2, workspace_path: '/other' },
      },
      instanceId: 'forged',
    }) as Record<string, unknown>
    expect(rejected).toEqual({
      reqId: '',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'instance identity is Host-owned' },
    })
  })

  it('projects only the bound workspace legacy repository selection', async () => {
    const { mgr, view } = await openGitView('/workspace')
    mgr.setBackendWsUrl('ws://git-legacy-selection-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()

    const selection = call(view, 'git.legacyRepoSelection', {
      workspace_path: '/renderer-forged',
      packageVersion: 'renderer-forged',
    }, 'git-legacy-selection')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(request).toMatchObject({
      type: 'project.peek',
      payload: { workspace_path: '/workspace' },
    })
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: {
        project: {
          ui_git_tab_repo: '/workspace/nested',
          task_description: 'must not cross the private projection',
        },
      },
      error: null,
      timestamp: '',
    })

    await expect(selection).resolves.toEqual({
      reqId: 'git-legacy-selection',
      ok: true,
      result: { selection: '/workspace/nested' },
    })
  })

  it('requires nested Git actions to carry the bound workspace', async () => {
    const { view, sent } = await openGitView()

    const missingWorkspace = await call(view, 'git.contribution', {
      operation: 'open_file',
      payload: { filepath: 'src/app.ts', name: 'app.ts' },
    }, 'git-missing-workspace')
    expect(missingWorkspace).toMatchObject({
      reqId: 'git-missing-workspace',
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })

    const outsideWorkspace = await call(view, 'git.contribution', {
      operation: 'open_diff',
      payload: {
        workspace_path: '/other',
        filepath: 'src/app.ts',
        staged: false,
        name: 'app.ts',
      },
    }, 'git-outside-workspace')
    expect(outsideWorkspace).toMatchObject({
      reqId: 'git-outside-workspace',
      ok: false,
      error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
    })

    const accepted = await call(view, 'git.contribution', {
      operation: 'open_branch_diff',
      payload: { workspace_path: '/workspace/repo', base: 'main', compare: 'feature' },
    }, 'git-bound-workspace')
    expect(accepted).toEqual({ reqId: 'git-bound-workspace', ok: true, result: { accepted: true } })
    expect(sent.at(-1)).toEqual({
      channel: 'git:contribution-action',
      args: [{
        operation: 'open_branch_diff',
        payload: { workspace_path: '/workspace/repo', base: 'main', compare: 'feature' },
      }],
    })
  })

  it.each([
    ['open_file', { workspace_path: '/workspace', filepath: '../../outside.txt', name: 'outside.txt' }],
    ['open_conflict', { workspace_path: '/workspace', filepath: '../../outside.txt', name: 'outside.txt' }],
    ['open_diff', { workspace_path: '/workspace', filepath: '../../outside.txt', staged: false, name: 'outside.txt' }],
    ['open_git_window', { workspace_path: '/workspace', filepath: '../../outside.txt' }],
    ['open_file', { workspace_path: '/workspace', filepath: '/absolute/outside.txt', name: 'outside.txt' }],
    ['open_conflict', { workspace_path: '/workspace', filepath: '/absolute/outside.txt', name: 'outside.txt' }],
    ['open_diff', { workspace_path: '/workspace', filepath: '/absolute/outside.txt', staged: false, name: 'outside.txt' }],
    ['open_git_window', { workspace_path: '/workspace', filepath: '/absolute/outside.txt' }],
  ] as const)('rejects an out-of-workspace %s filepath (%s)', async (operation, payload) => {
    const { view, sent } = await openGitView()

    const response = await call(view, 'git.contribution', { operation, payload }, `git-outside-file-${operation}`)

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
    })
    expect(sent).toEqual([])
  })

  it('accepts an in-workspace relative contribution filepath', async () => {
    const { view, sent } = await openGitView()

    const response = await call(view, 'git.contribution', {
      operation: 'open_file',
      payload: { workspace_path: '/workspace', filepath: 'src/app.ts', name: 'app.ts' },
    }, 'git-in-workspace-file')

    expect(response).toEqual({ reqId: 'git-in-workspace-file', ok: true, result: { accepted: true } })
    expect(sent).toEqual([{
      channel: 'git:contribution-action',
      args: [{
        operation: 'open_file',
        payload: { workspace_path: '/workspace', filepath: 'src/app.ts', name: 'app.ts' },
      }],
    }])
  })

  it('accepts open_workspace only with the exact one-time Host picker grant', async () => {
    const { mgr, view, sent } = await openGitView()
    mgr.setHostShellHandlers({
      openExternal: async () => ({ ok: true }),
      revealPath: () => ({ ok: true }),
      openWorkspace: () => ({ ok: true }),
      pickFolder: async () => '/picked/workspace',
    })

    const picked = await call(view, 'git.contribution', {
      operation: 'pick_workspace',
      payload: {},
    }, 'pick-workspace')
    const grant = (picked.result as { grant?: unknown }).grant
    expect(picked).toMatchObject({
      reqId: 'pick-workspace',
      ok: true,
      result: { path: '/picked/workspace' },
    })
    expect(typeof grant).toBe('string')

    await expect(call(view, 'git.contribution', {
      operation: 'open_workspace',
      payload: { path: '/picked/sibling', grant },
    }, 'forged-workspace')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })

    await expect(call(view, 'git.contribution', {
      operation: 'open_workspace',
      payload: { path: '/picked/workspace', grant },
    }, 'open-picked-workspace')).resolves.toEqual({
      reqId: 'open-picked-workspace',
      ok: true,
      result: { accepted: true },
    })
    expect(sent).toEqual([{
      channel: 'git:contribution-action',
      args: [{ operation: 'open_workspace', payload: { path: '/picked/workspace' } }],
    }])

    await expect(call(view, 'git.contribution', {
      operation: 'open_workspace',
      payload: { path: '/picked/workspace', grant },
    }, 'replayed-workspace')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('opens only an authoritative worktree from the bound git-window workspace', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-worktree-root-'))
    const worktreePath = mkdtempSync(join(tmpdir(), 'navide-git-worktree-known-'))
    const unknownPath = mkdtempSync(join(tmpdir(), 'navide-git-worktree-unknown-'))
    try {
      const { mgr, view } = await openGitView(workspacePath, 'git-window')
      mgr.setBackendWsUrl('ws://git-worktree-open-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const openWorkspace = vi.fn(() => ({ ok: true }))
      mgr.setHostShellHandlers({
        openExternal: async () => ({ ok: true }),
        revealPath: () => ({ ok: true }),
        openWorkspace,
        pickFolder: async () => null,
      })

      const openKnown = call(view, 'git.contribution', {
        operation: 'open_worktree',
        payload: { path: worktreePath },
      }, 'open-known-worktree')
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
      const knownRequest = JSON.parse(socket.sent[0]!)
      expect(knownRequest).toMatchObject({
        type: 'git.worktrees',
        payload: { workspace_path: workspacePath },
      })
      socket.receive({
        id: knownRequest.id,
        type: knownRequest.type,
        ok: true,
        payload: { worktrees: [{ path: worktreePath }] },
        error: null,
        timestamp: '',
      })
      await expect(openKnown).resolves.toEqual({
        reqId: 'open-known-worktree',
        ok: true,
        result: { accepted: true },
      })
      expect(openWorkspace).toHaveBeenCalledWith(realpathSync(worktreePath))

      const openUnknown = call(view, 'git.contribution', {
        operation: 'open_worktree',
        payload: { path: unknownPath },
      }, 'open-unknown-worktree')
      await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
      const unknownRequest = JSON.parse(socket.sent[1]!)
      socket.receive({
        id: unknownRequest.id,
        type: unknownRequest.type,
        ok: true,
        payload: { worktrees: [{ path: worktreePath }] },
        error: null,
        timestamp: '',
      })
      await expect(openUnknown).resolves.toMatchObject({
        reqId: 'open-unknown-worktree',
        ok: false,
        error: { code: 'CAPABILITY_DENIED' },
      })
      expect(openWorkspace).toHaveBeenCalledTimes(1)

      const rejectedLookup = call(view, 'git.contribution', {
        operation: 'open_worktree',
        payload: { path: worktreePath },
      }, 'rejected-worktree-lookup')
      await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
      const rejectedRequest = JSON.parse(socket.sent[2]!)
      socket.receive({
        id: rejectedRequest.id,
        type: rejectedRequest.type,
        ok: false,
        payload: null,
        error: { code: 'GIT_ERROR', message: 'worktrees unavailable' },
        timestamp: '',
      })
      await expect(rejectedLookup).resolves.toMatchObject({
        reqId: 'rejected-worktree-lookup',
        ok: false,
        error: { code: 'BACKEND_ERROR', message: 'worktrees unavailable' },
      })
      expect(openWorkspace).toHaveBeenCalledTimes(1)

      const leftView = await openGitView(workspacePath, 'git-left')
      await expect(call(leftView.view, 'git.contribution', {
        operation: 'open_worktree',
        payload: { path: worktreePath },
      }, 'left-open-worktree')).resolves.toMatchObject({
        reqId: 'left-open-worktree',
        ok: false,
        error: { code: 'CAPABILITY_DENIED' },
      })
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(worktreePath, { recursive: true, force: true })
      rmSync(unknownPath, { recursive: true, force: true })
    }
  })

  it('denies the generic UI route so an arbitrary path cannot become a workspace root', async () => {
    const { view } = await openGitView()

    await expect(call(view, 'ui.request', {
      type: 'ui.open_workspace',
      payload: { workspace_path: '/' },
    }, 'generic-open-workspace')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('routes git.changed once to its matching v2 workspace without blocking a legal legacy subscriber', async () => {
    const first = await openGitView('/workspace')
    const secondHost = new FakeBrowserWindow()
    const secondDescriptor = gitDescriptor(first.mgr, '/other-workspace')
    await first.mgr.openView(secondDescriptor, secondDescriptor.views![0], {
      hostWindow: asHost(secondHost),
      bounds: 'fill',
      workspacePath: '/other-workspace',
      capabilityContext: secondDescriptor.capabilityContext,
    })
    const legacyHost = new FakeBrowserWindow()
    first.mgr.open(asHost(legacyHost), {
      id: 'acme.fs-subscriber',
      requires: ['fs'],
      devUrl: '',
      entryFile: '/plugins/acme.fs-subscriber/index.html',
    }, { x: 0, y: 0, width: 10, height: 10 })

    const dispatch = first.mgr as unknown as {
      dispatchEvent(event: string, payload: unknown, binding?: unknown, targetPluginId?: string): void
    }
    dispatch.dispatchEvent('git.changed', { workspace_path: '/workspace' })
    const events = (view: FakeViewLike) => view.webContents.sent
      .filter((message) => message.channel === 'plugin:cap:event')
      .map((message) => message.args[0] as { type: string })
      .filter((message) => message.type === 'git.changed')
    expect(events(first.view)).toHaveLength(1)
    expect(events(secondHost.children[0] as FakeViewLike)).toHaveLength(0)
    expect(events(legacyHost.children[0] as FakeViewLike)).toHaveLength(1)

    dispatch.dispatchEvent('git.changed', { workspace_path: '/workspace' }, undefined, 'acme.fs-subscriber')
    expect(events(first.view)).toHaveLength(1)
    expect(events(legacyHost.children[0] as FakeViewLike)).toHaveLength(2)
  })

  it('rejects picker grants from another instance, after expiry, and for clone sibling traversal', async () => {
    const first = await openGitView()
    first.mgr.setHostShellHandlers({
      openExternal: async () => ({ ok: true }),
      revealPath: () => ({ ok: true }),
      openWorkspace: () => ({ ok: true }),
      pickFolder: async () => '/picked',
    })
    const descriptor = gitDescriptor(first.mgr)
    const secondHost = new FakeBrowserWindow()
    await first.mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(secondHost),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: first.mgr.gitCapabilityContext('1.0.0', '/workspace', 'git-left'),
    })
    const firstPick = await call(first.view, 'git.contribution', { operation: 'pick_workspace', payload: {} }, 'first-pick')
    const firstGrant = (firstPick.result as { grant: string }).grant

    await expect(call(secondHost.children[0] as FakeViewLike, 'git.contribution', {
      operation: 'open_workspace',
      payload: { path: '/picked', grant: firstGrant },
    }, 'wrong-instance')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })

    const now = Date.now()
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    const expiringPick = await call(first.view, 'git.contribution', { operation: 'pick_workspace', payload: {} }, 'expiring-pick')
    const expiringGrant = (expiringPick.result as { grant: string }).grant
    dateNow.mockReturnValue(now + (5 * 60 * 1000) + 1)
    await expect(call(first.view, 'git.contribution', {
      operation: 'open_workspace',
      payload: { path: '/picked', grant: expiringGrant },
    }, 'expired-grant')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    dateNow.mockRestore()

    first.mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => 'account',
      getCredential: () => ({ username: 'alice', token: 'fixture-secret', expectedHost: 'github.com' }),
    })
    const clonePick = await call(first.view, 'git.contribution', { operation: 'pick_workspace', payload: {} }, 'clone-pick')
    await expect(call(first.view, 'git.request', {
      type: 'git.clone',
      payload: {
        workspace_path: '/workspace',
        url: 'https://github.com/acme/repo.git',
        target_dir: '/picked/../sibling',
        target_grant: (clonePick.result as { grant: string }).grant,
      },
    }, 'clone-sibling-traversal')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('rejects Git contribution paths through a symlink to an outside target', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-workspace-'))
    const outsidePath = mkdtempSync(join(tmpdir(), 'navide-git-outside-'))
    try {
      writeFileSync(join(outsidePath, 'secret.txt'), 'secret')
      symlinkSync(outsidePath, join(workspacePath, 'link'), 'dir')
      const { view, sent } = await openGitView(workspacePath)
      const actions = [
        {
          operation: 'open_file',
          payload: { workspace_path: workspacePath, filepath: 'link/secret.txt', name: 'secret.txt' },
        },
        {
          operation: 'open_conflict',
          payload: { workspace_path: workspacePath, filepath: 'link/secret.txt', name: 'secret.txt' },
        },
        {
          operation: 'open_diff',
          payload: { workspace_path: workspacePath, filepath: 'link/secret.txt', staged: false, name: 'secret.txt' },
        },
        {
          operation: 'open_git_window',
          payload: { workspace_path: workspacePath, filepath: 'link/secret.txt' },
        },
        {
          operation: 'open_path',
          payload: { path: join(workspacePath, 'link', 'secret.txt') },
        },
      ] as const

      for (const [index, action] of actions.entries()) {
        const response = await call(view, 'git.contribution', action, `git-symlink-outside-${index}`)
        expect(response).toMatchObject({
          ok: false,
          error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
        })
      }
      expect(sent).toEqual([])
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(outsidePath, { recursive: true, force: true })
    }
  })

  it('keeps private fs.stat_path inside the symlink-aware workspace boundary', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-stat-workspace-'))
    const outsidePath = mkdtempSync(join(tmpdir(), 'navide-git-stat-outside-'))
    try {
      symlinkSync(outsidePath, join(workspacePath, 'outside-link'), 'dir')
      symlinkSync(join(workspacePath, 'missing-target'), join(workspacePath, 'dangling-link'), 'file')
      const { mgr, view } = await openGitView(workspacePath)
      mgr.setBackendWsUrl('ws://git-stat-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()

      for (const path of ['../outside', 'outside-link', 'dangling-link']) {
        await expect(call(view, 'fs.request', {
          type: 'fs.stat_path',
          payload: { workspace_path: workspacePath, path },
        }, `stat-${path}`)).resolves.toMatchObject({
          ok: false,
          error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
        })
      }
      expect(socket.sent).toEqual([])
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(outsidePath, { recursive: true, force: true })
    }
  })

  it('targets a Git repository nested inside the workspace and still rejects outside roots', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-nested-workspace-'))
    const outsidePath = mkdtempSync(join(tmpdir(), 'navide-git-nested-outside-'))
    try {
      const nestedPath = join(workspacePath, 'nested')
      mkdirSync(nestedPath)
      const { mgr, view } = await openGitView(workspacePath)
      mgr.setBackendWsUrl('ws://git-nested-repo-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()

      // Multi-repo mode gives every repository tab the repository's own
      // absolute path, so a nested repo has to reach the backend as itself.
      const nested = call(view, 'git.request', {
        type: 'git.status',
        payload: { workspace_path: nestedPath },
      }, 'git-nested-status')
      await Promise.resolve()
      const nestedRequest = JSON.parse(socket.sent.at(-1)!) as {
        id: string
        type: string
        payload: Record<string, unknown>
      }
      expect(nestedRequest.type).toBe('git.status')
      expect(nestedRequest.payload).toEqual({ workspace_path: realpathSync(nestedPath) })
      socket.receive({
        id: nestedRequest.id,
        type: nestedRequest.type,
        ok: true,
        payload: { ok: true },
        error: null,
        timestamp: '',
      })
      await expect(nested).resolves.toMatchObject({ ok: true })

      // The workspace root keeps the exact binding the view was opened with.
      const root = call(view, 'git.request', {
        type: 'git.status',
        payload: { workspace_path: workspacePath },
      }, 'git-root-status')
      await Promise.resolve()
      const rootRequest = JSON.parse(socket.sent.at(-1)!) as {
        id: string
        type: string
        payload: Record<string, unknown>
      }
      expect(rootRequest.payload).toEqual({ workspace_path: workspacePath })
      socket.receive({
        id: rootRequest.id,
        type: rootRequest.type,
        ok: true,
        payload: { ok: true },
        error: null,
        timestamp: '',
      })
      await expect(root).resolves.toMatchObject({ ok: true })

      const forwarded = socket.sent.length
      const denied = [outsidePath, join(workspacePath, '..'), join(nestedPath, '..', '..'), '']
      for (const [index, candidate] of denied.entries()) {
        await expect(call(view, 'git.request', {
          type: 'git.status',
          payload: { workspace_path: candidate },
        }, `git-nested-outside-${index}`)).resolves.toMatchObject({
          ok: false,
          error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
        })
      }
      expect(socket.sent.length).toBe(forwarded)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(outsidePath, { recursive: true, force: true })
    }
  })

  it('prewarms Git hidden, deactivated, and reuses the instance when opened', async () => {
    const mgr = new FrontendPluginManager()
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-prewarm-workspace-'))
    try {
      const descriptor = gitDescriptor(mgr, workspacePath, 'git-left')
      mgr.registerDescriptor(descriptor, { builtin: true })
      mgr.setCapabilityGrantResolver(() => descriptor.capabilityContext?.userGrant ?? null)
      const host = new FakeBrowserWindow()

      await expect(mgr.ensureContribution(asHost(host), 'navide.git.left', {
        workspacePath,
        capabilityContext: descriptor.capabilityContext,
      })).resolves.toEqual({ ok: true })

      const hidden = host.children[0] as FakeViewLike
      expect(hidden.visible).toBe(false)
      const running = (mgr as unknown as {
        running: Map<string, { view: FakeViewLike }>
        contributionInstances: Map<string, { instanceId: string }>
      }).running
      const instanceId = [...running.keys()][0]
      expect(instanceId).toBeDefined()
      ;(mgr as unknown as {
        dispatchEvent(event: string, payload: unknown): void
      }).dispatchEvent('git.changed', { workspace_path: workspacePath, changes_count: 4 })
      expect(hidden.webContents.sent).toContainEqual({
        channel: 'plugin:cap:event',
        args: [{ type: 'git.changed', data: { workspace_path: workspacePath, changes_count: 4 } }],
      })

      await expect(mgr.openContribution(asHost(host), 'navide.git.left', {
        workspacePath,
        bounds: { x: 0, y: 0, width: 320, height: 480 },
        capabilityContext: descriptor.capabilityContext,
      })).resolves.toEqual({ ok: true })
      expect(hidden.visible).toBe(true)
      expect([...running.keys()]).toEqual([instanceId])
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('rejects first-party filesystem mutations inside the Git metadata tree', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-mutation-workspace-'))
    try {
      mkdirSync(join(workspacePath, '.git'))
      writeFileSync(join(workspacePath, '.git', 'config'), '[core]\n')
      writeFileSync(join(workspacePath, 'ordinary.txt'), 'ordinary')
      const { mgr, view } = await openGitView(workspacePath)
      mgr.setBackendWsUrl('ws://git-mutation-boundary-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()

      const requests = [
        {
          type: 'fs.write_file',
          payload: { workspace_path: workspacePath, rel_path: '.git/config', content: 'changed' },
        },
        {
          type: 'fs.write_file',
          payload: { workspace_path: workspacePath, rel_path: '.git\\config', content: 'changed' },
        },
        {
          type: 'fs.delete',
          payload: { workspace_path: workspacePath, rel_path: '.git/config' },
        },
        {
          type: 'fs.rename',
          payload: { workspace_path: workspacePath, src_rel: 'ordinary.txt', dst_rel: '.git/moved' },
        },
        {
          type: 'fs.rename',
          payload: { workspace_path: workspacePath, src_rel: '.git/config', dst_rel: 'moved' },
        },
      ] as const

      for (const [index, request] of requests.entries()) {
        await expect(call(view, 'fs.request', request, `git-mutation-${index}`)).resolves.toMatchObject({
          ok: false,
          error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
        })
      }
      expect(socket.sent).toEqual([])
      expect(readFileSync(join(workspacePath, 'ordinary.txt'), 'utf8')).toBe('ordinary')
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('rejects public fs.writeFile before it reaches the backend for Git metadata', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-public-fs-workspace-'))
    try {
      mkdirSync(join(workspacePath, '.git'))
      writeFileSync(join(workspacePath, '.git', 'config'), '[core]\n')
      const { mgr } = await openGitView(workspacePath)
      mgr.setBackendWsUrl('ws://public-fs-mutation-boundary-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const runtime = (
        mgr as unknown as {
          running: Map<string, { capabilityContext: HostCapabilityContext }>
        }
      ).running.get([...(
        mgr as unknown as { running: Map<string, unknown> }
      ).running.keys()][0]!)!.capabilityContext.runtimeBinding!

      await expect(mgr.executePublicCapability({
        kind: 'public',
        address: 'fs.writeFile',
        scope: 'workspace',
        runtime,
        args: { path: '.git/config', content: 'changed' },
      })).rejects.toThrow(/Git metadata/)
      expect(socket.sent).toEqual([])
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('rejects Git contribution paths through a dangling symlink', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-workspace-'))
    const outsidePath = mkdtempSync(join(tmpdir(), 'navide-git-outside-'))
    try {
      symlinkSync(join(outsidePath, 'missing-target'), join(workspacePath, 'dangling'), 'file')
      const { view, sent } = await openGitView(workspacePath)
      const actions = [
        {
          operation: 'open_file',
          payload: { workspace_path: workspacePath, filepath: 'dangling/secret.txt', name: 'secret.txt' },
        },
        {
          operation: 'open_path',
          payload: { path: join(workspacePath, 'dangling', 'secret.txt') },
        },
      ] as const

      for (const [index, action] of actions.entries()) {
        const response = await call(view, 'git.contribution', action, `git-symlink-dangling-${index}`)
        expect(response).toMatchObject({
          ok: false,
          error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
        })
      }
      expect(sent).toEqual([])
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(outsidePath, { recursive: true, force: true })
    }
  })

  it('allows an internal symlink and a missing ordinary leaf inside the workspace', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-workspace-'))
    try {
      mkdirSync(join(workspacePath, 'real-dir'))
      writeFileSync(join(workspacePath, 'real-dir', 'app.ts'), 'export {}')
      symlinkSync(join(workspacePath, 'real-dir'), join(workspacePath, 'inside-link'), 'dir')
      const { view, sent } = await openGitView(workspacePath)

      const internalLink = await call(view, 'git.contribution', {
        operation: 'open_file',
        payload: { workspace_path: workspacePath, filepath: 'inside-link/app.ts', name: 'app.ts' },
      }, 'git-symlink-inside')
      expect(internalLink).toMatchObject({ ok: true, result: { accepted: true } })

      const missingLeaf = await call(view, 'git.contribution', {
        operation: 'open_path',
        payload: { path: join(workspacePath, 'new-dir', 'new-file.ts') },
      }, 'git-missing-leaf')
      expect(missingLeaf).toMatchObject({ ok: true, result: { accepted: true } })
      expect(sent).toHaveLength(2)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('keeps account credentials Host-owned and workspace-scoped', async () => {
    const { mgr, view } = await openGitView()
    const bind = vi.fn()
    const unbind = vi.fn()
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [{ id: 'account-1', label: 'GitHub', host: 'github.com', username: 'alice', tokenLast4: '1234' }],
      add: () => ({ id: 'account-2', label: 'GitLab', host: 'gitlab.com', username: 'bob', tokenLast4: '5678' }),
      update: () => undefined,
      remove: () => undefined,
      bind,
      unbind,
      getBinding: () => 'account-1',
      getCredential: () => ({ username: 'alice', token: 'secret-token', expectedHost: 'github.com' }),
    })

    const listed = await call(view, 'git.account', { operation: 'list', payload: {} }, 'git-list')
    expect(listed).toEqual({
      reqId: 'git-list',
      ok: true,
      result: {
        available: true,
        accounts: [{ id: 'account-1', label: 'GitHub', host: 'github.com', username: 'alice', tokenLast4: '1234' }],
      },
    })

    await expect(call(view, 'git.account', {
      operation: 'bind',
      payload: { accountId: 'account-1' },
    }, 'git-bind')).resolves.toMatchObject({ ok: true, result: { accountId: 'account-1' } })
    expect(bind).toHaveBeenCalledWith('/workspace', 'account-1')

    await expect(call(view, 'git.account', {
      operation: 'unbind',
      payload: {},
    }, 'git-unbind')).resolves.toMatchObject({ ok: true, result: { accountId: null } })
    expect(unbind).toHaveBeenCalledWith('/workspace')

    await expect(call(view, 'git.account', {
      operation: 'bind',
      payload: { accountId: 'account-1', workspace_path: '/other' },
    }, 'git-bind-forged-workspace')).resolves.toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })
    expect(bind).toHaveBeenCalledTimes(1)

    const response = await call(view, 'git.account', {
      operation: 'get_credential',
      payload: { workspace_path: '/workspace' },
    })
    expect(response).toMatchObject({
      reqId: 'git-1',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })

    const denied = await call(view, 'git.account', {
      operation: 'get_credential',
      payload: { workspace_path: '/other' },
    }, 'git-2')
    expect(denied).toMatchObject({
      reqId: 'git-2',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('limits account actions to Git left and window audiences', async () => {
    const { mgr, view } = await openGitView('/workspace', 'git-history')
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => null,
      getCredential: () => null,
    })

    await expect(call(view, 'git.account', {
      operation: 'list',
      payload: {},
    }, 'git-account-wrong-audience')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('requires the first-party allowlist shell policy and grant for Git requests', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor = gitDescriptor(mgr)
    descriptor.capabilityPolicy = manifestV2CapabilityPolicy({
      system: ['fs', 'ui', 'aiCli'],
    })
    mgr.registerDescriptor(descriptor, { builtin: true })
    const host = new FakeBrowserWindow()
    const handle = await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: descriptor.capabilityContext,
    })

    const response = await call(host.children[0] as FakeViewLike, 'git.request', {
      type: 'git.status',
      payload: { workspace_path: '/workspace' },
    })
    expect(handle.instanceId).toBeTruthy()
    expect(response).toMatchObject({
      reqId: 'git-1',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('requires publisher eligibility and an allowlist grant for Issues requests', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor = gitDescriptor(mgr)
    descriptor.capabilityContext = {
      ...descriptor.capabilityContext!,
      publisherEligible: false,
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    const host = new FakeBrowserWindow()
    await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: descriptor.capabilityContext,
    })

    const response = await call(host.children[0] as FakeViewLike, 'issues.request', {
      type: 'issues.list',
      payload: { workspace_path: '/workspace', limit: 10 },
    })
    expect(response).toMatchObject({
      reqId: 'git-1',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('rejects Git requests when the shell mode is full instead of allowlist', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor = gitDescriptor(mgr)
    descriptor.capabilityPolicy = manifestV2CapabilityPolicy({
      system: ['fs', 'ui', 'aiCli'],
      shell: 'full',
    })
    descriptor.capabilityContext = {
      ...descriptor.capabilityContext!,
      userGrant: { ...descriptor.capabilityContext!.userGrant!, shell: 'full' },
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    const host = new FakeBrowserWindow()
    await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: descriptor.capabilityContext,
    })

    const response = await call(host.children[0] as FakeViewLike, 'git.request', {
      type: 'git.status',
      payload: { workspace_path: '/workspace' },
    })
    expect(response).toMatchObject({
      reqId: 'git-1',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('rejects Git requests when the package grant omits shell access', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor = gitDescriptor(mgr)
    descriptor.capabilityContext = {
      ...descriptor.capabilityContext!,
      userGrant: {
        packageVersion: '1.0.0',
        system: ['fs', 'ui', 'aiCli'],
        storage: true,
      },
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    const host = new FakeBrowserWindow()
    await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: descriptor.capabilityContext,
    })

    const response = await call(host.children[0] as FakeViewLike, 'git.request', {
      type: 'git.status',
      payload: { workspace_path: '/workspace' },
    })
    expect(response).toMatchObject({
      reqId: 'git-1',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('injects the bound credential only into Host-to-backend remote Git requests', async () => {
    const { mgr, view } = await openGitView()
    mgr.setBackendWsUrl('ws://git-credential-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => 'account-1',
      getCredential: (workspacePath) => workspacePath === '/workspace'
        ? { username: 'alice', token: 'secret-token', expectedHost: 'github.com' }
        : null,
    })

    const operation = call(view, 'git.request', {
      type: 'git.push',
      payload: { workspace_path: '/workspace', remote: 'origin', branch: 'main' },
    })
    await Promise.resolve()
    const request = JSON.parse(socket.sent.at(-1)!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(request.type).toBe('git.push')
    expect(request.payload).toEqual({
      workspace_path: '/workspace',
      remote: 'origin',
      branch: 'main',
      credential: { username: 'alice', token: 'secret-token', expectedHost: 'github.com' },
    })
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })
    await expect(operation).resolves.toMatchObject({ ok: true })

    const rawCredential = await call(view, 'git.request', {
      type: 'git.push',
      payload: {
        workspace_path: '/workspace',
        credential: { username: 'mallory', token: 'plugin-supplied' },
      },
    }, 'git-raw-credential')
    expect(rawCredential).toMatchObject({
      reqId: 'git-raw-credential',
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })
    expect(socket.sent.map((raw) => JSON.parse(raw).payload.credential?.token)).not.toContain('plugin-supplied')
  })

  it('preserves Git-native authentication when no Host credential is bound', async () => {
    const { mgr, view } = await openGitView()
    mgr.setBackendWsUrl('ws://git-credential-required-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const getCredential = vi.fn(() => null)
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => null,
      getCredential,
    })

    const operation = call(view, 'git.request', {
      type: 'git.push',
      payload: { workspace_path: '/workspace', remote: 'origin', branch: 'main' },
    }, 'git-with-native-auth')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!)
    expect(request.payload).toMatchObject({
      workspace_path: '/workspace',
      remote: 'origin',
      branch: 'main',
    })
    expect(request.payload.credential_owner_nonce).toEqual(expect.any(String))
    expect(request.payload).not.toHaveProperty('credential')
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })
    await expect(operation).resolves.toMatchObject({ ok: true })
    expect(getCredential).toHaveBeenCalledWith('/workspace')
  })

  it('releases an interactive credential owner when the backend is unavailable', async () => {
    const { mgr, view } = await openGitView()
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => null,
      getCredential: () => null,
    })

    await expect(call(view, 'git.request', {
      type: 'git.fetch',
      payload: { workspace_path: '/workspace' },
    }, 'git-no-backend-owner')).resolves.toMatchObject({
      ok: false,
      error: { code: 'BACKEND_ERROR' },
    })
    const owners = (mgr as unknown as { gitCredentialOwners: Map<string, unknown> }).gitCredentialOwners
    expect(owners.size).toBe(0)
  })

  it('routes interactive credential prompts and replies to the exact requesting instance', async () => {
    const first = await openGitView('/workspace', 'git-left')
    const secondDescriptor = gitDescriptor(first.mgr, '/workspace', 'git-left')
    const secondHost = new FakeBrowserWindow()
    await first.mgr.openView(secondDescriptor, secondDescriptor.views![0], {
      hostWindow: asHost(secondHost),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: secondDescriptor.capabilityContext,
    })
    const secondView = secondHost.children[0] as FakeViewLike
    first.mgr.setBackendWsUrl('ws://git-interactive-credential-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    first.mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => null,
      getCredential: () => null,
    })

    await expect(call(first.view, 'git.request', {
      type: 'git.fetch',
      payload: {
        workspace_path: '/workspace',
        credential_owner_nonce: 'renderer-chosen',
      },
    }, 'git-forged-credential-owner')).resolves.toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })

    const operation = call(first.view, 'git.request', {
      type: 'git.fetch',
      payload: { workspace_path: '/workspace' },
    }, 'git-interactive-fetch')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const fetchRequest = JSON.parse(socket.sent[0]!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(fetchRequest.payload.credential_owner_nonce).toMatch(/^[a-f0-9-]{36}$/)

    socket.receive({
      id: 'credential-event',
      type: 'git.credential_request',
      payload: {
        request_id: 'askpass-1',
        workspace_path: '/workspace',
        host: 'github.com',
        prompt: "Username for 'https://github.com': ",
        credential_owner_nonce: fetchRequest.payload.credential_owner_nonce,
      },
      timestamp: '',
    })
    const credentialEvents = (view: FakeViewLike) => view.webContents.sent.filter(
      (message) => message.channel === 'plugin:cap:event' &&
        (message.args[0] as { type?: string }).type === 'git.credential_request',
    )
    expect(credentialEvents(first.view)).toHaveLength(1)
    expect(credentialEvents(secondView)).toHaveLength(0)

    await expect(call(secondView, 'git.request', {
      type: 'git.credential_submit',
      payload: { request_id: 'askpass-1', value: 'forged' },
    }, 'forged-submit')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    expect(socket.sent).toHaveLength(1)

    const submit = call(first.view, 'git.request', {
      type: 'git.credential_submit',
      payload: { request_id: 'askpass-1', value: 'alice' },
    }, 'owner-submit')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const submitRequest = JSON.parse(socket.sent[1]!)
    expect(submitRequest.type).toBe('git.credential_submit')
    socket.receive({
      id: submitRequest.id,
      type: submitRequest.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })
    await expect(submit).resolves.toMatchObject({ ok: true })

    socket.receive({
      id: fetchRequest.id,
      type: fetchRequest.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })
    await expect(operation).resolves.toMatchObject({ ok: true })
  })

  it('buffers early AI output and resumes a detached session by Host tuple', async () => {
    vi.useFakeTimers()
    try {
      const first = await openGitView('/workspace', 'git-window')
      first.mgr.setBackendWsUrl('ws://git-ai-resume-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const runtimeOf = (instanceId: string) => (
        first.mgr as unknown as {
          running: Map<string, { capabilityContext: HostCapabilityContext }>
        }
      ).running.get(instanceId)!.capabilityContext.runtimeBinding!

      await expect(first.mgr.executePublicCapability({
        kind: 'public',
        address: 'aiCli.listProfiles',
        scope: 'workspace',
        runtime: runtimeOf(first.instanceId),
        args: {},
      })).resolves.toMatchObject({
        profiles: expect.arrayContaining([{ id: 'claude', label: 'Claude Code' }]),
      })

      const start = first.mgr.executePublicCapability({
        kind: 'public',
        address: 'aiCli.startSession',
        scope: 'workspace',
        runtime: runtimeOf(first.instanceId),
        args: {
          profileId: 'claude',
          requestId: 'start-1',
          cols: 80,
          rows: 24,
          yolo: true,
        },
      })
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
      const create = JSON.parse(socket.sent[0]!)
      expect(create.type).toBe('terminal.create')
      expect(create.payload.command).toContain('--dangerously-skip-permissions')

      socket.receive({
        id: 'early-output',
        type: 'terminal.output',
        payload: {
          terminal_session_id: 'ai-session-1',
          pane_id: create.payload.pane_id,
          sequence: 1,
          data: 'early output',
        },
        timestamp: '',
      })
      expect(first.view.webContents.sent.some((message) =>
        message.channel === 'plugin:cap:event' &&
        (message.args[0] as { type?: string }).type === 'aiCli.output'
      )).toBe(false)

      socket.receive({
        id: create.id,
        type: create.type,
        ok: true,
        payload: {
          terminal_session_id: 'ai-session-1',
          pane_id: create.payload.pane_id,
          create_generation: 'start-1',
        },
        error: null,
        timestamp: '',
      })
      await expect(start).resolves.toEqual({ sessionId: 'ai-session-1' })
      await vi.advanceTimersByTimeAsync(12)
      expect(first.view.webContents.sent).toContainEqual({
        channel: 'plugin:cap:event',
        args: [{ type: 'aiCli.output', data: { sessionId: 'ai-session-1', data: 'early output' } }],
      })

      first.mgr.destroyInstance(first.instanceId)
      const descriptor = gitDescriptor(first.mgr, '/workspace', 'git-window')
      const secondHost = new FakeBrowserWindow()
      const second = await first.mgr.openView(descriptor, descriptor.views![0], {
        hostWindow: asHost(secondHost),
        bounds: 'fill',
        workspacePath: '/workspace',
        capabilityContext: descriptor.capabilityContext,
      })
      const resume = first.mgr.executePublicCapability({
        kind: 'public',
        address: 'aiCli.resumeSession',
        scope: 'workspace',
        runtime: runtimeOf(second.instanceId),
        args: { cols: 100, rows: 30 },
      })
      await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
      const reattach = JSON.parse(socket.sent[1]!)
      expect(reattach).toMatchObject({
        type: 'terminal.reattach',
        payload: { terminal_session_ids: ['ai-session-1'], cols: 100, rows: 30 },
      })
      socket.receive({
        id: reattach.id,
        type: reattach.type,
        ok: true,
        payload: { alive: ['ai-session-1'], dead: [] },
        error: null,
        timestamp: '',
      })
      await expect(resume).resolves.toEqual({ sessionId: 'ai-session-1', profileId: 'claude' })
      expect(socket.sent.map((raw) => JSON.parse(raw).type)).toEqual([
        'terminal.create',
        'terminal.reattach',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds and expires AI output that arrives before session creation commits', async () => {
    vi.useFakeTimers()
    try {
      const opened = await openGitView('/workspace', 'git-window')
      opened.mgr.setBackendWsUrl('ws://git-ai-early-buffer-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const runtime = (
        opened.mgr as unknown as {
          running: Map<string, { capabilityContext: HostCapabilityContext }>
        }
      ).running.get(opened.instanceId)!.capabilityContext.runtimeBinding!
      const start = opened.mgr.executePublicCapability({
        kind: 'public',
        address: 'aiCli.startSession',
        scope: 'workspace',
        runtime,
        args: { profileId: 'claude', requestId: 'bounded-start', cols: 80, rows: 24 },
      })
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
      const create = JSON.parse(socket.sent[0]!)
      for (let index = 0; index < 130; index += 1) {
        socket.receive({
          id: `early-${index}`,
          type: 'terminal.output',
          payload: {
            terminal_session_id: 'bounded-session',
            pane_id: create.payload.pane_id,
            sequence: index,
            data: String(index),
          },
          timestamp: '',
        })
      }
      const buffers = (
        opened.mgr as unknown as {
          earlyAiEvents: Map<string, { events: unknown[] }>
        }
      ).earlyAiEvents
      expect([...buffers.values()][0]?.events).toHaveLength(128)

      await vi.advanceTimersByTimeAsync(5_001)
      socket.receive({
        id: create.id,
        type: create.type,
        ok: true,
        payload: {
          terminal_session_id: 'bounded-session',
          pane_id: create.payload.pane_id,
          create_generation: 'bounded-start',
        },
        error: null,
        timestamp: '',
      })
      await expect(start).resolves.toEqual({ sessionId: 'bounded-session' })
      await vi.advanceTimersByTimeAsync(12)
      expect(opened.view.webContents.sent.some((message) =>
        message.channel === 'plugin:cap:event' &&
        (message.args[0] as { type?: string }).type === 'aiCli.output'
      )).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('injects a bound credential for a matching HTTPS clone host only', async () => {
    const { mgr, view } = await openGitView()
    mgr.setBackendWsUrl('ws://git-clone-host-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => 'account-1',
      getCredential: () => ({ username: 'alice', token: 'fixture-secret', expectedHost: 'github.com' }),
    })

    await expect(call(view, 'git.request', {
      type: 'git.clone',
      payload: { workspace_path: '/workspace', url: 'https://gitlab.com/acme/repo.git', target_dir: '/tmp/repo' },
    }, 'clone-host-mismatch')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CREDENTIAL_REQUIRED' },
    })
    expect(socket.sent).toEqual([])

    await expect(call(view, 'git.request', {
      type: 'git.clone',
      payload: { workspace_path: '/workspace', url: 'https://github.com/acme/repo.git', target_dir: '/tmp/repo' },
    }, 'clone-without-grant')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    expect(socket.sent).toEqual([])

    mgr.setHostShellHandlers({
      openExternal: async () => ({ ok: true }),
      revealPath: () => ({ ok: true }),
      openWorkspace: () => ({ ok: true }),
      pickFolder: async () => '/tmp',
    })
    const picked = await call(view, 'git.contribution', { operation: 'pick_workspace', payload: {} }, 'clone-parent-pick')
    const targetGrant = (picked.result as { grant: string }).grant

    const pending = call(view, 'git.request', {
      type: 'git.clone',
      payload: {
        workspace_path: '/workspace',
        url: 'https://github.com/acme/repo.git',
        target_dir: '/tmp/repo',
        target_grant: targetGrant,
      },
    }, 'clone-host-match')
    await Promise.resolve()
    const request = JSON.parse(socket.sent.at(-1)!) as { id: string; type: string; payload: Record<string, unknown> }
    expect(request.payload.credential).toEqual({ username: 'alice', token: 'fixture-secret', expectedHost: 'github.com' })
    socket.receive({ id: request.id, type: request.type, ok: true, payload: { ok: true, path: '/tmp/repo' }, error: null, timestamp: '' })
    const cloned = await pending
    expect(cloned).toMatchObject({ ok: true, result: { path: '/tmp/repo', openWorkspaceGrant: expect.any(String) } })
    await expect(call(view, 'git.contribution', {
      operation: 'open_workspace',
      payload: {
        path: '/tmp/repo',
        grant: (cloned.result as { openWorkspaceGrant: string }).openWorkspaceGrant,
      },
    }, 'open-cloned-workspace')).resolves.toMatchObject({ ok: true })
  })

  it('opens a git-window clone through the Host seam after consuming only its exact derived grant', async () => {
    const { mgr, view, sent } = await openGitView('/workspace', 'git-window')
    const opened: string[] = []
    mgr.setHostShellHandlers({
      openExternal: async () => ({ ok: true }),
      revealPath: () => ({ ok: true }),
      openWorkspace: (path) => {
        opened.push(path)
        return { ok: true }
      },
      pickFolder: async () => '/private/tmp',
    })
    mgr.setBackendWsUrl('ws://git-window-clone-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => 'account-1',
      getCredential: () => ({ username: 'alice', token: 'fixture-secret', expectedHost: 'github.com' }),
    })

    const picked = await call(view, 'git.contribution', { operation: 'pick_workspace', payload: {} }, 'window-clone-pick')
    const clone = call(view, 'git.request', {
      type: 'git.clone',
      payload: {
        workspace_path: '/workspace',
        url: 'https://github.com/acme/repo.git',
        target_dir: '/private/tmp/repo',
        target_grant: (picked.result as { grant: string }).grant,
      },
    }, 'window-clone')
    await Promise.resolve()
    const request = JSON.parse(socket.sent.at(-1)!) as { id: string; type: string }
    socket.receive({ id: request.id, type: request.type, ok: true, payload: { ok: true, path: '/private/tmp/repo' }, error: null, timestamp: '' })
    const cloned = await clone
    const derivedGrant = (cloned.result as { openWorkspaceGrant: string }).openWorkspaceGrant

    const sameVersion = gitDescriptor(mgr, '/workspace', 'git-window')
    const sameVersionHost = new FakeBrowserWindow()
    await mgr.openView(sameVersion, sameVersion.views![0], {
      hostWindow: asHost(sameVersionHost),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: sameVersion.capabilityContext,
    })
    const differentVersion = gitDescriptor(mgr, '/workspace', 'git-window', '2.0.0')
    const differentVersionHost = new FakeBrowserWindow()
    mgr.registerDescriptor(differentVersion, { builtin: true })
    await mgr.openView(differentVersion, differentVersion.views![0], {
      hostWindow: asHost(differentVersionHost),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: differentVersion.capabilityContext,
    })

    for (const [candidate, path, reqId] of [
      [sameVersionHost.children[0] as FakeViewLike, '/private/tmp/repo', 'window-wrong-instance'],
      [differentVersionHost.children[0] as FakeViewLike, '/private/tmp/repo', 'window-wrong-version'],
      [view, '/private/tmp/other', 'window-wrong-path'],
    ] as const) {
      await expect(call(candidate, 'git.contribution', {
        operation: 'open_workspace', payload: { path, grant: derivedGrant },
      }, reqId)).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
    }

    await expect(call(view, 'git.contribution', {
      operation: 'open_workspace', payload: { path: '/private/tmp/repo', grant: derivedGrant },
    }, 'window-open-clone')).resolves.toEqual({
      reqId: 'window-open-clone', ok: true, result: { accepted: true },
    })
    expect(opened).toEqual(['/private/tmp/repo'])
    expect(sent).toEqual([])

    await expect(call(view, 'git.contribution', {
      operation: 'open_workspace', payload: { path: '/private/tmp/repo', grant: derivedGrant },
    }, 'window-replay')).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
  })

  it('does not inject a credential into Issues requests', async () => {
    const { mgr, view } = await openGitView()
    mgr.setBackendWsUrl('ws://git-issues-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const getCredential = vi.fn(() => ({ username: 'alice', token: 'secret-token', expectedHost: 'github.com' }))
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => 'account-1',
      getCredential,
    })

    const operation = call(view, 'issues.request', {
      type: 'issues.list',
      payload: { workspace_path: '/workspace', limit: 10 },
    })
    await Promise.resolve()
    const request = JSON.parse(socket.sent.at(-1)!) as { id: string; type: string; payload: Record<string, unknown> }
    expect(request.payload).toEqual({ workspace_path: '/workspace', limit: 10 })
    expect(getCredential).not.toHaveBeenCalled()
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: { ok: true, issues: [] },
      error: null,
      timestamp: '',
    })
    await expect(operation).resolves.toMatchObject({ ok: true })

    const localOperation = call(view, 'git.request', {
      type: 'git.status',
      payload: { workspace_path: '/workspace' },
    }, 'git-local-no-credential')
    await Promise.resolve()
    const localRequest = JSON.parse(socket.sent.at(-1)!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(localRequest.type).toBe('git.status')
    expect(localRequest.payload).toEqual({ workspace_path: '/workspace' })
    socket.receive({
      id: localRequest.id,
      type: localRequest.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })
    await expect(localOperation).resolves.toMatchObject({ ok: true })
    expect(getCredential).not.toHaveBeenCalled()
  })
})

describe('Git left legacy rollback composition', () => {
  it('returns an explicit legacy fallback after replacing a live v2 left view', async () => {
    const host = new FakeBrowserWindow()
    Object.defineProperty(host, 'id', { value: 77 })
    const v2: PluginLaunchDescriptor = {
      id: 'navide.git',
      packageVersion: '2.0.0',
      requires: ['terminal'],
      capabilityPolicy: manifestV2CapabilityPolicy({
        system: ['fs', 'ui', 'aiCli'],
        shell: 'allowlist',
      }),
      capabilityContext: frontendPluginManager.gitCapabilityContext('2.0.0', '/workspace', 'git-left'),
      devUrl: '',
      entryFile: '/plugins/navide-git/index.html',
      views: [
        {
          id: 'left',
          contributionKey: 'navide.git.left',
          kind: 'custom',
          location: 'left',
          title: 'Git',
          entryFile: '/plugins/navide-git/left.html',
        },
      ],
    }
    const legacy: PluginLaunchDescriptor = {
      id: 'navide.git',
      requires: [],
      devUrl: '',
      entryFile: '/plugins/git/index.html',
    }

    frontendPluginManager.replaceBuiltinForRecovery(v2)
    await expect(openGitLeftPluginView(
      asHost(host),
      '/workspace',
      { x: 0, y: 0, width: 400, height: 300 },
      '',
      '',
      {
        git_yolo: '0',
        git_analyzer_model: 'qwen2:latest',
        git_theme_custom: '{}',
      },
    )).resolves.toEqual({ ok: true })
    expect((host.children[0] as FakeViewLike).webContents.loads).toEqual([
      '/plugins/navide-git/left.html?workspace_path=%2Fworkspace&git_yolo=0&git_analyzer_model=qwen2%3Alatest&git_theme_custom=%7B%7D&v2=1&contribution=left',
    ])

    frontendPluginManager.replaceBuiltinForRecovery(legacy)
    await expect(openGitLeftPluginView(
      asHost(host),
      '/workspace',
      { x: 0, y: 0, width: 400, height: 300 },
    )).resolves.toEqual({ ok: true, fallback: 'legacy' })
    expect(host.children).toHaveLength(0)
    expect(closeGitLeftPluginView(asHost(host))).toEqual({ ok: true })
  })

  describe('plansQuery and openPlansPluginView locale propagation', () => {
    it('formats plansQuery with validated locale', () => {
      const q1 = new URLSearchParams(plansQuery('/workspace', 'http://127.0.0.1:1', 'plan.html', 'dark', 'en-US'))
      expect(q1.get('workspace_path')).toBe('/workspace')
      expect(q1.get('http_url')).toBe('http://127.0.0.1:1')
      expect(q1.get('rel_path')).toBe('plan.html')
      expect(q1.get('theme')).toBe('dark')
      expect(q1.get('locale')).toBe('en-US')
      expect(q1.get('v2')).toBe('1')
      expect(q1.get('contribution')).toBe('window')

      const q2 = new URLSearchParams(plansQuery('/workspace', '', '', '', 'zh-TW'))
      expect(q2.get('locale')).toBe('zh-TW')

      const q3 = new URLSearchParams(plansQuery('/workspace', '', '', '', '  en-US  '))
      expect(q3.get('locale')).toBe('en-US')

      const q4 = new URLSearchParams(plansQuery('/workspace', '', '', '', 'fr-FR'))
      expect(q4.get('locale')).toBe('zh-TW')

      const q5 = new URLSearchParams(plansQuery('/workspace', '', '', ''))
      expect(q5.get('locale')).toBe('zh-TW')
    })

    it('passes validated locale through openPlansPluginView for legacy Plans descriptor', async () => {
      const legacyPlans: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        requires: ['fs', 'ui', 'plans', 'terminal'],
        devUrl: '',
        entryFile: '/plugins/plans/index.html',
      }
      frontendPluginManager.registerDescriptor(legacyPlans, { builtin: true })
      const host = new FakeBrowserWindow()

      const opened = await openPlansPluginView(
        asHost(host),
        '/workspace',
        'http://127.0.0.1:1234',
        '.agent-team/plans/my-plan.html',
        'dark',
        'en-US',
      )
      expect(opened).toBe(true)
      expect(host.children).toHaveLength(1)
      const view = host.children[0] as FakeViewLike
      expect(view.webContents.loads[0]).toContain('locale=en-US')
      expect(view.webContents.loads[0]).toContain('workspace_path=%2Fworkspace')
    })

    it('passes validated locale through openPlansPluginView for v2 Plans descriptor', async () => {
      const packageVersion = '0.1.92'
      const packageDir = realpathSync(process.cwd())
      const v2Plans: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir,
        requires: ['fs', 'ui', 'plans', 'terminal'],
        capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs', 'ui', 'aiCli'], shell: 'allowlist' }),
        devUrl: '',
        entryFile: '/plugins/navide-plans/index.html',
        views: [
          {
            id: 'left',
            contributionKey: `${PLANS_PLUGIN_ID}.left`,
            kind: 'custom',
            location: 'left',
            title: 'Plans',
            entryFile: '/plugins/navide-plans/left.html',
          },
          {
            id: 'window',
            contributionKey: `${PLANS_PLUGIN_ID}.window`,
            kind: 'custom',
            location: 'window',
            title: 'Plans',
            entryFile: '/plugins/navide-plans/window.html',
          },
        ],
      }
      frontendPluginManager.registerDescriptor(v2Plans, { builtin: true })
      frontendPluginManager.registerBackendActivation({
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir,
        entryFile: '/plugins/navide-plans/backend/navide-plans',
        protocolVersion: 1,
        activation: 'startup',
        approvedMethods: ['plans.list'],
        agentMethods: ['plans.list'],
        approvedEvents: ['plans.changed'],
        approvedBridgePorts: ['filesystem'],
      })
      frontendPluginManager.setCapabilityGrantResolver((pluginId, version) => {
        if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
          return {
            packageVersion,
            system: ['fs', 'ui', 'aiCli'],
            shell: 'allowlist',
            storage: true,
          }
        }
        return null
      })

      const host = new FakeBrowserWindow()
      const opened = await openPlansPluginView(
        asHost(host),
        packageDir,
        'http://127.0.0.1:1234',
        '.agent-team/plans/my-plan.html',
        'dark',
        'en-US',
      )
      expect(opened).toBe(true)
    })
  })
})
