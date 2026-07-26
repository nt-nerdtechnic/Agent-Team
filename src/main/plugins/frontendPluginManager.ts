// Frontend plugin runtime (main process).
//
// Runs a plugin's UI inside an isolated `WebContentsView` attached to a host
// BrowserWindow, with a minimal, dedicated preload (`plugin-preload.js`). The
// pure broker logic lives in `pluginCapabilityBroker.ts` (unit-tested,
// electron-free): it enforces manifest scoping, resolves `ping`/unknown calls
// in-process, and routes everything else to the backend plugin host over the
// shared WebSocket transport below.

import { BrowserWindow, WebContentsView, ipcMain, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocket as NodeWebSocket } from 'ws'
import {
  parseCapabilityCall,
  planCapabilityCall,
  backendResponseToCapability,
  isCapabilityAllowed,
  buildError,
  type CapabilityResponse,
} from './pluginCapabilityBroker'
import { CAP_EVENTS, eventNamespace } from './capabilityMap'
import { loadPluginDir, scanInstalledPlugins, verifyOfficialInstall } from './installedPlugins'
import { resolveOfficialPublisherKey } from './pluginVerify'
import { createWsClient, type WsClient, type WsConstructor } from '../../shared/wsClient'

/** Everything the manager needs to launch one plugin view. */
export interface PluginLaunchDescriptor {
  /** Manifest id, e.g. `navide.noop`. */
  id: string
  /** Capabilities the plugin's manifest declares (drives broker scoping). */
  requires: string[]
  /** Dev-server URL for the plugin entry (used when running under electron-vite dev). */
  devUrl: string
  /** Absolute file path to the built plugin entry (packaged / built runs). */
  entryFile: string
  /** Optional `?a=b` query appended to the entry (e.g. the mini-IDE workspace
   *  path the app reads from `window.location.search`). Omitted → no query. */
  query?: string
}

export interface PluginBounds {
  x: number
  y: number
  width: number
  height: number
}

/** `'fill'` sizes the view to the host window's content bounds and keeps it
 *  in sync on host `resize` (full-overlay views like the mini-IDE editor). */
export type PluginViewBounds = PluginBounds | 'fill'

interface RunningPlugin {
  id: string
  requires: string[]
  view: WebContentsView
  hostWindow: BrowserWindow
  /** Query string the entry was last loaded with (drives reload-on-change). */
  query: string
  /** webContents.id captured at creation (not readable after destroy). */
  senderId: number
  /** Whether the view overlays the host's full content area (see {@link PluginViewBounds}). */
  fill: boolean
  /** Removes the host `resize` listener; null when none is attached. */
  detachHostResize: (() => void) | null
  /** True when the host window exists solely for this view (dedicated plugin
   *  window): `hideSelf` then closes the window (legacy editor Esc semantics)
   *  instead of hiding the view under a still-visible host. */
  closeHostOnHide: boolean
  /** True once the entry finished loading — open targets sent before that are
   *  queued in {@link pendingTargets} (mirrors the legacy editor window's
   *  pendingEditorOpenFiles flush on did-finish-load). */
  ready: boolean
  pendingTargets: Record<string, string>[]
}

const IPC_CALL = 'plugin:cap:call'
const IPC_EVENT = 'plugin:cap:event'
const IPC_READY = 'plugin:ready'
const IPC_HIDE_SELF = 'plugin:hideSelf'
const IPC_OPEN_TARGET = 'plugin:openTarget'

/** `workspace_path` param of an entry query ('' when absent). */
function workspaceOf(query: string): string {
  return new URLSearchParams(query).get('workspace_path') ?? ''
}

/** Entry query string → plain params record (as sent over IPC_OPEN_TARGET). */
function queryToParams(query: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(query)) out[key] = value
  return out
}

/** Bring a host window to the front (restore if minimized), legacy-editor style. */
function revealHostWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** The `navide.` publisher namespace is reserved for first-party plugins
 *  (mini-IDE, noop, fs_probe). An id here may only be registered by the host
 *  itself (built-in/dev) or by an install whose official-key verification
 *  passed, so a third-party marketplace package cannot masquerade as — or
 *  overwrite — a trusted plugin like `navide.mini-ide`. */
export function isReservedPluginId(id: string): boolean {
  return id === 'navide.mini-ide' || id.startsWith('navide.')
}

/**
 * Manages the lifecycle of frontend plugin views and brokers their capability
 * calls. A single instance owns all plugin views across every host window.
 */
/** Coerce plugin-supplied args into a WS payload object; non-objects become an
 *  empty payload rather than corrupting the backend request. */
function toPayload(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

export class FrontendPluginManager {
  private readonly running = new Map<string, RunningPlugin>()
  /** webContents.id → pluginId, so a call's origin can be trusted, not the payload. */
  private readonly bySender = new Map<number, string>()
  /** Installed/available plugin descriptors keyed by id (loader registry). The
   *  mini-IDE is registered here as the first built-in; third-party installs are
   *  added by {@link loadInstalledPlugins} / {@link registerDescriptor}. */
  private readonly descriptors = new Map<string, PluginLaunchDescriptor>()
  /** Host-bundled builtin descriptors kept as fallbacks: removing a marketplace
   *  override of a bundled plugin reverts to the bundled copy instead of
   *  leaving the surface unavailable (see {@link removeInstalledPlugin}). */
  private readonly builtinFallbacks = new Map<string, PluginLaunchDescriptor>()
  private ipcReady = false
  /** Backend WS url as last reported by main, or null when no backend is up. */
  private backendWsUrl: string | null = null
  /** Lazily-created shared transport to the backend plugin host. */
  private wsClient: WsClient | null = null

  /** Register the broker IPC handlers exactly once. Safe to call repeatedly. */
  registerIpc(): void {
    if (this.ipcReady) return
    this.ipcReady = true

    ipcMain.handle(IPC_CALL, async (event, payload: unknown): Promise<CapabilityResponse> => {
      const pluginId = this.bySender.get(event.sender.id)
      if (!pluginId) {
        // Not a known plugin view — refuse without leaking anything.
        return buildError('', 'BAD_REQUEST', 'unknown plugin sender')
      }
      const plugin = this.running.get(pluginId)
      const call = parseCapabilityCall(payload, pluginId)
      if (!call || !plugin) {
        const reqId =
          typeof payload === 'object' && payload && 'reqId' in payload
            ? String((payload as Record<string, unknown>).reqId ?? '')
            : ''
        return buildError(reqId, 'BAD_REQUEST', 'malformed capability call')
      }

      // Enforce scoping + route. A denied namespace is rejected here and never
      // reaches the backend; `ping`/unknown resolve in-process.
      const plan = planCapabilityCall(call, plugin.requires)
      if (plan.kind === 'respond') return plan.response

      const client = this.ensureBackend()
      if (!client) {
        return buildError(call.reqId, 'BACKEND_ERROR', 'backend not connected')
      }
      try {
        const resp = await client.send(plan.wsType, toPayload(call.args))
        return backendResponseToCapability(call.reqId, resp)
      } catch (err) {
        return buildError(
          call.reqId,
          'BACKEND_ERROR',
          err instanceof Error ? err.message : 'backend request failed'
        )
      }
    })

    // Plugins announce readiness; it is only logged (activation is not gated on it).
    ipcMain.on(IPC_READY, (event) => {
      const pluginId = this.bySender.get(event.sender.id)
      if (pluginId) console.log(`[plugin] ${pluginId} ready`)
    })

    // A plugin dismisses its own view (e.g. the mini-IDE's Esc-close). Scoped
    // to the sender: only the view a webContents belongs to can be hidden by it.
    // A view hosted in a dedicated plugin window closes that window instead
    // (legacy editor Esc behavior; the `closed` hook runs the normal teardown);
    // main-window-hosted views keep the plain view-hide.
    ipcMain.on(IPC_HIDE_SELF, (event) => {
      const pluginId = this.bySender.get(event.sender.id)
      if (!pluginId) return
      const plugin = this.running.get(pluginId)
      if (plugin?.closeHostOnHide && !plugin.hostWindow.isDestroyed()) {
        plugin.hostWindow.close()
      } else {
        this.deactivate(pluginId)
      }
    })
  }

  /**
   * Main tells the manager the backend WS url on every backend transition
   * (ready / restart with a new port / stop / crash). A live client is
   * re-pointed at the new url; a stopped/errored backend puts it into fail-fast
   * so brokered calls reject instead of queueing forever.
   */
  setBackendWsUrl(url: string | null): void {
    this.backendWsUrl = url
    const client = this.wsClient
    if (url) {
      if (!client) {
        // Connect eagerly if a running plugin already needs the backend, so
        // server-push events (git.changed) flow without waiting for the first
        // capability call. Otherwise ensureBackend() connects lazily later.
        if (this.anyPluginNeedsBackend()) this.ensureBackend()
        return
      }
      if (client.isHealthyFor(url)) return
      client.reset('backend changed')
      client.connect(url)
    } else if (client) {
      client.reset('backend stopped')
      client.markErrored()
    }
  }

  /** True when any running plugin declares a non-empty `requires` (i.e. needs
   *  the backend for calls and/or events; `ping`-only plugins don't). */
  private anyPluginNeedsBackend(): boolean {
    for (const plugin of this.running.values()) {
      if (plugin.requires.length > 0) return true
    }
    return false
  }

  /** Lazily create + connect the backend transport, subscribing to the
   *  server-push events the broker forwards. Returns null when no backend url
   *  is known yet. */
  private ensureBackend(): WsClient | null {
    if (!this.backendWsUrl) return null
    if (!this.wsClient) {
      const client = createWsClient({ WebSocketImpl: NodeWebSocket as unknown as WsConstructor })
      for (const event of Object.keys(CAP_EVENTS)) {
        client.on(event, (payload) => this.dispatchEvent(event, payload))
      }
      client.connect(this.backendWsUrl)
      this.wsClient = client
    }
    return this.wsClient
  }

  /** Fan a backend server-push event out to every running plugin whose
   *  manifest grants the namespace gating that event. */
  private dispatchEvent(event: string, payload: unknown): void {
    const ns = eventNamespace(event)
    if (!ns) return
    for (const plugin of this.running.values()) {
      if (isCapabilityAllowed(plugin.requires, ns)) {
        this.emit(plugin.id, event, payload)
      }
    }
  }

  /**
   * create → attach → activate. If the plugin is already running it is brought
   * back to visible and re-bounded (idempotent open); a new open target for the
   * same workspace is delivered in-page (no reload), while a workspace change
   * reloads the entry — mirroring the legacy editor window's routing.
   */
  open(
    hostWindow: BrowserWindow,
    descriptor: PluginLaunchDescriptor,
    bounds: PluginViewBounds,
    opts: { closeHostOnHide?: boolean } = {}
  ): void {
    this.registerIpc()

    const existing = this.running.get(descriptor.id)
    if (existing) {
      if (existing.view.webContents.isDestroyed() || existing.hostWindow.isDestroyed()) {
        // Stale record (renderer crash / host teardown race) — drop it and fall
        // through to a fresh create; loadEntry on a dead webContents would brick.
        this.destroy(descriptor.id)
      } else {
        const query = descriptor.query ?? ''
        const prevQuery = existing.query
        existing.query = query
        if (workspaceOf(query) !== workspaceOf(prevQuery)) {
          // Different workspace → reload the entry with the new params (matches
          // legacy routeEditorWindowOpen's `reload` branch). In-flight queued
          // targets belong to the old workspace and are dropped with it.
          existing.ready = false
          existing.pendingTargets = []
          this.loadEntry(existing.view, descriptor)
        } else if (query) {
          // Same workspace → deliver the open target in-page (legacy
          // `editor:openFile`/`editor:openDiff` semantics: add/reveal the tab
          // without reloading, so open tabs and unsaved buffers survive).
          this.sendOpenTarget(existing, queryToParams(query))
        }
        existing.fill = bounds === 'fill'
        this.applyBounds(existing, bounds)
        this.trackHostResize(existing)
        existing.view.setVisible(true)
        // Surface the window that actually hosts the view. Cross-window opens
        // keep the view on its original host, so focus that one — the open
        // must never land invisibly behind another window.
        revealHostWindow(existing.hostWindow)
        return
      }
    }

    const preload = join(__dirname, '../preload/plugin-preload.js')
    const view = new WebContentsView({
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        // The plugin preload is node-free (webcrypto only), so views run fully
        // sandboxed.
        sandbox: true,
        // Injected so the preload can stamp calls with an authoritative plugin id.
        additionalArguments: [`--plugin-id=${descriptor.id}`],
      },
    })

    // attach
    hostWindow.contentView.addChildView(view)

    const record: RunningPlugin = {
      id: descriptor.id,
      requires: descriptor.requires,
      view,
      hostWindow,
      query: descriptor.query ?? '',
      senderId: view.webContents.id,
      fill: bounds === 'fill',
      detachHostResize: null,
      closeHostOnHide: opts.closeHostOnHide ?? false,
      ready: false,
      pendingTargets: [],
    }
    this.running.set(descriptor.id, record)
    this.bySender.set(record.senderId, descriptor.id)
    this.applyBounds(record, bounds)
    this.trackHostResize(record)

    // A plugin needing the backend gets the shared transport connected now (if
    // the backend url is already known) so server-push events reach it without
    // waiting for its first capability call.
    if (descriptor.requires.length > 0) this.ensureBackend()

    // If the host window goes away, tear the view down with it. Guarded so a
    // later record (view recreated on another window) is never torn down by a
    // stale hook.
    hostWindow.once('closed', () => {
      if (this.running.get(descriptor.id)?.view === view) this.destroy(descriptor.id)
    })

    // Defensive cleanup: if the view's webContents dies through any path other
    // than destroy() (renderer crash, Electron teardown), drop the record so
    // the next open() recreates instead of loading into a destroyed view.
    view.webContents.once('destroyed', () => {
      const current = this.running.get(descriptor.id)
      if (current?.view !== view) return
      current.detachHostResize?.()
      current.detachHostResize = null
      this.running.delete(descriptor.id)
      this.bySender.delete(current.senderId)
    })

    // Open targets sent before the entry finished loading are queued and
    // flushed here (mirrors the legacy editor window's did-finish-load flush).
    view.webContents.on('did-finish-load', () => {
      const current = this.running.get(descriptor.id)
      if (current?.view !== view) return
      current.ready = true
      for (const params of current.pendingTargets.splice(0)) {
        view.webContents.send(IPC_OPEN_TARGET, params)
      }
    })

    this.loadEntry(view, descriptor)

    // activate (show)
    view.setVisible(true)
  }

  /** Deliver a new open target to a running view, queueing until its entry has
   *  finished loading (so a target racing the first load is never lost). */
  private sendOpenTarget(record: RunningPlugin, params: Record<string, string>): void {
    if (record.ready) record.view.webContents.send(IPC_OPEN_TARGET, params)
    else record.pendingTargets.push(params)
  }

  /** Apply a bounds spec: `'fill'` overlays the host's full content area. */
  private applyBounds(record: RunningPlugin, bounds: PluginViewBounds): void {
    if (bounds === 'fill') {
      const { width, height } = record.hostWindow.getContentBounds()
      record.view.setBounds({ x: 0, y: 0, width, height })
    } else {
      record.view.setBounds(bounds)
    }
  }

  /** (Re)attach the host `resize` listener for a fill view — the overlay tracks
   *  the host's content bounds. Fixed-rect views detach and don't track. */
  private trackHostResize(record: RunningPlugin): void {
    record.detachHostResize?.()
    record.detachHostResize = null
    if (!record.fill) return
    const host = record.hostWindow
    const onResize = (): void => {
      if (host.isDestroyed() || record.view.webContents.isDestroyed()) return
      this.applyBounds(record, 'fill')
    }
    host.on('resize', onResize)
    record.detachHostResize = () => host.removeListener('resize', onResize)
  }

  /** Load the plugin entry (dev server when available, built file otherwise).
   *  A plugin with an empty devUrl (e.g. the separately-built mini-IDE) always
   *  loadFiles. */
  private loadEntry(view: WebContentsView, descriptor: PluginLaunchDescriptor): void {
    const devUrl = process.env['ELECTRON_RENDERER_URL'] ? descriptor.devUrl : null
    const query = descriptor.query ?? ''
    if (devUrl) void view.webContents.loadURL(devUrl + query)
    else void view.webContents.loadFile(descriptor.entryFile, query ? { search: query } : undefined)
  }

  /** Show a plugin view without recreating it. A fill view re-syncs to the
   *  host's content bounds and resumes tracking host resizes. */
  activate(pluginId: string): void {
    const plugin = this.running.get(pluginId)
    if (!plugin) return
    if (plugin.fill && !plugin.hostWindow.isDestroyed()) {
      this.applyBounds(plugin, 'fill')
      this.trackHostResize(plugin)
    }
    plugin.view.setVisible(true)
  }

  /** Hide a plugin view without destroying its WebContents. Stops tracking
   *  host resizes while hidden (open()/activate re-attach the listener). */
  deactivate(pluginId: string): void {
    const plugin = this.running.get(pluginId)
    if (!plugin) return
    plugin.detachHostResize?.()
    plugin.detachHostResize = null
    plugin.view.setVisible(false)
  }

  /** Update the plugin view's rect (host-driven layout). */
  setBounds(pluginId: string, bounds: PluginBounds): void {
    const plugin = this.running.get(pluginId)
    if (plugin) plugin.view.setBounds(bounds)
  }

  /** detach → destroy. WebContents are not auto-released, so close explicitly. */
  destroy(pluginId: string): void {
    const plugin = this.running.get(pluginId)
    if (!plugin) return
    plugin.detachHostResize?.()
    plugin.detachHostResize = null
    this.running.delete(pluginId)
    this.bySender.delete(plugin.senderId)
    try {
      if (!plugin.hostWindow.isDestroyed()) {
        plugin.hostWindow.contentView.removeChildView(plugin.view)
      }
      if (!plugin.view.webContents.isDestroyed()) {
        plugin.view.webContents.close()
      }
    } catch {
      // View/window already torn down by Electron — nothing to release.
    }
  }

  // -- loader registry (installed / available descriptors) ----------------

  /**
   * Register (or replace) an available plugin descriptor. Ids under the
   * reserved `navide.` namespace may only be registered by the host itself
   * (`opts.builtin`) or by an install whose pinned-official-key verification
   * passed (`opts.official`); a third-party plugin claiming such an id (e.g.
   * spoofing `navide.mini-ide` to hijack the trusted mini-IDE) is refused.
   */
  registerDescriptor(
    descriptor: PluginLaunchDescriptor,
    opts: { builtin?: boolean; official?: boolean } = {}
  ): void {
    if (!opts.builtin && !opts.official && isReservedPluginId(descriptor.id)) {
      throw new Error(
        `refusing to register reserved plugin id '${descriptor.id}' without official verification`
      )
    }
    this.descriptors.set(descriptor.id, descriptor)
  }

  /**
   * Register a host-bundled builtin descriptor. If a descriptor for the id is
   * already registered (an officially-verified marketplace install scanned
   * before this call), the installed copy stays active and the builtin is only
   * remembered as the fallback {@link removeInstalledPlugin} reverts to.
   */
  registerBuiltin(descriptor: PluginLaunchDescriptor): void {
    this.builtinFallbacks.set(descriptor.id, descriptor)
    if (!this.descriptors.has(descriptor.id)) {
      this.registerDescriptor(descriptor, { builtin: true })
    }
  }

  /** Look up a registered descriptor by id. */
  getDescriptor(id: string): PluginLaunchDescriptor | undefined {
    return this.descriptors.get(id)
  }

  /** All registered (installed + built-in) descriptors. */
  listDescriptors(): PluginLaunchDescriptor[] {
    return [...this.descriptors.values()]
  }

  /**
   * Scan an installed-plugins root and register a descriptor for every valid
   * plugin found. A directory with an invalid manifest is skipped and returned
   * in `errors` rather than aborting the scan. Pure parse/validation lives in
   * `installedPlugins`; this only wires it to the registry.
   */
  loadInstalledPlugins(root: string): { loaded: string[]; errors: string[] } {
    const loaded: string[] = []
    const errors: string[] = []
    for (const scanned of scanInstalledPlugins(root)) {
      if (scanned.descriptor) {
        // A reserved `navide.` id must prove its install receipt still verifies
        // against the pinned official key before it may register (fail-closed:
        // no receipt / no pin / bad signature → skipped, reported as an error).
        let opts: { official?: boolean } = {}
        if (isReservedPluginId(scanned.descriptor.id)) {
          const check = verifyOfficialInstall(
            scanned.dir,
            scanned.descriptor.id,
            resolveOfficialPublisherKey()
          )
          if (!check.ok) {
            errors.push(`${scanned.dir}: ${check.reason}`)
            continue
          }
          opts = { official: true }
        }
        try {
          this.registerDescriptor(scanned.descriptor, opts)
          loaded.push(scanned.descriptor.id)
        } catch (err) {
          // A reserved-id spoof (or other registration refusal) is reported and
          // skipped, never aborting the rest of the scan.
          errors.push(`${scanned.dir}: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else if (scanned.error) {
        errors.push(`${scanned.dir}: ${scanned.error}`)
      }
    }
    return { loaded, errors }
  }

  /** Unregister a descriptor and tear down its view if it is open. Used by the
   *  remove/update flow so a removed plugin's window does not linger. Removing
   *  a marketplace override of a bundled builtin re-registers the bundled copy
   *  (recorded by {@link registerBuiltin}) so the surface keeps working. */
  removeInstalledPlugin(id: string): void {
    this.destroy(id)
    this.descriptors.delete(id)
    const fallback = this.builtinFallbacks.get(id)
    if (fallback) this.registerDescriptor(fallback, { builtin: true })
  }

  /** Push an event to a plugin view (fed by the backend server-push fan-out
   *  in {@link dispatchEvent}). */
  emit(pluginId: string, type: string, data: unknown): void {
    const plugin = this.running.get(pluginId)
    if (plugin && !plugin.view.webContents.isDestroyed()) {
      plugin.view.webContents.send(IPC_EVENT, { type, data })
    }
  }
}

/** Process-wide singleton. */
export const frontendPluginManager = new FrontendPluginManager()

/**
 * The M1 no-op plugin descriptor. Its entry is built as a second renderer input
 * (see electron.vite.config.ts), so in dev it is served by the renderer dev
 * server and in packaged builds it sits next to the main renderer bundle.
 */
export function noopPluginDescriptor(): PluginLaunchDescriptor {
  const base = process.env['ELECTRON_RENDERER_URL'] ?? ''
  return {
    id: 'navide.noop',
    requires: [], // only the built-in `ping` capability is used
    devUrl: `${base}/plugins/noop/index.html`,
    entryFile: join(__dirname, '../renderer/plugins/noop/index.html'),
  }
}

/**
 * Convenience used by the dev-only menu entry: open the no-op plugin view in a
 * fixed rect at the top-left of the host window. Precise host-rect sync is left
 * for later — see the manual-verification notes in the M1 report.
 */
export function openNoopPluginView(hostWindow: BrowserWindow): void {
  frontendPluginManager.open(hostWindow, noopPluginDescriptor(), {
    x: 40,
    y: 60,
    width: 480,
    height: 360,
  })
}

/**
 * The M2 fs-probe plugin descriptor. Declares `requires: ['fs']` so its
 * brokered `fs.*` calls reach the backend WS and it receives `git.changed`.
 */
export function fsProbePluginDescriptor(): PluginLaunchDescriptor {
  const base = process.env['ELECTRON_RENDERER_URL'] ?? ''
  return {
    id: 'navide.fs_probe',
    requires: ['fs'],
    devUrl: `${base}/plugins/fs_probe/index.html`,
    entryFile: join(__dirname, '../renderer/plugins/fs_probe/index.html'),
  }
}

/** Dev-only helper mirroring {@link openNoopPluginView} for the fs probe. */
export function openFsProbePluginView(hostWindow: BrowserWindow): void {
  frontendPluginManager.open(hostWindow, fsProbePluginDescriptor(), {
    x: 40,
    y: 60,
    width: 520,
    height: 480,
  })
}

/** Id of the mini-IDE extension (the editor surface). The official example
 *  plugin: it ships bundled with the app and is registered at startup as a
 *  builtin (see {@link registerBundledMiniIde}); an officially-verified
 *  marketplace install overrides the bundled copy. */
export const MINI_IDE_PLUGIN_ID = 'navide.mini-ide'

/** Where {@link registerBundledMiniIde} looks for the bundled copy. */
export interface BundledMiniIdeSource {
  /** `app.isPackaged` — selects resourcesPath vs the local dev build. */
  isPackaged: boolean
  /** `process.resourcesPath` (packaged builds only). */
  resourcesPath: string
  /** Repo root holding `dist-plugins/` when unpackaged. Defaults to the
   *  built main bundle's `../..` (`out/main` → repo root). */
  devRoot?: string
}

/** Directory of the bundled mini-IDE copy: `resources/plugins/mini-ide` inside
 *  the app package (shipped via electron-builder `extraResources`), or the
 *  local `dist-plugins/mini-ide` build output when running unpackaged. */
export function bundledMiniIdeDir(source: BundledMiniIdeSource): string {
  return source.isPackaged
    ? join(source.resourcesPath, 'plugins', 'mini-ide')
    : join(source.devRoot ?? join(__dirname, '../..'), 'dist-plugins', 'mini-ide')
}

/**
 * Register the app-bundled mini-IDE as a builtin descriptor at startup.
 *
 * Precedence for the mini-IDE editor surface (resolved here, once):
 *   1. an officially-verified marketplace install under `userData/plugins`
 *      (scanned by `loadInstalledPlugins` BEFORE this call, gated by the
 *      fail-closed pinned-key receipt check) — the future update path always
 *      wins over the copy frozen into the app package;
 *   2. the bundled builtin copy ({@link bundledMiniIdeDir}: resourcesPath in
 *      packaged builds, `dist-plugins/mini-ide` when unpackaged), validated
 *      through the SAME manifest parsing as an installed plugin;
 *   3. nothing registered → `openMiniIdePluginView` returns false and callers
 *      fall back to the "Mini-IDE unavailable" dialog.
 * (`AGENT_TEAM_PLUGIN_DEV=1` additionally force-registers the dist-plugins
 * copy later in startup, overriding 1–2 for that run — unchanged semantics.)
 *
 * Never throws: a missing dir, invalid manifest, spoofed id, or missing entry
 * file returns `registered: false` with a reason (caller logs; dialog fallback
 * stays), so a corrupt bundle degrades instead of crashing startup.
 */
export function registerBundledMiniIde(
  manager: FrontendPluginManager,
  source: BundledMiniIdeSource
): { registered: boolean; reason?: string } {
  const dir = bundledMiniIdeDir(source)
  const scanned = loadPluginDir(dir)
  if (!scanned.descriptor) {
    return { registered: false, reason: `${dir}: ${scanned.error ?? 'invalid plugin dir'}` }
  }
  if (scanned.descriptor.id !== MINI_IDE_PLUGIN_ID) {
    return {
      registered: false,
      reason: `${dir}: manifest id '${scanned.descriptor.id}' is not '${MINI_IDE_PLUGIN_ID}'`,
    }
  }
  if (!existsSync(scanned.descriptor.entryFile)) {
    return { registered: false, reason: `${dir}: entry file missing (${scanned.descriptor.entryFile})` }
  }
  manager.registerBuiltin(scanned.descriptor)
  return { registered: true }
}

/** Build the entry query the mini-IDE reads from `window.location.search`:
 *  `workspacePath` plus the backend `httpUrl` (the capabilityBackend shim
 *  resolves backend HTTP URLs from it), `extraParams` forwarding editor
 *  open params (`filepath`/`line`/`sidebar`/`diff_*`/`branch_diff_*`)
 *  EditorWindowApp also reads from the search string, and the current `theme`
 *  id so the plugin paints with the app theme before its first settings
 *  reconcile (zero-flash; see plugins/mini-ide/mount.ts). A theme change alone
 *  never reloads a running view — open() only compares `workspace_path`. */
function miniIdeQuery(
  workspacePath: string,
  httpUrl: string,
  extraParams: Record<string, string>,
  theme: string
): string {
  const params = new URLSearchParams()
  if (workspacePath) params.set('workspace_path', workspacePath)
  if (httpUrl) params.set('http_url', httpUrl)
  for (const [key, value] of Object.entries(extraParams)) {
    if (value) params.set(key, value)
  }
  if (theme) params.set('theme', theme)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/** The dedicated mini-IDE host window (one at a time, recreated after close).
 *  The plugin WebContentsView fills its content bounds; the main window is
 *  never overlaid. */
let miniIdeWindow: BrowserWindow | null = null

/** Reuse the live dedicated window or create a fresh one. Window options
 *  mirror the retired legacy editor BrowserWindow (`openEditorWindow` in git
 *  history: 1100x760, hidden title bar, `Navide · Editor`, #0d1117). The
 *  window's own webContents stays blank — the plugin view carries the UI, so
 *  no preload/webPreferences are needed here. */
function ensureMiniIdeWindow(): BrowserWindow {
  if (miniIdeWindow && !miniIdeWindow.isDestroyed()) return miniIdeWindow
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Navide · Editor',
    titleBarStyle: 'hidden',
    backgroundColor: '#0d1117',
  })
  miniIdeWindow = win
  win.on('closed', () => {
    if (miniIdeWindow === win) miniIdeWindow = null
  })
  return win
}

/**
 * Dev-only mini-IDE descriptor pointing at the LOCAL build output
 * (`dist-plugins/mini-ide/`, produced by `pnpm run build:mini-ide`). Registered
 * at startup only under `AGENT_TEAM_PLUGIN_DEV=1` so development never needs a
 * registry install. The bundle is built separately (vite.mini-ide.config.ts)
 * with the `useBackend` → capabilityBackend alias, so it is not served by the
 * electron-vite dev server: `devUrl` is empty and it always loadFiles.
 */
export function devMiniIdePluginDescriptor(): PluginLaunchDescriptor {
  return {
    id: MINI_IDE_PLUGIN_ID,
    requires: ['fs', 'git', 'terminal', 'search', 'chat', 'ui', 'issues'],
    devUrl: '',
    // __dirname is out/main in dev, so ../../ is the repo root.
    entryFile: join(__dirname, '../../dist-plugins/mini-ide/index.html'),
  }
}

/**
 * Open the mini-IDE plugin view — the `window:openEditor` / `window:openDiff` /
 * branch-diff surface (see index.ts) and the dev menu. The view lives in its
 * own dedicated BrowserWindow (legacy editor parity): opening never touches or
 * covers the main window, reopening restores/focuses the live window and
 * delivers the target incrementally, and closing the window tears the view
 * down so the next open recreates both cleanly.
 * Looks the descriptor up in the loader registry; returns false when the
 * mini-IDE extension is not installed (the caller surfaces the install hint).
 */
export function openMiniIdePluginView(
  workspacePath: string,
  httpUrl = '',
  extraParams: Record<string, string> = {},
  theme = ''
): boolean {
  const base = frontendPluginManager.getDescriptor(MINI_IDE_PLUGIN_ID)
  if (!base) return false
  frontendPluginManager.open(
    ensureMiniIdeWindow(),
    { ...base, query: miniIdeQuery(workspacePath, httpUrl, extraParams, theme) },
    // Fill the dedicated window's content bounds and track its resizes.
    'fill',
    // Esc (nav.hideSelf) closes the dedicated window, like the legacy editor.
    { closeHostOnHide: true }
  )
  return true
}

/** Id of the Plans extension (the plan review surface). */
export const PLANS_PLUGIN_ID = 'navide.plans'

/** Build the entry query PlanWindowApp reads from `window.location.search`:
 *  `workspace_path`, the backend `http_url` (resolved by the plans
 *  capabilityBackend shim), and the optional `rel_path` of a plan to auto-open. */
function plansQuery(workspacePath: string, httpUrl: string, relPath: string): string {
  const params = new URLSearchParams()
  if (workspacePath) params.set('workspace_path', workspacePath)
  if (httpUrl) params.set('http_url', httpUrl)
  if (relPath) params.set('rel_path', relPath)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Dev-only Plans descriptor pointing at the LOCAL build output
 * (`dist-plugins/plans/`, produced by `pnpm run build:plans`). Registered at
 * startup only under `AGENT_TEAM_PLUGIN_DEV=1`, mirroring
 * {@link devMiniIdePluginDescriptor}. The bundle is built separately
 * (vite.plans.config.ts) with the `useBackend` → capabilityBackend alias, so it
 * is not served by the electron-vite dev server: `devUrl` is empty and it
 * always loadFiles. `plans` grants only the `plans.changed` live-refresh event.
 */
export function devPlansPluginDescriptor(): PluginLaunchDescriptor {
  return {
    id: PLANS_PLUGIN_ID,
    requires: ['fs', 'ui', 'plans'],
    devUrl: '',
    // __dirname is out/main in dev, so ../../ is the repo root.
    entryFile: join(__dirname, '../../dist-plugins/plans/index.html'),
  }
}

/**
 * Open the Plans plugin view for a workspace (dev menu / future plan-window
 * surface). Looks the descriptor up in the loader registry; returns false when
 * the Plans extension is not registered. The core `?window=plans` BrowserWindow
 * path (plan-windows.ts) is untouched — this is a parallel, opt-in surface.
 */
export function openPlansPluginView(
  hostWindow: BrowserWindow,
  workspacePath: string,
  httpUrl = '',
  relPath = ''
): boolean {
  const base = frontendPluginManager.getDescriptor(PLANS_PLUGIN_ID)
  if (!base) return false
  frontendPluginManager.open(
    hostWindow,
    { ...base, query: plansQuery(workspacePath, httpUrl, relPath) },
    {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    }
  )
  return true
}
