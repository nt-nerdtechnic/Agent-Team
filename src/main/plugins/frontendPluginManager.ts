// Frontend plugin runtime (main process).
//
// Runs a plugin's UI inside an isolated `WebContentsView` attached to a host
// BrowserWindow, with a minimal, dedicated preload (`plugin-preload.js`). The
// pure broker logic lives in `pluginCapabilityBroker.ts` (unit-tested,
// electron-free): it enforces manifest scoping, resolves `ping`/unknown calls
// in-process, and routes everything else to the backend plugin host over the
// shared WebSocket transport below.

import { BrowserWindow, WebContentsView, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { WebSocket as NodeWebSocket } from 'ws'
import {
  parseCapabilityCall,
  planCapabilityCall,
  backendResponseToCapability,
  isEventAllowed,
  isPublicCapabilityEventAllowed,
  buildError,
  buildSuccess,
  CASTABLE_WS_TYPES,
  createTerminalOutputBatcher,
  terminalSessionIdOf,
  terminalSessionsFromResponse,
  HOST_CAPABILITIES,
  HOST_EVENT_SOURCE_PLUGIN_ID,
  type CapabilityCall,
  type CapabilityResponse,
  type AuthenticatedRuntimeBinding,
  type HostCapabilityContext,
  type PublicCapabilityExecutionPlan,
  type TerminalOutputBatcher,
} from './pluginCapabilityBroker'
import {
  PluginStorageError,
  type StorageExecution,
  type StorageExecutionAddress,
} from './pluginStorage'
import { CAP_EVENTS } from './capabilityMap'
import { PUBLIC_CAPABILITY_EVENT_ADDRESSES } from './pluginCapabilityCatalog'
import {
  MINI_IDE_PLUGIN_REQUIRES,
  PLANS_PLUGIN_REQUIRES,
} from '../../shared/pluginCapabilities'
import {
  buildActivationCatalog,
  loadPluginDir,
  scanInstalledPlugins,
  verifyOfficialInstall,
  type InstalledPluginPackageSummary,
  type PluginActivationCatalogEntry,
} from './installedPlugins'
import { resolveOfficialPublisherKey } from './pluginVerify'
import {
  verifyInstalledRegistryPackage,
  type InstalledRegistryTrustContext,
} from './pluginInstalledTrust'
import { legacyCapabilityPolicy, type PluginCapabilityPolicy } from './pluginPermissions'
import {
  createWsClient,
  type WsClient,
  type WsClientStatus,
  type WsConstructor,
} from '../../shared/wsClient'
import { AI_CLI_PROFILES } from '../../shared/aiCliProfiles'
import { resolveWsType } from './capabilityMap'

/** Everything the manager needs to launch one plugin view. */
export interface PluginLaunchDescriptor {
  /** Manifest id, e.g. `navide.noop`. */
  id: string
  /** Canonical package version for Manifest v2 descriptors. Legacy descriptors
   *  omit this field because their loader identity is plugin-id keyed. */
  packageVersion?: string
  /** Capabilities the plugin's manifest declares (drives broker scoping). */
  requires: string[]
  /** Access-aware policy for Manifest v2; omitted descriptors retain V1 behavior. */
  capabilityPolicy?: PluginCapabilityPolicy
  /** Host-authenticated v2 grant/binding context; never serialized to a plugin. */
  capabilityContext?: HostCapabilityContext | null
  /** Dev-server URL for the plugin entry (used when running under electron-vite dev). */
  devUrl: string
  /** Absolute file path to the built plugin entry (packaged / built runs). */
  entryFile: string
  /** Optional `?a=b` query appended to the entry (e.g. the mini-IDE workspace
   *  path the app reads from `window.location.search`). Omitted → no query. */
  query?: string
  /** Manifest v2 contributions discovered for this package. Legacy descriptors
   *  omit this field and continue to use their single top-level entryFile.
   *  Issue 01 exposes validated metadata only; issue 14 owns runtime instances. */
  views?: PluginViewLaunchDescriptor[]
}

export interface PluginViewLaunchDescriptor {
  id: string
  contributionKey: string
  kind: 'custom'
  location: 'top' | 'bottom' | 'right' | 'left' | 'main' | 'window'
  title: string
  icon?: string
  entryFile: string
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

/** Host-owned handle for one live contribution view. The instance id is
 * opaque: plugins never choose it and lifecycle calls must use the handle
 * returned by {@link FrontendPluginManager.openView}. */
export interface PluginViewHandle {
  readonly instanceId: string
}

export interface PluginViewOpenOptions {
  hostWindow: BrowserWindow
  bounds: PluginViewBounds
  query?: string
  closeHostOnHide?: boolean
  mirrorTitle?: boolean
  /** Host-owned workspace path used only to resolve bound capabilities. */
  workspacePath?: string
  /** Host-authenticated context for this view instance. Renderer data never
   *  supplies or overrides this value. */
  capabilityContext?: HostCapabilityContext | null
}

interface RunningPlugin {
  instanceId: string
  id: string
  /** True when this instance was created through the plugin-id keyed {@link open} adapter. */
  openedViaLegacyAdapter: boolean
  /** Canonical Manifest v2 identity; this controls PTY semantics regardless of opener. */
  hasV2DescriptorIdentity: boolean
  requires: string[]
  capabilityPolicy: PluginCapabilityPolicy
  capabilityContext: HostCapabilityContext | null
  view: WebContentsView
  hostWindow: BrowserWindow
  /** Host-owned workspace path; never sourced from plugin payloads. */
  workspacePath: string | null
  /** Query string the entry was last loaded with (drives reload-on-change). */
  query: string
  /** webContents.id captured at creation (not readable after destroy). */
  senderId: number
  /** Whether the view overlays the host's full content area (see {@link PluginViewBounds}). */
  fill: boolean
  /** Removes the host `resize` listener; null when none is attached. */
  detachHostResize: (() => void) | null
  /** Removes the host `closed` listener; null after instance teardown. */
  detachHostClosed: (() => void) | null
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

interface GitContributionState {
  workspacePath: string
  analyzerModel: string
  dispatchTargets: Array<{ id: string; label: string }>
  availableAgents: Array<{ key: string; label: string }>
  issueHandoffs: Record<string, { paneId: string; mode: string; state: string }>
}

interface GitAccountHandlers {
  available(): boolean
  list(): Array<{ id: string; label: string; host: string; username: string; tokenLast4: string }>
  add(input: { label: string; host: string; username: string; token: string }): { id: string; label: string; host: string; username: string; tokenLast4: string }
  update(id: string, patch: Partial<{ label: string; host: string; username: string; token: string }>): void
  remove(id: string): void
  bind(workspacePath: string, accountId: string): void
  unbind(workspacePath: string): void
  getBinding(workspacePath: string): string | null
  getCredential(workspacePath: string): { username: string; token: string } | null
}

interface TerminalRoute {
  pluginId: string
  packageVersion: string | null
  workspaceId: string | null
  audience: string | null
  /** Null while a v2 view is detached and awaiting an authenticated takeover. */
  instanceId: string | null
  /** Legacy route mode is derived from descriptor identity, not the opener. */
  legacy: boolean
}

interface PendingTerminalOperation {
  operationId: string
  instanceId: string
  wsType: 'terminal.create' | 'terminal.reattach'
  client: WsClient
  paneId?: string
  createGeneration?: string
  route: TerminalRoute | null
  cancelled: boolean
  cancelSent: boolean
  cleanupSessionIds: Set<string>
}

interface PendingAiStart {
  pluginInstanceId: string
  paneId: string
  requestId: string
  client: WsClient
}

const IPC_CALL = 'plugin:cap:call'
const IPC_CAST = 'plugin:cap:cast'
const IPC_HOST_CALL = 'plugin:host:call'
const IPC_EVENT = 'plugin:cap:event'
const IPC_READY = 'plugin:ready'
const IPC_HIDE_SELF = 'plugin:hideSelf'
const IPC_OPEN_TARGET = 'plugin:openTarget'
const TERMINAL_OWNED_WS_TYPES = new Set([
  'terminal.input',
  'terminal.log_sent',
  'terminal.resize',
  'terminal.interrupt',
  'terminal.kill',
  'terminal.redraw',
])

/** First-party compatibility actions used while the existing Git surface is
 *  moved behind the Manifest v2 package boundary. These are deliberately
 *  narrower than a generic Host RPC: package identity, sender identity, and
 *  workspace binding are all checked before any action reaches the backend. */
const GIT_HOST_ACTIONS = new Set(['git.request', 'issues.request', 'fs.request'])
const GIT_PRIVATE_ACTIONS = new Set(['git.contribution', 'git.account'])
const GIT_CONTRIBUTION_OPERATIONS = new Set([
  'get_state',
  'open_path',
  'open_temp_file',
  'pick_workspace',
  'open_main_window',
  'open_branch_diff_window',
  'open_git_window',
  'open_git_history_window',
  'changes_count',
  'open_workspace',
  'open_file',
  'open_conflict',
  'open_diff',
  'open_branch_diff',
  'dispatch_issue',
  'spawn_for_issue',
  'focus_pane',
  'open_git_accounts',
])
const GIT_ACCOUNT_OPERATIONS = new Set([
  'list',
  'get_binding',
])
const GIT_REMOTE_REQUEST_TYPES = new Set([
  'git.clone',
  'git.sync',
  'git.fetch',
  'git.pull',
  'git.push',
  'git.push_upstream',
  'git.pull_rebase',
  'git.push_force',
])
const GIT_HOST_UI_ACTIONS = new Set([
  'ui.open_in_editor',
  'ui.open_external',
  'ui.reveal_path',
  'ui.open_workspace',
  'ui.pick_folder',
])
const GIT_HOST_FS_TYPES = new Set([
  'fs.read_file',
  'fs.write_file',
  'fs.list_dir',
  'fs.list_files_flat',
  'fs.glob_files',
  'fs.delete',
  'fs.rename',
  'fs.read_image',
  'fs.list_archive',
  'fs.convert_office',
  'fs.stat_path',
])
const PUBLIC_FS_WS_TYPES: Readonly<Record<string, string>> = {
  'fs.readFile': 'fs.read_file',
  'fs.writeFile': 'fs.write_file',
  'fs.readImage': 'fs.read_image',
  'fs.listDirectory': 'fs.list_dir',
  'fs.listFilesFlat': 'fs.list_files_flat',
  'fs.glob': 'fs.glob_files',
  'fs.statPath': 'fs.stat_path',
  'fs.stat': 'fs.stat_path',
}
/** `workspace_path` param of an entry query ('' when absent) — the view's
 *  identity in {@link FrontendPluginManager.open}. Deliberately blind to
 *  `file_ws` (the root of a file opened from outside the workspace): an
 *  external-file open keeps the same workspace and must add a tab in-page,
 *  never reload the view out from under its open buffers. */
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

/** The `navide.` publisher namespace is reserved for first-party packages;
 *  the internal Host event identity is never a plugin id. First-party ids may
 *  only be registered by the host itself or an install whose official-key
 *  verification passed. */
export function isReservedPluginId(id: string): boolean {
  return id === HOST_EVENT_SOURCE_PLUGIN_ID || id.startsWith('navide.')
}

function hasOfficialRegistryAuthority(trust: InstalledRegistryTrustContext): boolean {
  return (
    trust.registryAuthority === 'official' &&
    trust.officialRegistryUrl !== undefined &&
    trust.snapshot?.metadata.registryProfile === 'official' &&
    trust.pinnedRootKey !== null
  )
}

/**
 * Manages the lifecycle of frontend plugin views and brokers their capability
 * calls. Host-generated instances own plugin views across every host window.
 */
/** Coerce plugin-supplied args into a WS payload object; non-objects become an
 *  empty payload rather than corrupting the backend request. */
function toPayload(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { code?: unknown }).code === code
}

/** Resolve existing symlinks while preserving a non-existent trailing path. */
function resolvePathForContainment(path: string): string | null {
  let current = resolve(path)
  const missingSegments: string[] = []

  while (true) {
    try {
      lstatSync(current)
    } catch (error) {
      if (!isErrnoCode(error, 'ENOENT')) return null
      const parent = dirname(current)
      if (parent === current) return null
      missingSegments.unshift(basename(current))
      current = parent
      continue
    }

    try {
      return missingSegments.length > 0
        ? resolve(realpathSync(current), ...missingSegments)
        : realpathSync(current)
    } catch {
      // An existing symlink that cannot be resolved is not safe to fall back
      // to lexically: this includes dangling links and symlink loops.
      return null
    }
  }
}

function isWorkspaceContainedPath(workspacePath: string, candidatePath: string): boolean {
  const root = resolvePathForContainment(workspacePath)
  const candidate = root
    ? resolvePathForContainment(resolve(workspacePath, candidatePath))
    : null
  if (!root || !candidate) return false
  const relativePath = relative(root, candidate)
  return relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
}

function isStorageExecutionAddress(value: string): value is StorageExecutionAddress {
  return value === 'storage.get' || value === 'storage.set' || value === 'storage.delete'
}

function nonEmptyOrNull(value: string | null): boolean {
  return value === null || nonEmptyString(value)
}

function hasV2DescriptorIdentity(descriptor: PluginLaunchDescriptor): boolean {
  return descriptor.packageVersion !== undefined || descriptor.views !== undefined
}

function hasValidBindingFields(binding: AuthenticatedRuntimeBinding): boolean {
  return (
    nonEmptyString(binding.pluginId) &&
    nonEmptyString(binding.packageVersion) &&
    nonEmptyOrNull(binding.workspaceId) &&
    nonEmptyOrNull(binding.instanceId) &&
    nonEmptyOrNull(binding.audience)
  )
}

function sameRuntimeBinding(
  left: AuthenticatedRuntimeBinding | null | undefined,
  right: AuthenticatedRuntimeBinding | null | undefined
): boolean {
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.pluginId === right.pluginId &&
    left.packageVersion === right.packageVersion &&
    left.workspaceId === right.workspaceId &&
    left.instanceId === right.instanceId &&
    left.audience === right.audience
  )
}

function sameTerminalRoute(left: TerminalRoute | null, right: TerminalRoute | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.pluginId === right.pluginId &&
    left.packageVersion === right.packageVersion &&
    left.workspaceId === right.workspaceId &&
    left.audience === right.audience &&
    left.instanceId === right.instanceId &&
    left.legacy === right.legacy
  )
}

function validateV2CapabilityContext(
  descriptor: PluginLaunchDescriptor,
  context: HostCapabilityContext | null
): void {
  if (context === null || !hasV2DescriptorIdentity(descriptor)) return
  const packageVersion = descriptor.packageVersion
  if (!nonEmptyString(packageVersion) || descriptor.views === undefined) {
    throw new Error(`Manifest v2 plugin '${descriptor.id}' is missing canonical package identity`)
  }
  const binding = context.runtimeBinding
  if (
    !binding ||
    !hasValidBindingFields(binding) ||
    binding.pluginId !== descriptor.id ||
    binding.packageVersion !== packageVersion
  ) {
    throw new Error(`capability context identity does not match plugin '${descriptor.id}'`)
  }
  if (context.userGrant && context.userGrant.packageVersion !== packageVersion) {
    throw new Error(`capability context grant version does not match plugin '${descriptor.id}'`)
  }
  if (context.storageSnapshots) {
    for (const [tier, version] of context.storageSnapshots) {
      if (
        !['candidate', 'active', 'previous'].includes(tier) ||
        !nonEmptyString(version)
      ) {
        throw new Error(
          `capability context storage snapshot map is invalid for plugin '${descriptor.id}'`
        )
      }
    }
  }
  if (
    context.storageSnapshotTier !== undefined &&
    context.storageSnapshots?.get(context.storageSnapshotTier) !== packageVersion
  ) {
    throw new Error(
      `capability context selected storage tier does not match plugin '${descriptor.id}'`
    )
  }
  for (const [label, bindings] of [
    ['session', context.sessionBindings],
    ['pending start', context.pendingStartBindings],
  ] as const) {
    if (!bindings) continue
    for (const binding of bindings.values()) {
      if (
        !hasValidBindingFields(binding) ||
        binding.pluginId !== descriptor.id ||
        binding.packageVersion !== packageVersion
      ) {
        throw new Error(`${label} binding does not match plugin '${descriptor.id}'`)
      }
    }
  }
}

export class FrontendPluginManager {
  /** Host-generated instance id → running view. */
  private readonly running = new Map<string, RunningPlugin>()
  /** Host-generated workspace id → normalized workspace path. Paths are never
   *  exposed to the plugin; they only make storage and event routing stable
   *  across the left/window instances of one workspace. */
  private readonly workspaceIds = new Map<string, string>()
  /** Plugin id → instances opened through the legacy adapter; a v2 descriptor may still be here. */
  private readonly legacyInstances = new Map<string, string>()
  /** webContents.id → opaque instance id, so a call's origin can be trusted,
   *  not the payload. */
  private readonly bySender = new Map<number, string>()
  /** Installed/available plugin descriptors keyed by id (loader registry). The
   *  mini-IDE is registered here as the first built-in; third-party installs are
   *  added by {@link loadInstalledPlugins} / {@link registerDescriptor}. */
  private readonly descriptors = new Map<string, PluginLaunchDescriptor>()
  /** Validated packages installed under userData/plugins, including packages
   *  with no frontend descriptor. */
  private readonly installedPackages = new Map<string, InstalledPluginPackageSummary>()
  /** Host-bundled builtin descriptors kept as fallbacks: removing a marketplace
   *  override of a bundled plugin reverts to the bundled copy instead of
   *  leaving the surface unavailable (see {@link removeInstalledPlugin}). */
  private readonly builtinFallbacks = new Map<string, PluginLaunchDescriptor>()
  private ipcReady = false
  /** Backend WS url as last reported by main, or null when no backend is up. */
  private backendWsUrl: string | null = null
  /** Lazily-created shared transport to the backend plugin host. */
  private wsClient: WsClient | null = null
  /** Last transport status, replayed to late-loading plugin views so their
   *  useBackend shims start from real liveness instead of assuming it. */
  private wsStatus: WsClientStatus = 'disconnected'
  /** Host-owned executor seam for cataloged v2 plans. */
  private publicCapabilityHandler:
    | ((plan: PublicCapabilityExecutionPlan) => unknown | Promise<unknown>)
    | null = null
  /** Host-owned executor for the durable storage capability. Kept separate
   *  from the generic public handler so unimplemented public methods retain
   *  their existing unavailable behavior. */
  private publicStorageHandler:
    | ((execution: StorageExecution) => unknown | Promise<unknown>)
    | null = null
  /** Host-renderer state for the left Git contribution, keyed by its host
   *  BrowserWindow. It is never serialized into a public capability context. */
  private readonly gitContributionStates = new Map<number, GitContributionState>()
  /** Main-owned safeStorage adapter for the first-party Git account surface. */
  private gitAccountHandlers: GitAccountHandlers | null = null
  /** `terminal_session_id` → authenticated route ownership. v2 teardown
   *  clears the live instance id but retains the stable tuple as a tombstone;
   *  legacy routes retain their plugin-id adapter semantics. */
  private readonly terminalRoutes = new Map<string, TerminalRoute>()
  /** The owner captured when a pending output batch was queued. A flush must
   *  still match the current route, otherwise a delayed timer could deliver a
   *  detached view's bytes to a later instance. */
  private readonly pendingTerminalOwners = new Map<string, string>()
  /** Host-side subscription disposers grouped by exact view instance. */
  private readonly instanceSubscriptions = new Map<string, Set<() => void>>()
  /** Awaiting terminal create/reattach responses. Teardown invalidates these
   *  records before a late backend response can register a route. */
  private readonly pendingTerminalOperations = new Map<string, PendingTerminalOperation>()
  /** Host-owned public aiCli start transactions. The package only receives an
   *  opaque session id; pane ids and backend payloads stay in this map. */
  private readonly pendingAiStarts = new Map<string, PendingAiStart>()
  /** Per-session micro-batcher for terminal.output (see the broker module):
   *  coalesces the dense PTY stream into one IPC send per ~12 ms per session. */
  private readonly terminalOutputBatcher: TerminalOutputBatcher = createTerminalOutputBatcher(
    (sessionId, payload) => {
      const owner = this.pendingTerminalOwners.get(sessionId)
      this.pendingTerminalOwners.delete(sessionId)
      this.deliverTerminalEvent('terminal.output', sessionId, payload, owner)
    }
  )

  private resolveInstance(id: string): RunningPlugin | undefined {
    const direct = this.running.get(id)
    if (direct) return direct
    const legacyId = this.legacyInstances.get(id)
    return legacyId ? this.running.get(legacyId) : undefined
  }

  private instancesForPlugin(pluginId: string): RunningPlugin[] {
    return [...this.running.values()].filter((plugin) => plugin.id === pluginId)
  }

  private nextInstanceId(): string {
    let instanceId = randomUUID()
    while (this.running.has(instanceId)) instanceId = randomUUID()
    return instanceId
  }

  private workspaceIdForPath(workspacePath: string): string | null {
    if (!nonEmptyString(workspacePath)) return null
    const normalized = resolve(workspacePath)
    const existing = [...this.workspaceIds].find(([, path]) => path === normalized)?.[0]
    if (existing) return existing
    const id = randomUUID()
    this.workspaceIds.set(id, normalized)
    return id
  }

  /** Host-selected grant used only by the official bundled Git package. The
   *  package receives the resulting binding through openView; it cannot
   *  choose or widen any of these fields. */
  gitCapabilityContext(
    packageVersion: string,
    workspacePath: string,
    audience = 'git'
  ): HostCapabilityContext {
    const workspaceId = this.workspaceIdForPath(workspacePath)
    return {
      publisherEligible: true,
      userGrant: {
        packageVersion,
        system: ['fs', 'ui', 'aiCli'],
        shell: 'allowlist',
        storage: true,
      },
      runtimeBinding: {
        pluginId: GIT_PLUGIN_ID,
        packageVersion,
        workspaceId,
        instanceId: null,
        audience,
      },
      // These are Host-owned profile ids. The package supplies no command or
      // executable; the public aiCli adapter resolves the profile here before
      // the backend creates a PTY.
      aiCliProfiles: [
        'claude',
        'codex',
        'antigravity',
        'grok',
        'kimi',
        'opencode',
        'qwen',
        'kilo',
        'pi',
        'copilot',
        'cursor',
        'aider',
        'muse',
      ],
      storageSnapshots: new Map([
        ['candidate', packageVersion],
        ['active', packageVersion],
        ['previous', packageVersion],
      ]),
      storageSnapshotTier: 'active',
    }
  }

  /** Rebind only the Host-created runtime identity. V1 descriptors retain
   *  their existing context shape; v2 view instances receive their own id. */
  private bindCapabilityContext(
    context: HostCapabilityContext | null | undefined,
    instanceId: string
  ): HostCapabilityContext | null {
    const bind = (binding: AuthenticatedRuntimeBinding): AuthenticatedRuntimeBinding => ({
      ...binding,
      instanceId,
    })
    if (!context) return null
    return {
      ...context,
      runtimeBinding: context.runtimeBinding ? bind(context.runtimeBinding) : null,
      ...(context.storageSnapshots
        ? { storageSnapshots: new Map(context.storageSnapshots) }
        : {}),
      ...(context.sessionBindings
        ? {
            sessionBindings: new Map(
              [...context.sessionBindings].map(([sessionId, binding]) => [
                sessionId,
                bind(binding),
              ])
            ),
          }
        : {}),
      ...(context.pendingStartBindings
        ? {
            pendingStartBindings: new Map(
              [...context.pendingStartBindings].map(([requestId, binding]) => [
                requestId,
                bind(binding),
              ])
            ),
          }
        : {}),
    }
  }

  /** Apply a Host context to one live instance and preserve its PTY route only
   *  when the instance is still authenticated for the same v2 tuple. Legacy
   *  descriptors retain their plugin-id route semantics. */
  private updateInstanceCapabilityContext(
    plugin: RunningPlugin,
    context: HostCapabilityContext | null | undefined
  ): void {
    const nextContext =
      plugin.hasV2DescriptorIdentity || !plugin.openedViaLegacyAdapter
        ? this.bindCapabilityContext(context, plugin.instanceId)
        : context ?? null
    if (
      plugin.hasV2DescriptorIdentity &&
      plugin.capabilityContext?.storageSnapshotTier !== nextContext?.storageSnapshotTier
    ) {
      throw new Error('storage snapshot tier is fixed for a live plugin instance; recreate the instance')
    }
    const preserveTerminalOwnership =
      !plugin.hasV2DescriptorIdentity ||
      (sameRuntimeBinding(
        plugin.capabilityContext?.runtimeBinding,
        nextContext?.runtimeBinding
      ) && this.hasValidTerminalBinding({ ...plugin, capabilityContext: nextContext }))
    if (!preserveTerminalOwnership) this.releaseTerminalOwnership(plugin)
    plugin.capabilityContext = nextContext
  }

  private instanceForSender(senderId: number): RunningPlugin | undefined {
    const instanceId = this.bySender.get(senderId)
    return instanceId ? this.running.get(instanceId) : undefined
  }

  private payloadClaimsInstance(payload: unknown): boolean {
    // `pluginId` remains a tolerated legacy envelope field and is ignored by
    // parseCapabilityCall. `instanceId` is new Host-owned identity and must
    // never be supplied by a plugin, even when its value is undefined.
    return (
      typeof payload === 'object' &&
      payload !== null &&
      Object.prototype.hasOwnProperty.call(payload, 'instanceId')
    )
  }

  private workspaceBoundPayload(
    plugin: RunningPlugin,
    payload: unknown
  ): Record<string, unknown> | CapabilityResponse {
    if (!plugin.workspacePath) {
      return buildError('', 'WORKSPACE_SCOPE_VIOLATION', 'Git view is not bound to a workspace')
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return buildError('', 'BAD_REQUEST', 'Host action payload must be an object')
    }
    const record = payload as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(record, 'instanceId')) {
      return buildError('', 'BAD_REQUEST', 'instance identity is Host-owned')
    }
    if (Object.prototype.hasOwnProperty.call(record, 'credential')) {
      return buildError('', 'BAD_REQUEST', 'credentials are Host-owned')
    }
    if (
      record.workspace_path !== undefined &&
      (typeof record.workspace_path !== 'string' ||
        resolve(record.workspace_path) !== resolve(plugin.workspacePath))
    ) {
      return buildError('', 'WORKSPACE_SCOPE_VIOLATION', 'workspace path does not match the Host binding')
    }
    return { ...record, workspace_path: resolve(plugin.workspacePath) }
  }

  /** Store the trusted main-renderer state consumed by the independent Git
   *  left contribution. The renderer is the source of pane/issue state; the
   *  plugin can only read a workspace-matched snapshot through the bridge. */
  setGitContributionState(hostWindow: BrowserWindow, state: GitContributionState): void {
    if (hostWindow.isDestroyed() || !nonEmptyString(state.workspacePath)) return
    if (
      !nonEmptyString(state.analyzerModel) && state.analyzerModel !== '' ||
      !Array.isArray(state.dispatchTargets) ||
      !Array.isArray(state.availableAgents) ||
      typeof state.issueHandoffs !== 'object' ||
      state.issueHandoffs === null ||
      Array.isArray(state.issueHandoffs)
    ) return
    const normalized: GitContributionState = {
      workspacePath: resolve(state.workspacePath),
      analyzerModel: state.analyzerModel,
      dispatchTargets: state.dispatchTargets
        .filter((item) => nonEmptyString(item?.id) && typeof item.label === 'string')
        .map((item) => ({ id: item.id, label: item.label })),
      availableAgents: state.availableAgents
        .filter((item) => nonEmptyString(item?.key) && typeof item.label === 'string')
        .map((item) => ({ key: item.key, label: item.label })),
      issueHandoffs: state.issueHandoffs,
    }
    this.gitContributionStates.set(hostWindow.id, normalized)
    for (const plugin of this.running.values()) {
      if (
        plugin.id === GIT_PLUGIN_ID &&
        plugin.hostWindow === hostWindow &&
        plugin.workspacePath &&
        resolve(plugin.workspacePath) === normalized.workspacePath &&
        plugin.capabilityContext?.runtimeBinding?.audience === 'git-left'
      ) {
        this.emitToInstance(plugin.instanceId, 'git.contribution.state', normalized)
      }
    }
  }

  clearGitContributionState(hostWindow: BrowserWindow): void {
    this.gitContributionStates.delete(hostWindow.id)
  }

  setGitAccountHandlers(handlers: GitAccountHandlers | null): void {
    this.gitAccountHandlers = handlers
  }

  private validateContributionPayload(
    operation: string,
    payload: unknown,
  ): boolean {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
    const record = payload as Record<string, unknown>
    const stringField = (key: string): boolean => typeof record[key] === 'string' && String(record[key]).length > 0
    if (operation === 'open_path') return stringField('path')
    if (operation === 'open_temp_file') return stringField('name') && typeof record.content === 'string'
    if (operation === 'pick_workspace') return record.default_path === undefined || typeof record.default_path === 'string'
    if (operation === 'open_main_window') return stringField('workspace_path')
    if (operation === 'open_branch_diff_window') return stringField('workspace_path') && stringField('base')
    if (operation === 'open_git_history_window') return stringField('workspace_path')
    if (operation === 'open_git_window') {
      return stringField('workspace_path') &&
        (record.filepath === undefined || typeof record.filepath === 'string') &&
        (record.staged === undefined || typeof record.staged === 'boolean') &&
        (record.commit === undefined || typeof record.commit === 'string') &&
        (record.base === undefined || typeof record.base === 'string') &&
        (record.compare === undefined || typeof record.compare === 'string')
    }
    if (operation === 'open_workspace') return stringField('path')
    if (operation === 'focus_pane') return stringField('paneId')
    if (operation === 'open_file' || operation === 'open_conflict') {
      return stringField('workspace_path') && stringField('filepath') && stringField('name')
    }
    if (operation === 'open_diff') {
      return stringField('workspace_path') && stringField('filepath') && stringField('name') && typeof record.staged === 'boolean'
    }
    if (operation === 'open_branch_diff') {
      return stringField('workspace_path') && stringField('base') && typeof record.compare === 'string'
    }
    if (operation === 'dispatch_issue') return stringField('paneId') && typeof record.issue === 'object' && record.issue !== null
    if (operation === 'spawn_for_issue') {
      return stringField('agentKey') && stringField('mode') &&
        typeof record.issue === 'object' && record.issue !== null &&
        typeof record.provider === 'string'
    }
    if (operation === 'changes_count') return typeof record.count === 'number' && Number.isInteger(record.count) && record.count >= 0
    return operation === 'open_git_accounts'
  }

  private async runGitContributionAction(
    reqId: string,
    args: Record<string, unknown>,
    plugin: RunningPlugin,
  ): Promise<CapabilityResponse> {
    const operation = typeof args.operation === 'string' ? args.operation : ''
    if (!GIT_CONTRIBUTION_OPERATIONS.has(operation)) {
      return buildError(reqId, 'METHOD_NOT_FOUND', 'Git contribution action is not mapped')
    }
    if (operation === 'get_state') {
      const state = this.gitContributionStates.get(plugin.hostWindow.id)
      if (!state || !plugin.workspacePath || state.workspacePath !== resolve(plugin.workspacePath)) {
        return buildSuccess(reqId, null)
      }
      return buildSuccess(reqId, state)
    }
    if (!this.validateContributionPayload(operation, args.payload)) {
      return buildError(reqId, 'BAD_REQUEST', 'Git contribution payload is invalid')
    }
    if (plugin.capabilityContext?.runtimeBinding?.audience !== 'git-left') {
      return buildError(reqId, 'CAPABILITY_DENIED', 'Git contribution is only available to the left view')
    }
    const payload = args.payload as Record<string, unknown>
    const workspaceField = typeof payload.workspace_path === 'string'
      ? payload.workspace_path
      : operation === 'open_workspace' && typeof payload.path === 'string'
        ? payload.path
        : null
    // `open_workspace` is the one existing Git action whose target is chosen
    // through the Host-owned folder picker and may intentionally leave the
    // current workspace. All repository/file actions remain bound below.
    if (workspaceField !== null && operation !== 'open_workspace') {
      if (!plugin.workspacePath) return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Git view is not workspace-bound')
      if (!isWorkspaceContainedPath(plugin.workspacePath, workspaceField)) {
        return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Git contribution path is outside the Host binding')
      }
    }
    if (['open_file', 'open_conflict', 'open_diff', 'open_git_window'].includes(operation) &&
      typeof payload.filepath === 'string') {
      const fileWorkspace = workspaceField ?? plugin.workspacePath
      if (!fileWorkspace || !isWorkspaceContainedPath(fileWorkspace, payload.filepath)) {
        return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Git contribution file is outside the Host binding')
      }
    }
    if (operation === 'open_path') {
      if (!plugin.workspacePath || !isAbsolute(String(payload.path)) ||
        !isWorkspaceContainedPath(plugin.workspacePath, String(payload.path))) {
        return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Git path must be absolute inside the Host binding')
      }
    }
    if (operation === 'pick_workspace') {
      if (!this.hostShellHandlers) return buildError(reqId, 'BACKEND_ERROR', 'host shell handlers not registered')
      const picked = await this.hostShellHandlers.pickFolder(
        typeof payload.default_path === 'string' ? payload.default_path : undefined,
      )
      return buildSuccess(reqId, { path: picked })
    }
    if (plugin.hostWindow.isDestroyed()) return buildError(reqId, 'CAPABILITY_DENIED', 'Git host window is closed')
    plugin.hostWindow.webContents.send('git:contribution-action', { operation, payload })
    return buildSuccess(reqId, { accepted: true })
  }

  private async runGitAccountAction(
    reqId: string,
    args: Record<string, unknown>,
    plugin: RunningPlugin,
  ): Promise<CapabilityResponse> {
    const operation = typeof args.operation === 'string' ? args.operation : ''
    const handlers = this.gitAccountHandlers
    if (!handlers || !GIT_ACCOUNT_OPERATIONS.has(operation)) {
      return buildError(reqId, 'CAPABILITY_DENIED', 'Git account service is unavailable')
    }
    const rawPayload = args.payload
    const payload = typeof rawPayload === 'object' && rawPayload !== null && !Array.isArray(rawPayload)
      ? rawPayload as Record<string, unknown>
      : {}
    const workspace = (key = 'workspace_path'): string | null => {
      const value = payload[key]
      if (typeof value !== 'string' || !value) return null
      if (!plugin.workspacePath || resolve(value) !== resolve(plugin.workspacePath)) return null
      return resolve(plugin.workspacePath)
    }
    try {
      if (operation === 'list') {
        const accounts = handlers.list().map(({ id, label, host, username }) => ({ id, label, host, username }))
        return buildSuccess(reqId, { available: handlers.available(), accounts })
      }
      const ws = workspace()
      if (!ws) return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'workspace path does not match the Host binding')
      return buildSuccess(reqId, { accountId: handlers.getBinding(ws) })
    } catch (error) {
      return buildError(reqId, 'BACKEND_ERROR', error instanceof Error ? error.message : 'Git account operation failed')
    }
  }

  /** Execute the fixed first-party bridge used by the production Git package.
   *  This is intentionally separate from the public Manifest v2 catalog: Git
   *  and Issues are Host-owned product services, not public permission
   *  namespaces. */
  private async runGitHostAction(
    reqId: string,
    action: string,
    args: Record<string, unknown>,
    plugin: RunningPlugin
  ): Promise<CapabilityResponse> {
    const binding = plugin.capabilityContext?.runtimeBinding
    const grant = plugin.capabilityContext?.userGrant
    const policy = plugin.capabilityPolicy
    const baseDenied =
      !plugin.hasV2DescriptorIdentity ||
      plugin.id !== GIT_PLUGIN_ID ||
      policy?.kind !== 'manifest-v2' ||
      !binding ||
      !grant ||
      grant.packageVersion !== binding.packageVersion ||
      binding.pluginId !== plugin.id ||
      binding.instanceId !== plugin.instanceId ||
      (plugin.workspacePath !== null &&
        binding.workspaceId !== this.workspaceIdForPath(plugin.workspacePath))
    if (baseDenied) {
      return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
    }
    if (!grant || policy?.kind !== 'manifest-v2') {
      return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
    }

    const hasSystemGrant = (namespace: 'fs' | 'ui'): boolean =>
      policy.system.includes(namespace) && grant.system.includes(namespace)
    const hasAllowlistShellGrant = (): boolean =>
      policy.shell === 'allowlist' && grant.shell === 'allowlist'

    if (GIT_PRIVATE_ACTIONS.has(action)) {
      if (!plugin.capabilityContext?.publisherEligible || !hasSystemGrant('ui')) {
        return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
      }
      if (action === 'git.contribution') return this.runGitContributionAction(reqId, args, plugin)
      return this.runGitAccountAction(reqId, args, plugin)
    }

    if (GIT_HOST_ACTIONS.has(action)) {
      if (!hasSystemGrant('fs')) {
        return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
      }
      if ((action === 'git.request' || action === 'issues.request') &&
        (!plugin.capabilityContext?.publisherEligible || !hasAllowlistShellGrant())) {
        return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
      }
      const type = typeof args.type === 'string' ? args.type : ''
      const rawPayload = args.payload
      const mapped =
        action === 'git.request'
          ? type.startsWith('git.') && resolveWsType('git', type.slice('git.'.length)) === type
          : action === 'issues.request'
            ? type.startsWith('issues.') && resolveWsType('issues', type.slice('issues.'.length)) === type
            : type.startsWith('fs.') && GIT_HOST_FS_TYPES.has(type)
      if (!mapped) return buildError(reqId, 'METHOD_NOT_FOUND', 'Git Host action is not mapped')
      const payload = this.workspaceBoundPayload(plugin, rawPayload)
      if ('ok' in payload && typeof payload.ok === 'boolean' && 'reqId' in payload) {
        return { ...payload, reqId } as CapabilityResponse
      }
      const wsPayload = payload as Record<string, unknown>
      if (action === 'git.request' && GIT_REMOTE_REQUEST_TYPES.has(type)) {
        const workspacePath = plugin.workspacePath
        if (!workspacePath || !this.gitAccountHandlers) {
          return buildError(reqId, 'BACKEND_ERROR', 'Git account service is unavailable')
        }
        let credential: { username: string; token: string } | null
        try {
          credential = this.gitAccountHandlers.getCredential(resolve(workspacePath))
        } catch (error) {
          return buildError(
            reqId,
            'BACKEND_ERROR',
            error instanceof Error ? error.message : 'Git credential lookup failed'
          )
        }
        if (!credential) {
          return buildError(reqId, 'CREDENTIAL_REQUIRED', 'No workspace-bound Git credential is available')
        }
        wsPayload.credential = credential
      }
      const client = this.ensureBackend()
      if (!client) return buildError(reqId, 'BACKEND_ERROR', 'backend not connected')
      try {
        return backendResponseToCapability(reqId, await client.send(type, wsPayload))
      } catch (error) {
        return buildError(
          reqId,
          'BACKEND_ERROR',
          error instanceof Error ? error.message : 'backend request failed'
        )
      }
    }

    if (action === 'ui.request') {
      if (!plugin.capabilityContext?.publisherEligible || !hasSystemGrant('ui')) {
        return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
      }
      const type = typeof args.type === 'string' ? args.type : ''
      if (!GIT_HOST_UI_ACTIONS.has(type)) {
        return buildError(reqId, 'METHOD_NOT_FOUND', 'Git UI Host action is not mapped')
      }
      const rawPayload = args.payload
      if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
        return buildError(reqId, 'BAD_REQUEST', 'Git UI payload must be an object')
      }
      if (Object.prototype.hasOwnProperty.call(rawPayload, 'instanceId')) {
        return buildError(reqId, 'BAD_REQUEST', 'instance identity is Host-owned')
      }
      const call: CapabilityCall = {
        pluginId: plugin.id,
        ns: 'ui',
        method: type.slice('ui.'.length),
        args: rawPayload,
        reqId,
      }
      return this.runHostAction(call, plugin)
    }

    return buildError(reqId, 'METHOD_NOT_FOUND', 'Git Host action is not mapped')
  }

  private async handleHostCall(senderId: number, payload: unknown): Promise<CapabilityResponse> {
    const plugin = this.instanceForSender(senderId)
    if (!plugin) return buildError('', 'BAD_REQUEST', 'unknown plugin sender')
    if (this.payloadClaimsInstance(payload)) {
      return buildError('', 'BAD_REQUEST', 'instance identity is Host-owned')
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return buildError('', 'BAD_REQUEST', 'malformed Host action call')
    }
    const record = payload as Record<string, unknown>
    const reqId = typeof record.reqId === 'string' ? record.reqId : ''
    const action = typeof record.action === 'string' ? record.action : ''
    const args = record.args
    if (!reqId || !action || typeof args !== 'object' || args === null || Array.isArray(args)) {
      return buildError(reqId, 'BAD_REQUEST', 'malformed Host action call')
    }
    return this.runGitHostAction(reqId, action, args as Record<string, unknown>, plugin)
  }

  /** Register the broker IPC handlers exactly once. Safe to call repeatedly. */
  registerIpc(): void {
    if (this.ipcReady) return
    this.ipcReady = true

    ipcMain.handle(IPC_CALL, async (event, payload: unknown): Promise<CapabilityResponse> => {
      const plugin = this.instanceForSender(event.sender.id)
      if (!plugin) {
        // Not a known plugin view — refuse without leaking anything.
        return buildError('', 'BAD_REQUEST', 'unknown plugin sender')
      }
      const pluginId = plugin.id
      const reqId =
        typeof payload === 'object' && payload && 'reqId' in payload
          ? String((payload as Record<string, unknown>).reqId ?? '')
          : ''
      if (this.payloadClaimsInstance(payload)) {
        return buildError(reqId, 'BAD_REQUEST', 'instance identity is Host-owned')
      }
      const call = parseCapabilityCall(payload, pluginId)
      if (!call) {
        return buildError(reqId, 'BAD_REQUEST', 'malformed capability call')
      }

      // Enforce scoping + route. A denied namespace is rejected here and never
      // reaches the backend; `ping`/unknown resolve in-process.
      let plan: ReturnType<typeof planCapabilityCall>
      try {
        plan = planCapabilityCall(
          call,
          plugin.capabilityPolicy,
          plugin.capabilityContext ?? undefined
        )
      } catch {
        return buildError(call.reqId, 'INVALID_ARGUMENT', 'invalid capability request')
      }
      if (plan.kind === 'respond') return plan.response

      if (plan.kind === 'public') {
        if (plan.storage) {
          const handler = this.publicStorageHandler
          if (!handler || !isStorageExecutionAddress(plan.address)) {
            return buildError(
              call.reqId,
              'BACKEND_UNAVAILABLE',
              'storage capability broker is not connected'
            )
          }
          try {
            const result = await handler({
              address: plan.address,
              args: plan.args,
              partition: plan.storage.partition,
              snapshot: plan.storage.snapshot,
            })
            const storageKey = typeof call.args === 'object' && call.args !== null
              ? (call.args as Record<string, unknown>).key
              : null
            const storageScope = typeof call.args === 'object' && call.args !== null
              ? (call.args as Record<string, unknown>).scope
              : null
            if (
              plugin.id === GIT_PLUGIN_ID &&
              storageScope === 'plugin' &&
              typeof storageKey === 'string'
            ) {
              this.dispatchEvent('ui.settings_changed', {
                settings: { [storageKey]: plan.address === 'storage.delete' ? null : (call.args as Record<string, unknown>).value },
              })
            }
            return buildSuccess(
              call.reqId,
              result
            )
          } catch (error) {
            if (error instanceof PluginStorageError) {
              const code =
                error.code === 'STORAGE_QUOTA_EXCEEDED' || error.code === 'INVALID_ARGUMENT'
                  ? error.code
                  : 'INTERNAL_ERROR'
              return buildError(call.reqId, code, error.message)
            }
            return buildError(call.reqId, 'INTERNAL_ERROR', 'storage capability failed')
          }
        }
        const handler = this.publicCapabilityHandler
        if (!handler) {
          return buildError(
            call.reqId,
            'BACKEND_UNAVAILABLE',
            'public capability broker is not connected'
          )
        }
        try {
          return buildSuccess(call.reqId, await handler(plan))
        } catch {
          return buildError(call.reqId, 'INTERNAL_ERROR', 'public capability failed')
        }
      }

      // Host-implemented capability (ui.open_in_editor): main services it
      // directly — no backend round-trip.
      if (plan.kind === 'host') {
        return this.runHostAction(call, plugin)
      }

      let wsPayload =
        plan.wsType === 'terminal.reattach'
          ? this.filterTerminalReattachPayload(plugin.instanceId, toPayload(call.args))
          : toPayload(call.args)
      if (plan.wsType === 'terminal.create') {
        const generation = nonEmptyString(wsPayload.create_generation)
          ? wsPayload.create_generation
          : randomUUID()
        wsPayload = { ...wsPayload, create_generation: generation }
      }
      if (
        this.requiresTerminalOwnership(plan.wsType) &&
        !this.ownsTerminalSession(plugin, wsPayload)
      ) {
        return buildError(
          call.reqId,
          'CAPABILITY_DENIED',
          'terminal session is not owned by this view'
        )
      }
      const client = this.ensureBackend()
      if (!client) {
        return buildError(call.reqId, 'BACKEND_ERROR', 'backend not connected')
      }
      const pendingOperation = this.beginTerminalOperation(plugin, plan.wsType, client, wsPayload)
      try {
        // A reattach request may not claim PTY sessions bound to a DIFFERENT
        // plugin — strip those ids before the backend re-targets their output.
        const resp = await client.send(plan.wsType, wsPayload)
        // A successful terminal.create/reattach binds the PTY to this plugin so
        // its output/exit events are routed to this view only.
        const canCommit = resp.ok && this.canCommitTerminalOperation(pendingOperation)
        if (canCommit) {
          this.noteTerminalRoutes(plugin.instanceId, plan.wsType, resp.payload)
        } else if (resp.ok && pendingOperation?.wsType === 'terminal.create') {
          // The backend sends the create response immediately before marking
          // its transaction committed. If teardown won that race, clean up
          // only the PTY named by this operation's correlated response.
          this.cleanupCancelledTerminalCreate(pendingOperation, resp.payload)
        }
        return backendResponseToCapability(call.reqId, resp)
      } catch (err) {
        return buildError(
          call.reqId,
          'BACKEND_ERROR',
          err instanceof Error ? err.message : 'backend request failed'
        )
      } finally {
        if (pendingOperation) this.pendingTerminalOperations.delete(pendingOperation.operationId)
      }
    })

    // Fixed first-party Git bridge. This does not expose a public `git` or
    // `issues` permission; sender and workspace binding are resolved by the
    // Host before the request reaches the backend.
    ipcMain.handle(IPC_HOST_CALL, async (event, payload: unknown): Promise<CapabilityResponse> =>
      this.handleHostCall(event.sender.id, payload)
    )

    // Fire-and-forget capability channel (nav.castCapability) — see handleCast.
    ipcMain.on(IPC_CAST, (event, payload: unknown) => {
      this.handleCast(event.sender.id, payload)
    })

    // Plugins announce readiness; it is only logged (activation is not gated on it).
    ipcMain.on(IPC_READY, (event) => {
      const plugin = this.instanceForSender(event.sender.id)
      if (plugin) console.log(`[plugin] ${plugin.id} ready`)
    })

    // A plugin dismisses its own view (e.g. the mini-IDE's Esc-close). Scoped
    // to the sender: only the view a webContents belongs to can be hidden by it.
    // A view hosted in a dedicated plugin window closes that window instead
    // (legacy editor Esc behavior; the `closed` hook runs the normal teardown);
    // main-window-hosted views keep the plain view-hide.
    ipcMain.on(IPC_HIDE_SELF, (event) => {
      const plugin = this.instanceForSender(event.sender.id)
      if (!plugin) return
      if (plugin?.closeHostOnHide && !plugin.hostWindow.isDestroyed()) {
        plugin.hostWindow.close()
      } else {
        this.deactivate(plugin.instanceId)
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
      // reset()/markErrored() deliberately emit no status transition, so tell
      // the plugins ourselves — their views outlive a backend stop/restart.
      this.dispatchBackendStatus('disconnected')
    }
  }

  /** Main-registered handler for the `ui.open_in_editor` host capability
   *  (index.ts wires it to the default-editor router, which sends the file to
   *  the mini-IDE, the OS default app, or the user's external editor). */
  private openInEditorHandler:
    | ((params: Record<string, string>) => boolean | Promise<boolean>)
    | null = null

  setOpenInEditorHandler(fn: (params: Record<string, string>) => boolean | Promise<boolean>): void {
    this.openInEditorHandler = fn
  }

  /** Install the Host-owned execution adapter for an already-authorized v2
   * plan. The adapter receives no raw shell, PTY, executable, or transport
   * handle from the Plugin. */
  setPublicCapabilityHandler(
    fn: ((plan: PublicCapabilityExecutionPlan) => unknown | Promise<unknown>) | null
  ): void {
    this.publicCapabilityHandler = fn
  }

  /** Execute a cataloged public plan for the Host. The plan is already
   *  authorized by the broker; this method still resolves the exact live
   *  instance so a stale plan cannot borrow a sibling workspace or PTY. */
  async executePublicCapability(plan: PublicCapabilityExecutionPlan): Promise<unknown> {
    const instanceId = plan.runtime.instanceId
    const plugin = instanceId ? this.running.get(instanceId) : undefined
    if (!plugin || plugin.id !== plan.runtime.pluginId) {
      throw new Error('public capability instance is no longer active')
    }
    if (!sameRuntimeBinding(plugin.capabilityContext?.runtimeBinding, plan.runtime)) {
      throw new Error('public capability runtime binding is stale')
    }
    const workspacePath = plugin.workspacePath
    if (plan.scope === 'workspace' && !workspacePath) {
      throw new Error('public capability workspace binding is missing')
    }

    if (plan.address.startsWith('aiCli.')) {
      return this.executeAiCliCapability(plan, plugin, workspacePath ?? '')
    }

    if (plan.address.startsWith('fs.')) {
      const wsType = PUBLIC_FS_WS_TYPES[plan.address]
      if (!wsType) throw new Error(`unsupported public filesystem capability '${plan.address}'`)
      if (!workspacePath) throw new Error('filesystem capability workspace binding is missing')
      const args = plan.args
      const path = typeof args.path === 'string' ? args.path : ''
      const payload: Record<string, unknown> = { workspace_path: workspacePath }
      if (wsType === 'fs.list_dir') payload.rel_path = path
      else if (wsType === 'fs.list_files_flat') {
        payload.query = typeof args.query === 'string' ? args.query : ''
        payload.max_results = typeof args.maxResults === 'number' ? args.maxResults : 100
      } else if (wsType === 'fs.glob_files') payload.pattern = args.pattern
      else if (wsType === 'fs.stat_path') payload.path = path
      else payload.rel_path = path
      if (wsType === 'fs.stat_path') {
        const root = resolve(workspacePath)
        const statPath = resolve(isAbsolute(path) ? path : join(root, path))
        const statRelative = relative(root, statPath)
        if (
          statRelative === '..' ||
          statRelative.startsWith(`..${sep}`) ||
          isAbsolute(statRelative)
        ) {
          throw new Error('filesystem path escapes the workspace')
        }
        payload.path = statPath
      }
      if (wsType === 'fs.write_file') payload.content = args.content
      const response = await this.sendPublicBackend(wsType, payload)
      return response
    }

    if (plan.address === 'ui.openInEditor') {
      if (!workspacePath) throw new Error('editor capability requires a workspace')
      const path = typeof plan.args.path === 'string' ? plan.args.path : ''
      const root = resolve(workspacePath)
      const relativePath = relative(root, resolve(root, path))
      if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error('editor path escapes the workspace')
      }
      if (!this.openInEditorHandler) throw new Error('editor open handler not registered')
      const opened = await this.openInEditorHandler({
        workspace_path: root,
        filepath: relativePath,
        ...(typeof plan.args.line === 'number' ? { line: String(plan.args.line) } : {}),
        ...(typeof plan.args.column === 'number' ? { column: String(plan.args.column) } : {}),
      })
      return { opened }
    }

    if (plan.address === 'ui.openExternal') {
      const url = typeof plan.args.url === 'string' ? plan.args.url : ''
      if (!this.hostShellHandlers) throw new Error('host shell handlers not registered')
      const result = await this.hostShellHandlers.openExternal(url)
      if (!result.ok) throw new Error(result.error ?? 'open external failed')
      return { opened: true }
    }

    if (plan.address === 'shell.run') {
      const command = typeof plan.args.command === 'string' ? plan.args.command : ''
      const response = await this.sendPublicBackend('shell.run', {
        workspace_path: workspacePath,
        command,
        host_mode: 'allowlist',
      })
      return {
        exitCode: Number((response as Record<string, unknown>).exit_code ?? 0),
        stdout: String((response as Record<string, unknown>).stdout ?? (response as Record<string, unknown>).output ?? ''),
        stderr: String((response as Record<string, unknown>).stderr ?? ''),
      }
    }

    throw new Error(`unsupported public capability '${plan.address}'`)
  }

  private async sendPublicBackend(
    wsType: string,
    payload: Record<string, unknown>
  ): Promise<unknown> {
    const client = this.ensureBackend()
    if (!client) throw new Error('backend not connected')
    const response = await client.send(wsType, payload)
    if (!response.ok) throw new Error(response.error?.message ?? 'backend request failed')
    return response.payload
  }

  private setAiBindings(
    plugin: RunningPlugin,
    sessionBindings: ReadonlyMap<string, AuthenticatedRuntimeBinding>,
    pendingStartBindings: ReadonlyMap<string, AuthenticatedRuntimeBinding>
  ): void {
    if (!plugin.capabilityContext) return
    plugin.capabilityContext = {
      ...plugin.capabilityContext,
      sessionBindings: new Map(sessionBindings),
      pendingStartBindings: new Map(pendingStartBindings),
    }
  }

  private removeAiSession(plugin: RunningPlugin, sessionId: string): void {
    const sessions = new Map(plugin.capabilityContext?.sessionBindings ?? [])
    sessions.delete(sessionId)
    this.setAiBindings(plugin, sessions, plugin.capabilityContext?.pendingStartBindings ?? new Map())
  }

  private async executeAiCliCapability(
    plan: PublicCapabilityExecutionPlan,
    plugin: RunningPlugin,
    workspacePath: string
  ): Promise<unknown> {
    const client = this.ensureBackend()
    if (!client) throw new Error('backend not connected')
    const args = plan.args
    if (plan.address === 'aiCli.startSession') {
      const profileId = String(args.profileId)
      const requestId = nonEmptyString(args.requestId) ? args.requestId : randomUUID()
      const paneId = `navide-git-${plugin.instanceId}-${requestId}`
      const pending = new Map(plugin.capabilityContext?.pendingStartBindings ?? [])
      const binding = plugin.capabilityContext?.runtimeBinding
      if (!binding) throw new Error('AI CLI runtime binding is missing')
      pending.set(requestId, binding)
      this.setAiBindings(plugin, plugin.capabilityContext?.sessionBindings ?? new Map(), pending)
      this.pendingAiStarts.set(`${plugin.instanceId}:${requestId}`, {
        pluginInstanceId: plugin.instanceId,
        paneId,
        requestId,
        client,
      })
      const command = this.aiCliCommand(profileId, args, workspacePath)
      if (!command) throw new Error(`AI CLI profile '${profileId}' is not available`)
      try {
        const response = await client.send('terminal.create', {
          pane_id: paneId,
          create_generation: requestId,
          agent_key: profileId,
          // The Host chooses the executable from the allowlisted profile. The
          // package never supplies a command, shell, cwd, or environment.
          command,
          cwd: workspacePath,
          cols: args.cols,
          rows: args.rows,
          metadata: { workspace_path: workspacePath, origin: 'navide-git' },
        })
        if (!response.ok) throw new Error(response.error?.message ?? 'AI CLI start failed')
        const result = toPayload(response.payload)
        const sessionId = typeof result.terminal_session_id === 'string' ? result.terminal_session_id : ''
        if (!sessionId) throw new Error('AI CLI start returned no session id')
        this.noteTerminalRoutes(plugin.instanceId, 'terminal.create', result)
        const sessions = new Map(plugin.capabilityContext?.sessionBindings ?? [])
        sessions.set(sessionId, binding)
        this.setAiBindings(plugin, sessions, plugin.capabilityContext?.pendingStartBindings ?? new Map())
        return { sessionId }
      } finally {
        const nextPending = new Map(plugin.capabilityContext?.pendingStartBindings ?? [])
        nextPending.delete(requestId)
        this.setAiBindings(plugin, plugin.capabilityContext?.sessionBindings ?? new Map(), nextPending)
        this.pendingAiStarts.delete(`${plugin.instanceId}:${requestId}`)
      }
    }

    if (plan.address === 'aiCli.cancelStart') {
      const requestId = String(args.requestId)
      const pending = this.pendingAiStarts.get(`${plugin.instanceId}:${requestId}`)
      if (!pending) throw new Error('AI CLI start request is no longer pending')
      const response = await pending.client.send('terminal.create.cancel', {
        pane_id: pending.paneId,
        create_generation: pending.requestId,
      })
      if (!response.ok) throw new Error(response.error?.message ?? 'AI CLI cancel failed')
      const pendingBindings = new Map(plugin.capabilityContext?.pendingStartBindings ?? [])
      pendingBindings.delete(requestId)
      this.setAiBindings(plugin, plugin.capabilityContext?.sessionBindings ?? new Map(), pendingBindings)
      this.pendingAiStarts.delete(`${plugin.instanceId}:${requestId}`)
      return {}
    }
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
    if (!sessionId) throw new Error('AI CLI session id is required')
    if (plan.address === 'aiCli.reattachSession') {
      const response = await client.send('terminal.reattach', {
        terminal_session_ids: [sessionId],
        cols: Number(args.cols),
        rows: Number(args.rows),
      })
      if (!response.ok) throw new Error(response.error?.message ?? 'AI CLI reattach failed')
      const alive = toPayload(response.payload).alive
      if (!Array.isArray(alive) || !alive.includes(sessionId)) {
        throw new Error('AI CLI session is no longer alive')
      }
      this.noteTerminalRoutes(plugin.instanceId, 'terminal.reattach', response.payload)
      return { sessionId }
    }
    const wsType: Record<string, string> = {
      'aiCli.sendInput': 'terminal.input',
      'aiCli.resizeSession': 'terminal.resize',
      'aiCli.redrawSession': 'terminal.redraw',
      'aiCli.interruptSession': 'terminal.interrupt',
      'aiCli.stopSession': 'terminal.kill',
    }
    const type = wsType[plan.address]
    if (!type) throw new Error(`unsupported AI CLI capability '${plan.address}'`)
    const payload: Record<string, unknown> = { terminal_session_id: sessionId }
    if (type === 'terminal.input') payload.data = args.data
    if (type === 'terminal.resize' || type === 'terminal.redraw') {
      payload.cols = args.cols
      payload.rows = args.rows
    }
    if (type === 'terminal.kill') payload.force = args.force === true
    const response = await client.send(type, payload)
    if (!response.ok) throw new Error(response.error?.message ?? 'AI CLI request failed')
    if (type === 'terminal.kill') {
      this.removeAiSession(plugin, sessionId)
      this.terminalRoutes.delete(sessionId)
    }
    return {}
  }

  /** Resolve the small semantic AI CLI contract into an argv owned by the
   * Host. The package can select a registered profile and pane identity only;
   * it cannot provide an executable, shell fragment, cwd, or environment. */
  private aiCliCommand(
    profileId: string,
    args: Record<string, unknown>,
    workspacePath: string
  ): string[] | null {
    const profile = AI_CLI_PROFILES[profileId as keyof typeof AI_CLI_PROFILES]
    if (!profile || !workspacePath) return null
    const executable = profile.command
    const command: string[] = [executable]
    if (profileId === 'aider') {
      const paneId = typeof args.paneId === 'string' ? args.paneId : ''
      const token = paneId.slice(0, 8).toLowerCase()
      const historyName = /^[0-9a-f]{8}$/.test(token)
        ? `.aider.chat.history.${token}.md`
        : '.aider.chat.history.md'
      command.push('--chat-history-file', join(workspacePath, historyName))
    }
    if (args.yolo === true) {
      const flag = 'yoloFlag' in profile ? profile.yoloFlag : undefined
      if (flag) command.push(flag)
    }
    return command
  }

  /** Install the Host-owned durable storage adapter for an already-authorized
   * storage plan. The adapter receives only the derived partition and snapshot
   * identity; it never receives the raw renderer request as an authority. */
  setPublicStorageHandler(
    fn: ((execution: StorageExecution) => unknown | Promise<unknown>) | null
  ): void {
    this.publicStorageHandler = fn
  }

  /** Host-only event ingress for cataloged public events. The target package id
   * is Host-selected and never comes from renderer payload. The source binding
   * must come from the Host producer, not the master package context: AI CLI
   * output/exit requires the exact per-instance binding (including instanceId
   * and audience), while workspace.filesChanged accepts the reserved Host
   * source with matching workspace/packageVersion. Unbound shared-WS fan-out
   * is intentionally dropped by {@link dispatchEvent}. */
  dispatchPublicCapabilityEvent(
    targetPluginId: string,
    event: string,
    payload: unknown,
    sourceBinding: AuthenticatedRuntimeBinding
  ): void {
    if (
      typeof targetPluginId !== 'string' ||
      targetPluginId.length === 0 ||
      !PUBLIC_CAPABILITY_EVENT_ADDRESSES.includes(event)
    ) {
      return
    }
    this.dispatchEvent(event, payload, sourceBinding, targetPluginId)
  }

  /** Main-registered handlers for the shell-level host capabilities
   *  (open_external / reveal_path / open_workspace / pick_folder). index.ts
   *  wires them to shell.openExternal / shell.showItemInFolder /
   *  window:openMain / dialog.showOpenDialog respectively. */
  private hostShellHandlers: {
    openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
    revealPath: (path: string) => { ok: boolean; error?: string }
    openWorkspace: (workspacePath: string) => { ok: boolean }
    pickFolder: (defaultPath?: string) => Promise<string | null>
  } | null = null

  setHostShellHandlers(handlers: NonNullable<FrontendPluginManager['hostShellHandlers']>): void {
    this.hostShellHandlers = handlers
  }

  /** Service a host-implemented capability call (see HOST_CAPABILITIES). */
  private async runHostAction(
    call: CapabilityCall,
    plugin: RunningPlugin
  ): Promise<CapabilityResponse> {
    const args = (typeof call.args === 'object' && call.args !== null ? call.args : {}) as Record<
      string,
      unknown
    >
    const action = HOST_CAPABILITIES[`${call.ns}.${call.method}`]

    if (action === 'open_in_editor') {
      // The root defaults to the query the HOST launched this view with. A
      // call MAY name its own `workspace_path` — that is how a view opens a
      // file that lives outside the workspace it was given (the safety
      // boundary for such opens sits in the caller, by product decision).
      // The target is handed to the mini-IDE or (as a fallback) to the OS
      // default app.
      const callerRoot = typeof args.workspace_path === 'string' ? args.workspace_path : ''
      const workspacePath = callerRoot || workspaceOf(plugin.query)
      const filepath = typeof args.filepath === 'string' ? args.filepath : ''
      if (!workspacePath || !filepath) {
        return buildError(call.reqId, 'BAD_REQUEST', 'filepath is required inside a workspace view')
      }
      // Containment: resolve against the root and keep only targets that stay
      // under it, so neither '../' traversal nor an absolute path can reach a
      // file outside it. This holds for a caller-supplied root too: naming the
      // file's own root is the supported way to reach it, so the target never
      // needs to escape whichever root won.
      const root = resolve(workspacePath)
      const rel = relative(root, resolve(root, filepath))
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return buildError(call.reqId, 'BAD_REQUEST', 'filepath escapes the root')
      }
      const handler = this.openInEditorHandler
      if (!handler) {
        return buildError(call.reqId, 'BACKEND_ERROR', 'editor open handler not registered')
      }
      // Hand the RESOLVED root downstream: an unnormalized one ('/ws/sub/..')
      // passes containment yet reads as a different view identity, which would
      // reload the mini-IDE for a file that is in fact inside its workspace.
      const opened = await handler({ workspace_path: root, filepath: rel })
      return buildSuccess(call.reqId, { ok: true, opened })
    }

    // Shell-level actions. reveal_path / open_workspace intentionally accept
    // absolute paths outside the view's workspace: their legitimate targets
    // are git worktrees, which live beside (not under) the repo root. Both are
    // display-only surfaces (file manager reveal / opening a Navide window);
    // neither reads nor writes the target, and only first-party `navide.*`
    // plugins can be granted `ui` (reserved publisher namespace).
    const shell = this.hostShellHandlers
    if (!shell) {
      return buildError(call.reqId, 'BACKEND_ERROR', 'host shell handlers not registered')
    }
    if (action === 'open_external') {
      const url = typeof args.url === 'string' ? args.url : ''
      if (!/^https?:\/\/[^\s]+$/i.test(url)) {
        return buildError(call.reqId, 'BAD_REQUEST', 'only http/https urls allowed')
      }
      const r = await shell.openExternal(url)
      return r.ok
        ? buildSuccess(call.reqId, { ok: true })
        : buildError(call.reqId, 'BACKEND_ERROR', r.error ?? 'open failed')
    }
    if (action === 'reveal_path') {
      const path = typeof args.path === 'string' ? args.path : ''
      if (!path || !isAbsolute(path)) {
        return buildError(call.reqId, 'BAD_REQUEST', 'an absolute path is required')
      }
      const r = shell.revealPath(path)
      return r.ok
        ? buildSuccess(call.reqId, { ok: true })
        : buildError(call.reqId, 'BACKEND_ERROR', r.error ?? 'reveal failed')
    }
    if (action === 'open_workspace') {
      const workspacePath = typeof args.workspace_path === 'string' ? args.workspace_path : ''
      if (!workspacePath || !isAbsolute(workspacePath)) {
        return buildError(call.reqId, 'BAD_REQUEST', 'an absolute workspace_path is required')
      }
      const r = shell.openWorkspace(workspacePath)
      return buildSuccess(call.reqId, { ok: r.ok })
    }
    if (action === 'pick_folder') {
      const defaultPath = typeof args.default_path === 'string' ? args.default_path : undefined
      const picked = await shell.pickFolder(defaultPath)
      return buildSuccess(call.reqId, { ok: true, path: picked })
    }
    return buildError(call.reqId, 'UNKNOWN', `no host action '${String(action)}'`)
  }

  /** Fan a transport status transition out to every backend-needing plugin as
   *  the host-synthesized `nav.backend_status` event, so plugin-side useBackend
   *  shims track real liveness instead of assuming 'connected'. */
  private dispatchBackendStatus(status: WsClientStatus): void {
    this.wsStatus = status
    for (const plugin of this.running.values()) {
      if (plugin.requires.length > 0 && plugin.capabilityPolicy.kind !== 'manifest-v2') {
        this.emitToInstance(plugin.instanceId, 'nav.backend_status', { status })
      }
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
      const client = createWsClient({
        WebSocketImpl: NodeWebSocket as unknown as WsConstructor,
        onStatus: (s) => this.dispatchBackendStatus(s),
      })
      for (const event of new Set([...Object.keys(CAP_EVENTS), ...PUBLIC_CAPABILITY_EVENT_ADDRESSES])) {
        client.on(event, (payload) => {
          // The shared backend listener has no authenticated public-event
          // source binding. Manifest v2 events therefore fail closed here;
          // Host producers must use dispatchPublicCapabilityEvent().
          this.dispatchEvent(event, payload)
        })
      }
      client.connect(this.backendWsUrl)
      this.wsClient = client
    }
    return this.wsClient
  }

  private routeForPlugin(plugin: RunningPlugin): TerminalRoute | null {
    const binding = plugin.capabilityContext?.runtimeBinding
    if (plugin.hasV2DescriptorIdentity && !this.hasValidTerminalBinding(plugin)) {
      return null
    }
    return {
      pluginId: plugin.id,
      packageVersion: binding?.packageVersion ?? null,
      workspaceId: binding?.workspaceId ?? null,
      audience: binding?.audience ?? null,
      instanceId: plugin.hasV2DescriptorIdentity ? plugin.instanceId : null,
      legacy: !plugin.hasV2DescriptorIdentity,
    }
  }

  private routeMatchesPlugin(route: TerminalRoute, plugin: RunningPlugin): boolean {
    if (
      route.pluginId !== plugin.id ||
      route.legacy !== !plugin.hasV2DescriptorIdentity
    ) return false
    if (route.legacy) return true
    const binding = plugin.capabilityContext?.runtimeBinding
    return (
      this.hasValidTerminalBinding(plugin) &&
      binding !== null &&
      binding !== undefined &&
      route.packageVersion === binding.packageVersion &&
      route.workspaceId === binding.workspaceId &&
      route.audience === binding.audience
    )
  }

  private hasValidTerminalBinding(plugin: RunningPlugin): boolean {
    const context = plugin.capabilityContext
    const binding = context?.runtimeBinding
    return (
      plugin.hasV2DescriptorIdentity &&
      context !== null &&
      context !== undefined &&
      binding !== null &&
      binding !== undefined &&
      binding.pluginId === plugin.id &&
      nonEmptyString(binding.packageVersion) &&
      nonEmptyString(binding.workspaceId) &&
      nonEmptyString(binding.instanceId) &&
      nonEmptyString(binding.audience) &&
      context.userGrant !== null &&
      context.userGrant.packageVersion === binding.packageVersion
    )
  }

  private canRouteBeClaimed(route: TerminalRoute, plugin: RunningPlugin): boolean {
    if (!this.routeMatchesPlugin(route, plugin)) return false
    return route.legacy || route.instanceId === null || route.instanceId === plugin.instanceId
  }

  private runningPluginForTerminalRoute(route: TerminalRoute | undefined): RunningPlugin | undefined {
    if (!route) return undefined
    if (route.legacy) {
      const legacyInstanceId = this.legacyInstances.get(route.pluginId)
      return legacyInstanceId ? this.running.get(legacyInstanceId) : undefined
    }
    if (!route.instanceId) return undefined
    const plugin = this.running.get(route.instanceId)
    return plugin && this.routeMatchesPlugin(route, plugin) ? plugin : undefined
  }

  private activeTerminalOwnerKey(route: TerminalRoute): string | null {
    if (route.legacy) {
      return this.runningPluginForTerminalRoute(route) ? `legacy:${route.pluginId}` : null
    }
    return this.runningPluginForTerminalRoute(route) ? `instance:${route.instanceId}` : null
  }

  private logDroppedTerminalEvent(
    event: string,
    sessionId: string,
    route: TerminalRoute | undefined
  ): void {
    const owner = route?.instanceId ?? route?.pluginId
    console.debug(
      `[plugin] dropping ${event} for terminal session ${sessionId}: ` +
        (owner ? `owner ${owner} is not active` : 'no active route')
    )
  }

  private requiresTerminalOwnership(wsType: string): boolean {
    return TERMINAL_OWNED_WS_TYPES.has(wsType)
  }

  private ownsTerminalSession(plugin: RunningPlugin, payload: unknown): boolean {
    const sessionId = terminalSessionIdOf(payload)
    if (!sessionId) return false
    const route = this.terminalRoutes.get(sessionId)
    if (!route || !this.routeMatchesPlugin(route, plugin)) return false
    return route.legacy || route.instanceId === plugin.instanceId
  }

  /** Fan a backend server-push event out to every running plugin whose
   *  manifest grants the namespace gating that event. terminal.output rides the
   *  per-session micro-batcher instead of going out per event, and
   *  terminal.exit flushes that batch first (ordering barrier) then retires the
   *  session's route. */
  private dispatchEvent(
    event: string,
    payload: unknown,
    sourceBinding?: AuthenticatedRuntimeBinding,
    targetPluginId?: string
  ): void {
    // User-level settings are still a private Host event for the first-party
    // Git package. The package settings port uses this to keep left/window
    // theme and layout caches synchronized; workspace routing is unnecessary
    // because these values are intentionally user-scoped.
    if (event === 'ui.settings_changed') {
      for (const plugin of this.running.values()) {
        if (
          plugin.hasV2DescriptorIdentity &&
          plugin.id === GIT_PLUGIN_ID &&
          plugin.capabilityPolicy.kind === 'manifest-v2' &&
          plugin.capabilityPolicy.system.includes('ui') &&
          plugin.capabilityContext?.userGrant?.system.includes('ui')
        ) {
          this.emitToInstance(plugin.instanceId, event, payload)
        }
      }
      // Keep the legacy loop below active while the rollback bundle is live.
    }
    // Git's existing changed event is a private first-party transport seam,
    // not a public Manifest v2 capability. Route it by the Host-owned
    // workspace path so two Git view instances never receive one another's
    // refresh. Credential events intentionally remain legacy-only.
    if (event === 'git.changed') {
      const eventWorkspace =
        typeof payload === 'object' && payload !== null &&
        typeof (payload as Record<string, unknown>).workspace_path === 'string'
          ? resolve((payload as Record<string, unknown>).workspace_path as string)
          : null
      if (!eventWorkspace) return
      let routedV2 = false
      for (const plugin of this.running.values()) {
        if (
          !plugin.hasV2DescriptorIdentity ||
          plugin.id !== GIT_PLUGIN_ID ||
          (targetPluginId !== undefined && plugin.id !== targetPluginId) ||
          !plugin.workspacePath ||
          resolve(plugin.workspacePath) !== eventWorkspace
        ) {
          continue
        }
        const context = plugin.capabilityContext
        const policy = plugin.capabilityPolicy
        if (
          policy.kind !== 'manifest-v2' ||
          !policy.system.includes('fs') ||
          !context?.userGrant?.system.includes('fs')
        ) {
          continue
        }
        this.emitToInstance(plugin.instanceId, event, payload)
        routedV2 = true
      }
      if (routedV2) return
    }
    if (event === 'terminal.output') {
      const sessionId = terminalSessionIdOf(payload)
      if (!sessionId) return
      const route = this.terminalRoutes.get(sessionId)
      const owner = route ? this.activeTerminalOwnerKey(route) : null
      if (!owner) {
        this.logDroppedTerminalEvent(event, sessionId, route)
        return
      }
      const ownerPlugin = route ? this.runningPluginForTerminalRoute(route) : undefined
      if (ownerPlugin?.hasV2DescriptorIdentity && ownerPlugin.id === GIT_PLUGIN_ID) {
        const binding = ownerPlugin.capabilityContext?.runtimeBinding
        const data = toPayload(payload).data
        if (
          binding &&
          this.isPublicEventAllowedForInstance(
            ownerPlugin,
            'aiCli.output',
            { sessionId, data },
            binding
          )
        ) {
          this.emitToInstance(ownerPlugin.instanceId, 'aiCli.output', { sessionId, data })
        }
        return
      }
      const pendingOwner = this.pendingTerminalOwners.get(sessionId)
      if (pendingOwner && pendingOwner !== owner) {
        this.terminalOutputBatcher.dropSession(sessionId)
        this.pendingTerminalOwners.delete(sessionId)
      }
      this.pendingTerminalOwners.set(sessionId, owner)
      this.terminalOutputBatcher.push(sessionId, toPayload(payload))
      return
    } else if (event === 'terminal.exit') {
      const sessionId = terminalSessionIdOf(payload)
      if (!sessionId) return
      const route = this.terminalRoutes.get(sessionId)
      const ownerPlugin = route ? this.runningPluginForTerminalRoute(route) : undefined
      if (ownerPlugin?.hasV2DescriptorIdentity && ownerPlugin.id === GIT_PLUGIN_ID) {
        const binding = ownerPlugin.capabilityContext?.runtimeBinding
        const exitCode = toPayload(payload).exit_code
        const normalizedExitCode = typeof exitCode === 'number' ? exitCode : null
        if (
          binding &&
          this.isPublicEventAllowedForInstance(
            ownerPlugin,
            'aiCli.exited',
            { sessionId, exitCode: normalizedExitCode },
            binding
          )
        ) {
          this.emitToInstance(ownerPlugin.instanceId, 'aiCli.exited', {
            sessionId,
            exitCode: normalizedExitCode,
          })
        }
        this.removeAiSession(ownerPlugin, sessionId)
        this.terminalRoutes.delete(sessionId)
        return
      }
      this.terminalOutputBatcher.flushSession(sessionId)
      this.deliverTerminalEvent(event, sessionId, payload)
      this.terminalRoutes.delete(sessionId)
      this.pendingTerminalOwners.delete(sessionId)
      return
    }
    for (const plugin of this.running.values()) {
      if (targetPluginId !== undefined && plugin.id !== targetPluginId) continue
      const allowed =
        plugin.capabilityPolicy.kind === 'manifest-v2'
          ? plugin.capabilityContext !== null &&
            isPublicCapabilityEventAllowed(
              plugin.capabilityPolicy,
              event,
              payload,
              plugin.capabilityContext,
              targetPluginId ?? '',
              sourceBinding
            )
          : isEventAllowed(plugin.capabilityPolicy, event)
      if (allowed) {
        this.emitToInstance(plugin.instanceId, event, payload)
      }
    }
  }

  private isPublicEventAllowedForInstance(
    plugin: RunningPlugin,
    event: string,
    payload: unknown,
    sourceBinding: AuthenticatedRuntimeBinding
  ): boolean {
    return (
      plugin.capabilityPolicy.kind === 'manifest-v2' &&
      plugin.capabilityContext !== null &&
      isPublicCapabilityEventAllowed(
        plugin.capabilityPolicy,
        event,
        payload,
        plugin.capabilityContext,
        plugin.id,
        sourceBinding
      )
    )
  }

  /** Deliver a terminal.output/exit event to the session's registered owner —
   *  and ONLY the owner. Unrouted sessions, detached tombstones, and stale
   *  batches are dropped; PTY content must not leak to a sibling or a later
   *  instance. */
  private deliverTerminalEvent(
    event: string,
    sessionId: string,
    payload: unknown,
    expectedOwner?: string
  ): void {
    const route = this.terminalRoutes.get(sessionId)
    const owner = route ? this.activeTerminalOwnerKey(route) : null
    if (!owner || (expectedOwner !== undefined && owner !== expectedOwner)) {
      this.logDroppedTerminalEvent(event, sessionId, route)
      return
    }
    const plugin = this.runningPluginForTerminalRoute(route)
    if (plugin) {
      this.emitToInstance(plugin.instanceId, event, payload)
    }
  }

  /** Register the PTY sessions a successful terminal.create/terminal.reattach
   *  response binds to one authenticated view instance. Legacy callers may
   *  still pass their plugin id through the v1 adapter. */
  noteTerminalRoutes(instanceOrPluginId: string, wsType: string, result: unknown): void {
    const plugin = this.resolveInstance(instanceOrPluginId)
    if (!plugin) return
    const route = this.routeForPlugin(plugin)
    if (!route) return
    for (const sessionId of terminalSessionsFromResponse(wsType, result)) {
      const previous = this.terminalRoutes.get(sessionId)
      if (previous && !this.canRouteBeClaimed(previous, plugin)) continue
      const previousOwner = previous ? this.activeTerminalOwnerKey(previous) : null
      const nextOwner = this.activeTerminalOwnerKey(route)
      if (previousOwner && previousOwner !== nextOwner) {
        this.terminalOutputBatcher.dropSession(sessionId)
        this.pendingTerminalOwners.delete(sessionId)
      }
      this.terminalRoutes.set(sessionId, route)
    }
  }

  /**
   * Strip every session id that the authenticated instance cannot claim. v2
   * reattach is fail-closed for unknown ids: the session id is not a free
   * credential. A live legacy adapter retains its bounded v1 compatibility for
   * unknown ids; stale/unknown senders are fail-closed even when an old route
   * remains in memory.
   */
  filterTerminalReattachPayload(
    instanceOrPluginId: string,
    payload: Record<string, unknown>
  ): Record<string, unknown> {
    const ids = payload.terminal_session_ids
    if (!Array.isArray(ids)) return payload
    const plugin = this.resolveInstance(instanceOrPluginId)
    if (!plugin) {
      return { ...payload, terminal_session_ids: [] }
    }
    const kept = ids.filter((id) => {
      if (typeof id !== 'string') return false
      const route = this.terminalRoutes.get(id)
      if (!route) return plugin.openedViaLegacyAdapter && !plugin.hasV2DescriptorIdentity
      return this.canRouteBeClaimed(route, plugin)
    })
    if (kept.length === ids.length) return payload
    console.debug(
      `[plugin] reattach: stripped ${ids.length - kept.length} session id(s) not owned by ${plugin.id}`
    )
    return { ...payload, terminal_session_ids: kept }
  }

  /**
   * Service one fire-and-forget capability cast (IPC_CAST / nav.castCapability).
   * Same scoping + routing as IPC_CALL, but no response ever returns to the
   * view, and ONLY the {@link CASTABLE_WS_TYPES} whitelist may dispatch
   * (main-side enforcement mirroring the shims' CAST_TYPES). Every drop logs a
   * distinct debug line; the outcome is returned for tests.
   */
  handleCast(
    senderId: number,
    payload: unknown
  ): 'dispatched' | 'no-backend' | 'unknown-sender' | 'malformed' | 'denied' | 'unmapped' | 'not-castable' {
    const plugin = this.instanceForSender(senderId)
    if (!plugin) {
      console.debug('[plugin] cast dropped: unknown sender')
      return 'unknown-sender'
    }
    const pluginId = plugin.id
    if (this.payloadClaimsInstance(payload)) {
      console.debug(`[plugin] cast dropped: ${pluginId} instance identity is Host-owned`)
      return 'malformed'
    }
    const call = parseCapabilityCall(payload, pluginId)
    if (!call) {
      console.debug(`[plugin] cast dropped: malformed call from ${pluginId}`)
      return 'malformed'
    }
    const plan = planCapabilityCall(
      call,
      plugin.capabilityPolicy,
      plugin.capabilityContext ?? undefined
    )
    if (plan.kind === 'public') {
      console.debug(`[plugin] cast dropped: ${pluginId} public capabilities are request/response only`)
      return 'not-castable'
    }
    if (plan.kind === 'host') {
      console.debug(
        `[plugin] cast dropped: ${pluginId} ${call.ns}.${call.method} is a host capability (not castable)`
      )
      return 'not-castable'
    }
    if (plan.kind === 'respond') {
      if (plan.response.error?.code === 'CAP_DENIED') {
        console.debug(`[plugin] cast dropped: ${pluginId} ${call.ns}.${call.method} denied`)
        return 'denied'
      }
      console.debug(`[plugin] cast dropped: ${pluginId} ${call.ns}.${call.method} unmapped`)
      return 'unmapped'
    }
    if (!CASTABLE_WS_TYPES.has(plan.wsType)) {
      console.debug(
        `[plugin] cast dropped: ${pluginId} ${plan.wsType} is not in the cast whitelist`
      )
      return 'not-castable'
    }
    const castPayload = toPayload(call.args)
    if (
      this.requiresTerminalOwnership(plan.wsType) &&
      !this.ownsTerminalSession(plugin, castPayload)
    ) {
      console.debug(`[plugin] cast dropped: ${pluginId} ${plan.wsType} terminal session is not owned`)
      return 'denied'
    }
    const client = this.ensureBackend()
    if (!client) {
      console.debug(`[plugin] cast dropped: ${pluginId} ${plan.wsType} — backend not connected`)
      return 'no-backend'
    }
    void client.send(plan.wsType, castPayload).catch(() => {
      // Nobody is awaiting — a failed input write surfaces through the PTY
      // stream itself (or the next request/response call).
    })
    return 'dispatched'
  }

  private beginTerminalOperation(
    plugin: RunningPlugin,
    wsType: string,
    client: WsClient,
    payload: Record<string, unknown>
  ): PendingTerminalOperation | null {
    if (wsType !== 'terminal.create' && wsType !== 'terminal.reattach') return null
    const operation: PendingTerminalOperation = {
      operationId: randomUUID(),
      instanceId: plugin.instanceId,
      wsType,
      client,
      route: this.routeForPlugin(plugin),
      cancelled: false,
      cancelSent: false,
      cleanupSessionIds: new Set<string>(),
      ...(wsType === 'terminal.create' && nonEmptyString(payload.pane_id)
        ? { paneId: payload.pane_id }
        : {}),
      ...(wsType === 'terminal.create' && nonEmptyString(payload.create_generation)
        ? { createGeneration: payload.create_generation }
        : {}),
    }
    this.pendingTerminalOperations.set(operation.operationId, operation)
    return operation
  }

  private canCommitTerminalOperation(operation: PendingTerminalOperation | null): boolean {
    if (!operation || operation.cancelled) return false
    const plugin = this.running.get(operation.instanceId)
    if (!plugin) return false
    return sameTerminalRoute(operation.route, this.routeForPlugin(plugin))
  }

  private cleanupCancelledTerminalCreate(
    operation: PendingTerminalOperation,
    result: unknown
  ): void {
    if (!operation.paneId || !operation.createGeneration) return
    if (typeof result !== 'object' || result === null) return
    const response = result as Record<string, unknown>
    if (
      response.pane_id !== operation.paneId ||
      response.create_generation !== operation.createGeneration
    ) {
      return
    }
    const sessionIds = terminalSessionsFromResponse(operation.wsType, result)
    if (sessionIds.length !== 1) return
    const sessionId = sessionIds[0]
    if (operation.cleanupSessionIds.has(sessionId)) return
    operation.cleanupSessionIds.add(sessionId)

    // This is Host cleanup for a create operation that could not be committed
    // to a live view, not a plugin capability call. It intentionally bypasses
    // the plugin authorization path and targets only this response's session.
    void operation.client
      .send('terminal.kill', { terminal_session_id: sessionId, force: true })
      .then((response) => {
        if (!response.ok) {
          // The expected outcome when the cancellation won the race: the
          // backend already rolled the create back and dropped its ownership,
          // so the kill has nothing left to reclaim.
          console.debug(`[plugin] late terminal.create cleanup was rejected for ${sessionId}`)
        }
      })
      .catch(() => {
        console.warn(`[plugin] late terminal.create cleanup failed for ${sessionId}`)
      })
  }

  private invalidatePendingTerminalOperations(plugin: RunningPlugin): void {
    for (const operation of this.pendingTerminalOperations.values()) {
      if (operation.instanceId !== plugin.instanceId || operation.cancelled) continue
      operation.cancelled = true
      if (
        operation.wsType === 'terminal.create' &&
        !operation.cancelSent &&
        operation.paneId &&
        operation.createGeneration
      ) {
        operation.cancelSent = true
        void operation.client
          .send('terminal.create.cancel', {
            pane_id: operation.paneId,
            create_generation: operation.createGeneration,
          })
          .catch(() => {
            // The ledger remains cancelled even if the backend is already
            // unavailable; a late create response must never revive a route.
          })
      }
    }
  }

  /** Shared terminal teardown for BOTH view-death paths ({@link destroy} and
   *  the defensive webContents 'destroyed' hook): discard this instance's
   *  pending output and detach only its live route ownership. The stable v2
   *  tuple remains as a Host-owned tombstone for safe reattach. */
  private releaseTerminalOwnership(plugin: RunningPlugin): void {
    this.invalidatePendingTerminalOperations(plugin)
    for (const [sessionId, route] of this.terminalRoutes) {
      const ownsRoute = route.legacy
        ? plugin.openedViaLegacyAdapter && route.pluginId === plugin.id
        : route.instanceId === plugin.instanceId && this.routeMatchesPlugin(route, plugin)
      if (!ownsRoute) continue
      this.terminalOutputBatcher.dropSession(sessionId)
      this.pendingTerminalOwners.delete(sessionId)
      if (!route.legacy) {
        this.terminalRoutes.set(sessionId, { ...route, instanceId: null })
      }
    }
  }

  private releaseInstanceSubscriptions(instanceId: string): void {
    const subscriptions = this.instanceSubscriptions.get(instanceId)
    if (!subscriptions) return
    this.instanceSubscriptions.delete(instanceId)
    for (const dispose of subscriptions) {
      try {
        dispose()
      } catch {
        // One broken subscription must not prevent sibling cleanup.
      }
    }
  }

  /** Detach a view from its host without changing the WebContents lifecycle. */
  private detachView(plugin: RunningPlugin): void {
    try {
      if (!plugin.hostWindow.isDestroyed()) {
        plugin.hostWindow.contentView.removeChildView(plugin.view)
      }
    } catch {
      // Host teardown may already have removed the view.
    }
  }

  private forgetInstance(instanceId: string, view?: WebContentsView): RunningPlugin | undefined {
    const plugin = this.running.get(instanceId)
    if (!plugin || (view && plugin.view !== view)) return undefined
    plugin.detachHostResize?.()
    plugin.detachHostResize = null
    plugin.detachHostClosed?.()
    plugin.detachHostClosed = null
    this.releaseTerminalOwnership(plugin)
    this.releaseInstanceSubscriptions(instanceId)
    this.running.delete(instanceId)
    this.bySender.delete(plugin.senderId)
    if (![...this.running.values()].some((candidate) => candidate.hostWindow.id === plugin.hostWindow.id)) {
      this.gitContributionStates.delete(plugin.hostWindow.id)
    }
    if (this.legacyInstances.get(plugin.id) === instanceId) {
      this.legacyInstances.delete(plugin.id)
    }
    return plugin
  }

  private destroyPluginInstances(pluginId: string): void {
    for (const plugin of this.instancesForPlugin(pluginId)) {
      this.destroyInstance(plugin.instanceId)
    }
  }

  private clearTerminalRoutes(pluginId: string): void {
    for (const [sessionId, route] of this.terminalRoutes) {
      if (route.pluginId !== pluginId) continue
      this.terminalOutputBatcher.dropSession(sessionId)
      this.pendingTerminalOwners.delete(sessionId)
      this.terminalRoutes.delete(sessionId)
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
    opts: { closeHostOnHide?: boolean; mirrorTitle?: boolean } = {}
  ): void {
    this.registerIpc()

    const existingId = this.legacyInstances.get(descriptor.id)
    const existing = existingId ? this.running.get(existingId) : undefined
    if (existing) {
      if (existing.view.webContents.isDestroyed() || existing.hostWindow.isDestroyed()) {
        // Stale record (renderer crash / host teardown race) — drop it and fall
        // through to a fresh create; loadEntry on a dead webContents would brick.
        this.destroyInstance(existing.instanceId)
      } else {
        const nextDescriptorContext =
          descriptor.capabilityContext === undefined
            ? existing.capabilityContext
            : descriptor.capabilityContext
        validateV2CapabilityContext(descriptor, nextDescriptorContext ?? null)
        if (existing.hasV2DescriptorIdentity !== hasV2DescriptorIdentity(descriptor)) {
          // A live instance must not switch between v1 and v2 route semantics.
          // Recreate it so all existing routes are released under the old identity.
          this.destroyInstance(existing.instanceId)
        } else {
          this.updateInstanceCapabilityContext(existing, nextDescriptorContext)
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
            // without reloading, so open tabs and unsaved buffers survive). This
            // is also the path an out-of-workspace open takes: it carries
            // `file_ws` in the params, which is not part of the identity above.
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
    }

    this.mountView(hostWindow, descriptor, bounds, descriptor.query ?? '', opts, undefined, true)
  }

  /**
   * Open one validated Manifest v2 contribution as a fresh Host-owned
   * instance. The descriptor and view contribute only stable registry keys;
   * entry launch data always comes from the current Host registry record.
   * Capability context is either that registry context or an explicitly
   * Host-supplied per-view context; renderer data never supplies either one.
   */
  async openView(
    packageDescriptor: PluginLaunchDescriptor,
    view: PluginViewLaunchDescriptor,
    options: PluginViewOpenOptions
  ): Promise<PluginViewHandle> {
    const registered = this.descriptors.get(packageDescriptor.id)
    if (!registered) {
      throw new Error(`package descriptor '${packageDescriptor.id}' is not registered by the Host`)
    }
    const canonicalView = registered.views?.find(
      (candidate) => candidate.contributionKey === view.contributionKey
    )
    if (!canonicalView) {
      throw new Error(
        `view '${view.contributionKey}' is not registered by the Host package descriptor`
      )
    }
    const capabilityContext =
      options.capabilityContext === undefined
        ? registered.capabilityContext ?? null
        : options.capabilityContext
    validateV2CapabilityContext(registered, capabilityContext)
    this.registerIpc()

    const handle = this.mountView(
      options.hostWindow,
      registered,
      options.bounds,
      options.query ?? '',
      { ...options, capabilityContext },
      canonicalView,
      false
    )
    this.focusInstance(handle.instanceId)
    return handle
  }

  private mountView(
    hostWindow: BrowserWindow,
    descriptor: PluginLaunchDescriptor,
    bounds: PluginViewBounds,
    query: string,
    opts: {
      closeHostOnHide?: boolean
      mirrorTitle?: boolean
      workspacePath?: string
      capabilityContext?: HostCapabilityContext | null
    },
    viewDescriptor: PluginViewLaunchDescriptor | undefined,
    openedViaLegacyAdapter: boolean
  ): PluginViewHandle {
    const capabilityContext =
      opts.capabilityContext === undefined ? descriptor.capabilityContext : opts.capabilityContext
    validateV2CapabilityContext(descriptor, capabilityContext ?? null)
    const isV2Identity = hasV2DescriptorIdentity(descriptor)
    const instanceId = this.nextInstanceId()
    const loadDescriptor: PluginLaunchDescriptor = {
      ...descriptor,
      entryFile: viewDescriptor?.entryFile ?? descriptor.entryFile,
      query,
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
        // Plugin views host AiCliDock terminals — see the main window for why
        // throttling must stay off. One non-throttled webContents also keeps
        // frames drawn for the whole host window, which is how the plugin host
        // windows below (they declare no webPreferences of their own) inherit
        // it. Note Electron 33 still reports visibilityState 'hidden' for an
        // occluded WebContentsView regardless (electron#44590), so do not rely
        // on the Page Visibility API inside plugin views.
        backgroundThrottling: false,
        // Injected so the preload can stamp calls with an authoritative plugin id.
        additionalArguments: [`--plugin-id=${descriptor.id}`],
      },
    })

    // A dedicated host window carries no UI of its own — its webContents stays
    // blank, so the plugin's document.title never reaches the window and the
    // macOS Window menu / Mission Control / Dock keep showing the static
    // creation-time title. Mirror the view's page title onto the host so every
    // window follows the same `<context> — <feature>` naming (see
    // docs/en-US/plugin-development.md). Opt-in: a plugin embedded in the main
    // window must not overwrite that window's title.
    if (opts.mirrorTitle) {
      view.webContents.on('page-title-updated', (_event, title) => {
        if (!hostWindow.isDestroyed() && title) hostWindow.setTitle(title)
      })
    }

    // attach
    hostWindow.contentView.addChildView(view)

    const record: RunningPlugin = {
      instanceId,
      id: descriptor.id,
      openedViaLegacyAdapter,
      hasV2DescriptorIdentity: isV2Identity,
      requires: descriptor.requires,
      capabilityPolicy: descriptor.capabilityPolicy ?? legacyCapabilityPolicy(descriptor.requires),
      capabilityContext:
        isV2Identity || !openedViaLegacyAdapter
          ? this.bindCapabilityContext(capabilityContext, instanceId)
          : capabilityContext ?? null,
      view,
      hostWindow,
      workspacePath: opts.workspacePath ?? null,
      query,
      senderId: view.webContents.id,
      fill: bounds === 'fill',
      detachHostResize: null,
      detachHostClosed: null,
      closeHostOnHide: opts.closeHostOnHide ?? false,
      ready: false,
      pendingTargets: [],
    }
    this.running.set(instanceId, record)
    if (openedViaLegacyAdapter) this.legacyInstances.set(descriptor.id, instanceId)
    this.bySender.set(record.senderId, instanceId)
    this.applyBounds(record, bounds)
    this.trackHostResize(record)

    // A plugin needing the backend gets the shared transport connected now (if
    // the backend url is already known) so server-push events reach it without
    // waiting for its first capability call.
    if (descriptor.requires.length > 0) this.ensureBackend()

    // If the host window goes away, tear the view down with it. Guarded so a
    // later record (view recreated on another window) is never torn down by a
    // stale hook.
    const onHostClosed = (): void => {
      if (this.running.get(instanceId)?.view === view) this.destroyInstance(instanceId)
    }
    hostWindow.on('closed', onHostClosed)
    record.detachHostClosed = () => hostWindow.removeListener('closed', onHostClosed)

    // Defensive cleanup: if the view's webContents dies through any path other
    // than destroy() (renderer crash, Electron teardown), drop the record so
    // the next open() recreates instead of loading into a destroyed view.
    view.webContents.once('destroyed', () => {
      const plugin = this.forgetInstance(instanceId, view)
      if (plugin) this.detachView(plugin)
    })

    // Open targets sent before the entry finished loading are queued and
    // flushed here (mirrors the legacy editor window's did-finish-load flush).
    view.webContents.on('did-finish-load', () => {
      const current = this.running.get(instanceId)
      if (current?.view !== view) return
      current.ready = true
      for (const params of current.pendingTargets.splice(0)) {
        view.webContents.send(IPC_OPEN_TARGET, params)
      }
      // Replay the current transport status: transitions before this load (or
      // while a queued view was still booting) would otherwise be missed and
      // the plugin's optimistic 'connected' default never corrected.
      if (
        current.requires.length > 0 &&
        current.capabilityPolicy.kind !== 'manifest-v2' &&
        this.wsClient
      ) {
        this.emitToInstance(instanceId, 'nav.backend_status', { status: this.wsStatus })
      }
    })

    this.loadEntry(view, loadDescriptor, viewDescriptor !== undefined)

    // activate (show)
    view.setVisible(true)
    return Object.freeze({ instanceId })
  }

  /** Resolve a Host-supplied workspace path for an authenticated instance. */
  workspacePathOfInstance(instanceId: string): string | null {
    return this.running.get(instanceId)?.workspacePath ?? null
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

  /** Load a legacy entry from the dev server when available, or a built file.
   *  Contribution views always load their canonical view entry file so one
   *  package-level devUrl cannot collapse multiple views onto one document. */
  private loadEntry(
    view: WebContentsView,
    descriptor: PluginLaunchDescriptor,
    forceFile = false
  ): void {
    const devUrl = !forceFile && process.env['ELECTRON_RENDERER_URL'] ? descriptor.devUrl : null
    const query = descriptor.query ?? ''
    if (devUrl) void view.webContents.loadURL(devUrl + query)
    else void view.webContents.loadFile(descriptor.entryFile, query ? { search: query } : undefined)
  }

  /** Show a plugin view without recreating it. A fill view re-syncs to the
   *  host's content bounds and resumes tracking host resizes. This does not
   *  change OS focus; call {@link focusInstance} explicitly when needed. */
  activate(instanceId: string): void {
    const plugin = this.resolveInstance(instanceId)
    if (!plugin) return
    if (plugin.fill && !plugin.hostWindow.isDestroyed()) {
      this.applyBounds(plugin, 'fill')
      this.trackHostResize(plugin)
    }
    plugin.view.setVisible(true)
  }

  /** Focus one exact live Host-owned instance without changing its visibility
   *  or bounds. Stale/unknown instance ids are ignored. */
  focusInstance(instanceId: string): void {
    const plugin = this.running.get(instanceId)
    if (!plugin || plugin.view.webContents.isDestroyed()) return
    revealHostWindow(plugin.hostWindow)
    plugin.view.webContents.focus()
  }

  /** Hide a plugin view without destroying its WebContents. Stops tracking
   *  host resizes while hidden (open()/activate re-attach the listener). */
  deactivate(instanceId: string): void {
    const plugin = this.resolveInstance(instanceId)
    if (!plugin) return
    plugin.detachHostResize?.()
    plugin.detachHostResize = null
    plugin.view.setVisible(false)
  }

  /** Update the plugin view's rect (host-driven layout). */
  setBounds(instanceId: string, bounds: PluginBounds): void {
    const plugin = this.resolveInstance(instanceId)
    if (plugin) plugin.view.setBounds(bounds)
  }

  /** Host-driven incremental entry target update for one exact v2 instance.
   *  The package keeps its in-page state while the Host changes a diff target;
   *  the workspace identity itself is changed only by recreating the view. */
  updateViewQuery(instanceId: string, query: string): void {
    const plugin = this.running.get(instanceId)
    if (!plugin) return
    plugin.query = query
    if (query) this.sendOpenTarget(plugin, queryToParams(query))
  }

  /** Host-only/deferred integration seam: register an event/backend
   *  subscription under one exact view instance. The returned function
   *  unregisters and disposes it exactly once; instance teardown invokes the
   *  same wrapper for any remaining subscription. No production v2 producer is
   *  wired through this seam yet. */
  registerInstanceSubscription(instanceId: string, dispose: () => void): () => void {
    if (!this.running.has(instanceId)) {
      try {
        dispose()
      } catch {
        // A stale registration must not make a caller's cleanup path throw.
      }
      return () => undefined
    }
    const subscriptions = this.instanceSubscriptions.get(instanceId) ?? new Set<() => void>()
    this.instanceSubscriptions.set(instanceId, subscriptions)
    let registered = true
    const unregister = (): void => {
      if (!registered) return
      registered = false
      subscriptions.delete(unregister)
      if (
        subscriptions.size === 0 &&
        this.instanceSubscriptions.get(instanceId) === subscriptions
      ) {
        this.instanceSubscriptions.delete(instanceId)
      }
      try {
        dispose()
      } catch {
        // A broken subscription must not make caller or instance teardown throw.
      }
    }
    subscriptions.add(unregister)
    return unregister
  }

  /** Destroy the legacy v1 instance identified by plugin id. */
  destroy(pluginId: string): void {
    const legacyInstanceId = this.legacyInstances.get(pluginId)
    if (legacyInstanceId) this.destroyInstance(legacyInstanceId)
  }

  /** Detach and destroy one exact Host-owned instance. Stale/unknown ids are
   *  ignored and never fall back to a plugin id. */
  destroyInstance(instanceId: string): void {
    const plugin = this.forgetInstance(instanceId)
    if (!plugin) return
    this.detachView(plugin)
    try {
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
   * (`opts.builtin`) or by an install whose App-authorized Official Registry
   * verification passed (`opts.official`); the internal `host` identity is
   * never a plugin id.
   */
  registerDescriptor(
    descriptor: PluginLaunchDescriptor,
    opts: { builtin?: boolean; official?: boolean } = {}
  ): void {
    if (descriptor.id === HOST_EVENT_SOURCE_PLUGIN_ID) {
      throw new Error(`internal Host event identity '${HOST_EVENT_SOURCE_PLUGIN_ID}' is not a plugin id`)
    }
    if (!opts.builtin && !opts.official && isReservedPluginId(descriptor.id)) {
      throw new Error(
        `refusing to register reserved plugin id '${descriptor.id}' without official verification`
      )
    }
    this.descriptors.set(descriptor.id, descriptor)
  }

  /**
   * Register a host-bundled builtin descriptor. If an officially-verified
   * marketplace package for the id was scanned first, its frontend descriptor
   * or backend-only inventory entry takes precedence. The builtin is only
   * remembered as the fallback {@link removeInstalledPlugin} reverts to.
   */
  registerBuiltin(descriptor: PluginLaunchDescriptor): void {
    this.builtinFallbacks.set(descriptor.id, descriptor)
    if (!this.installedPackages.has(descriptor.id) && !this.descriptors.has(descriptor.id)) {
      this.registerDescriptor(descriptor, { builtin: true })
    }
  }

  /** Replace the active descriptor with an explicit Host recovery copy.
   *  Recovery is intentionally destructive to live instances: a running v2
   *  view must not continue using the old package after its descriptor has
   *  been rolled back. The package inventory itself is left untouched. */
  replaceBuiltinForRecovery(descriptor: PluginLaunchDescriptor): void {
    this.builtinFallbacks.set(descriptor.id, descriptor)
    this.destroyPluginInstances(descriptor.id)
    this.clearTerminalRoutes(descriptor.id)
    this.registerDescriptor(descriptor, { builtin: true })
  }

  /** Look up a registered descriptor by id. */
  getDescriptor(id: string): PluginLaunchDescriptor | undefined {
    return this.descriptors.get(id)
  }

  /** Inject a Host-authenticated grant/binding after package approval. This is
   * deliberately separate from registerDescriptor/official eligibility so a
   * first-party identity can never become an automatic capability grant. */
  setCapabilityContext(pluginId: string, context: HostCapabilityContext | null): void {
    const descriptor = this.descriptors.get(pluginId)
    const running = this.instancesForPlugin(pluginId)
    if (descriptor) validateV2CapabilityContext(descriptor, context)
    if (
      context !== null &&
      running.some(
        (instance) =>
          instance.hasV2DescriptorIdentity &&
          (descriptor === undefined || !hasV2DescriptorIdentity(descriptor))
      )
    ) {
      throw new Error(`cannot validate capability context for unregistered plugin '${pluginId}'`)
    }
    if (
      running.some(
        (instance) =>
          instance.hasV2DescriptorIdentity &&
          instance.capabilityContext?.storageSnapshotTier !== context?.storageSnapshotTier
      )
    ) {
      throw new Error('storage snapshot tier is fixed for a live plugin instance; recreate the instance')
    }
    if (descriptor) this.descriptors.set(pluginId, { ...descriptor, capabilityContext: context })
    for (const runningInstance of running) {
      this.updateInstanceCapabilityContext(runningInstance, context)
    }
  }

  /** All registered (installed + built-in) descriptors. */
  listDescriptors(): PluginLaunchDescriptor[] {
    return [...this.descriptors.values()]
  }

  /** All validated packages installed from disk, including backend-only packages. */
  listInstalledPackages(): InstalledPluginPackageSummary[] {
    return [...this.installedPackages.values()].map((summary) => ({
      id: summary.id,
      requires: [...summary.requires],
      ...(summary.provenance ? { provenance: summary.provenance } : {}),
      ...(summary.warning ? { warning: summary.warning } : {}),
    }))
  }

  /** Register one Host-selected local unpacked development bundle. The fixed
   * Host call site, not package data, grants the reserved builtin identity.
   * These fixed app bundles are not the explicit local-package acceptance
   * path and therefore do not enter the installed-package inventory. */
  registerDeveloperDescriptor(descriptor: PluginLaunchDescriptor): void {
    this.registerDescriptor(descriptor, { builtin: true })
  }

  /**
   * Load exactly one Host-selected frontend package for Developer
   * Mode. This intentionally reads the selected directory only; it never
   * scans a parent directory or turns an arbitrary package tree into a
   * registry-like inventory. Backend contributions remain fail-closed.
   */
  loadExplicitDeveloperPlugin(
    packageDir: string | undefined,
    optedIn = process.env['AGENT_TEAM_PLUGIN_DEV'] === '1'
  ): { loaded: true; pluginId: string } | { loaded: false; error: string } {
    if (!optedIn) {
      return { loaded: false, error: 'Developer Mode explicit package loading requires opt-in' }
    }
    if (!packageDir || packageDir.trim().length === 0) {
      return { loaded: false, error: 'an explicit package directory must be selected' }
    }
    const scanned = loadPluginDir(packageDir)
    if (scanned.error) return { loaded: false, error: scanned.error }
    const activation = scanned.activation
    const descriptor = scanned.descriptor
    const pluginId = activation?.pluginId ?? descriptor?.id
    if (!pluginId || !scanned.packageSummary) {
      return {
        loaded: false,
        error: 'Developer Mode requires a valid frontend package',
      }
    }
    if (activation?.backend) {
      return { loaded: false, error: 'Developer Mode cannot load backend contributions' }
    }
    if (!descriptor) {
      return {
        loaded: false,
        error: 'Developer Mode requires a valid frontend package',
      }
    }
    if (isReservedPluginId(pluginId)) {
      return {
        loaded: false,
        error: `Developer Mode cannot claim reserved plugin id '${pluginId}'`,
      }
    }
    const summary: InstalledPluginPackageSummary = {
      ...scanned.packageSummary,
      provenance: 'developer-local-unpacked',
      warning: 'Unsigned local unpacked plugin — Developer Mode only',
    }
    try {
      this.registerInstalledPackage(summary, descriptor)
    } catch (error) {
      return { loaded: false, error: error instanceof Error ? error.message : String(error) }
    }
    return { loaded: true, pluginId }
  }

  /** Replace one installed package's inventory and optional frontend descriptor
   *  together. A backend-only update therefore cannot retain an older view. */
  registerInstalledPackage(
    summary: InstalledPluginPackageSummary,
    descriptor?: PluginLaunchDescriptor,
    opts: { official?: boolean } = {}
  ): void {
    if (summary.id === HOST_EVENT_SOURCE_PLUGIN_ID) {
      throw new Error(`internal Host event identity '${HOST_EVENT_SOURCE_PLUGIN_ID}' is not a plugin id`)
    }
    if (descriptor && descriptor.id !== summary.id) {
      throw new Error(
        `installed package id '${summary.id}' does not match descriptor id '${descriptor.id}'`
      )
    }
    if (!opts.official && isReservedPluginId(summary.id)) {
      throw new Error(
        `refusing to register reserved plugin id '${summary.id}' without official verification`
      )
    }

    this.destroyPluginInstances(summary.id)
    this.clearTerminalRoutes(summary.id)
    this.descriptors.delete(summary.id)
    if (descriptor) this.registerDescriptor(descriptor, opts)
    this.installedPackages.set(summary.id, {
      id: summary.id,
      requires: [...summary.requires],
      ...(summary.provenance ? { provenance: summary.provenance } : {}),
      ...(summary.warning ? { warning: summary.warning } : {}),
    })
  }

  /**
   * Flatten validated Manifest v2 contribution metadata for Host discovery.
   * This is the issue 01 seam; issue 14 consumes this catalog for instance
   * creation and owns placement, mounting, and lifecycle. This method does not
   * create or reuse runtime views.
   */
  listViewContributions(): PluginViewLaunchDescriptor[] {
    return [...this.descriptors.values()].flatMap((descriptor) => descriptor.views ?? [])
  }

  /**
   * Scan an installed-plugins root and register a descriptor for every valid
   * plugin found. A directory with an invalid manifest is skipped and returned
   * in `errors` rather than aborting the scan. The returned activation catalog
   * contains only validated, trusted package contributions whose optional frontend
   * registration succeeded; `loaded` retains its descriptor-only meaning.
   */
  loadInstalledPlugins(
    root: string,
    source?:
      | { provenance: 'official-registry'; trust: InstalledRegistryTrustContext }
      | { provenance: 'developer-local-unpacked' },
    includePluginIds?: ReadonlySet<string>
  ): {
    loaded: string[]
    errors: string[]
    activationCatalog: PluginActivationCatalogEntry[]
  } {
    const loaded: string[] = []
    const errors: string[] = []
    const approved: Array<{
      scanned: ReturnType<typeof scanInstalledPlugins>[number]
      pluginId: string
      packageSummary: InstalledPluginPackageSummary
      opts: { official?: boolean }
    }> = []

    for (const scanned of scanInstalledPlugins(root)) {
      if (scanned.error) {
        errors.push(`${scanned.dir}: ${scanned.error}`)
        continue
      }
      const pluginId = scanned.activation?.pluginId ?? scanned.descriptor?.id
      if (pluginId === undefined || scanned.packageSummary === undefined) continue
      if (includePluginIds && !includePluginIds.has(pluginId)) continue

      const isV2 = scanned.activation !== undefined
      if (source?.provenance === 'official-registry') {
        if (isReservedPluginId(pluginId) && !hasOfficialRegistryAuthority(source.trust)) {
          errors.push(
            `${scanned.dir}: reserved plugin id '${pluginId}' requires the App-authorized Official Registry`
          )
          continue
        }
        const decision = verifyInstalledRegistryPackage(scanned.dir, pluginId, source.trust)
        if (decision.action === 'quarantine') {
          errors.push(`${scanned.dir}: quarantined: ${decision.reason ?? 'trust verification failed'}`)
          continue
        }
        scanned.packageSummary.provenance = 'official-registry'
        if (scanned.activation) {
          scanned.activation.provenance = 'official-registry'
          scanned.activation.artifactDigest = decision.artifactDigest
        }
      } else if (source?.provenance === 'developer-local-unpacked') {
        if (isReservedPluginId(pluginId)) {
          errors.push(
            `${scanned.dir}: Developer Mode cannot claim reserved plugin id '${pluginId}'`
          )
          continue
        }
        scanned.packageSummary.provenance = 'developer-local-unpacked'
        scanned.packageSummary.warning = 'Unsigned local unpacked plugin — Developer Mode only'
        if (scanned.activation) scanned.activation.provenance = 'developer-local-unpacked'
      } else if (isV2) {
        errors.push(`${scanned.dir}: Registry trust context is required for Manifest v2`)
        continue
      }

      // Reserved backend-only packages must pass the same receipt gate as view
      // packages before any contribution can enter the activation catalog.
      let opts: { official?: boolean } = {}
      if (isReservedPluginId(pluginId)) {
        if (source?.provenance === 'official-registry') {
          if (hasOfficialRegistryAuthority(source.trust)) {
            opts = { official: true }
          } else {
            errors.push(
              `${scanned.dir}: reserved plugin id '${pluginId}' requires the App-authorized Official Registry`
            )
            continue
          }
        } else {
          const check = verifyOfficialInstall(scanned.dir, pluginId, resolveOfficialPublisherKey())
          if (!check.ok) {
            errors.push(`${scanned.dir}: ${check.reason}`)
            continue
          }
          opts = { official: true }
        }
      }
      approved.push({ scanned, pluginId, packageSummary: scanned.packageSummary, opts })
    }

    // A plugin identity may be supplied by either a legacy descriptor or a v2
    // activation. Reject duplicates before registering either contribution so
    // a v1 frontend cannot combine with a v2 backend from another directory.
    const packageGroups = new Map<string, typeof approved>()
    for (const entry of approved) {
      const group = packageGroups.get(entry.pluginId) ?? []
      group.push(entry)
      packageGroups.set(entry.pluginId, group)
    }
    const uniqueApproved: typeof approved = []
    for (const [pluginId, entries] of packageGroups) {
      if (entries.length === 1) {
        uniqueApproved.push(entries[0])
        continue
      }
      const directories = entries.map(({ scanned }) => scanned.dir).join(', ')
      errors.push(`${pluginId}: duplicate plugin packages found in ${directories}`)
    }

    const activations = uniqueApproved.flatMap(({ scanned }) =>
      scanned.activation ? [scanned.activation] : []
    )
    let activationCatalog = buildActivationCatalog(activations)

    for (const { scanned, packageSummary, opts } of uniqueApproved) {
      try {
        this.registerInstalledPackage(packageSummary, scanned.descriptor, opts)
        if (scanned.descriptor) loaded.push(scanned.descriptor.id)
      } catch (err) {
        errors.push(`${scanned.dir}: ${err instanceof Error ? err.message : String(err)}`)
        if (scanned.activation) {
          activationCatalog = activationCatalog.filter((entry) => entry !== scanned.activation)
        }
      }
    }
    return { loaded, errors, activationCatalog }
  }

  /** Re-evaluate installed Registry packages after a root-signed trust/blocklist
   * refresh. A quarantine only stops/unregisters frontend state; it never
   * deletes the retained package evidence. A future backend supervisor must
   * consume these same decisions before spawn and when trust changes. */
  refreshInstalledPluginTrust(
    root: string,
    trust: InstalledRegistryTrustContext,
    includePluginIds?: ReadonlySet<string>
  ): Array<{ pluginId: string; action: 'allow' | 'quarantine'; reason?: string }> {
    const decisions: Array<{
      pluginId: string
      action: 'allow' | 'quarantine'
      reason?: string
    }> = []
    for (const scanned of scanInstalledPlugins(root)) {
      const pluginId = scanned.activation?.pluginId ?? scanned.descriptor?.id
      if (!pluginId) continue
      if (includePluginIds && !includePluginIds.has(pluginId)) continue
      const decision = verifyInstalledRegistryPackage(scanned.dir, pluginId, trust)
      if (
        decision.action === 'allow' &&
        isReservedPluginId(pluginId) &&
        !hasOfficialRegistryAuthority(trust)
      ) {
        decisions.push({
          pluginId,
          action: 'quarantine',
          reason: 'reserved plugin id requires the App-authorized Official Registry',
        })
        this.destroyPluginInstances(pluginId)
        this.clearTerminalRoutes(pluginId)
        this.installedPackages.delete(pluginId)
        this.descriptors.delete(pluginId)
        const fallback = this.builtinFallbacks.get(pluginId)
        if (fallback) this.registerDescriptor(fallback, { builtin: true })
        continue
      }
      decisions.push({ pluginId, ...decision })
      if (decision.action === 'quarantine') {
        this.destroyPluginInstances(pluginId)
        this.clearTerminalRoutes(pluginId)
        this.installedPackages.delete(pluginId)
        this.descriptors.delete(pluginId)
        const fallback = this.builtinFallbacks.get(pluginId)
        if (fallback) this.registerDescriptor(fallback, { builtin: true })
      }
    }
    return decisions
  }

  /** Stop a plugin's live frontend runtime without unregistering its package.
   * Destructive package-owned cleanup must use this phase before touching
   * storage, while leaving the package registered so a failed cleanup can be
   * retried. */
  preparePluginRemoval(id: string): void {
    this.destroyPluginInstances(id)
    this.clearTerminalRoutes(id)
  }

  /** Unregister a descriptor and tear down its view if it is open. Used by the
   *  remove/update flow so a removed plugin's window does not linger. Removing
   *  a marketplace override of a bundled builtin re-registers the bundled copy
   *  (recorded by {@link registerBuiltin}) so the surface keeps working. */
  removeInstalledPlugin(id: string): void {
    this.preparePluginRemoval(id)
    this.installedPackages.delete(id)
    this.descriptors.delete(id)
    const fallback = this.builtinFallbacks.get(id)
    if (fallback) this.registerDescriptor(fallback, { builtin: true })
  }

  /** Push an event to a plugin view (fed by the backend server-push fan-out
   *  in {@link dispatchEvent}). */
  private emitToInstance(instanceId: string, type: string, data: unknown): void {
    const plugin = this.running.get(instanceId)
    if (plugin && !plugin.view.webContents.isDestroyed()) {
      plugin.view.webContents.send(IPC_EVENT, { type, data })
    }
  }

  /** Emit to one exact Host instance when the id is an instance id; otherwise
   *  resolve the legacy plugin-id adapter and emit to its sole v1 view. This is
   *  intentionally not a broadcast API for v2 packages. */
  emit(instanceOrPluginId: string, type: string, data: unknown): void {
    const direct = this.resolveInstance(instanceOrPluginId)
    if (direct) {
      this.emitToInstance(direct.instanceId, type, data)
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
 *  open params (`filepath`/`file_ws`/`line`/`sidebar`/`diff_*`/`branch_diff_*`)
 *  EditorWindowApp also reads from the search string, and the current `theme`
 *  id so the plugin paints with the app theme before its first settings
 *  reconcile (zero-flash; see plugins/mini-ide/mount.ts). A theme change alone
 *  never reloads a running view — open() only compares `workspace_path`, which
 *  is also why `file_ws` (an out-of-workspace file's own root) rides along as
 *  an ordinary param instead of altering the workspace. */
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
 *  history: 1100x760, hidden title bar, #0d1117). The window's own webContents
 *  stays blank — the plugin view carries the UI, so no preload/webPreferences
 *  are needed here. The bare feature name is only the pre-load title; once the
 *  view reports a page title, `mirrorTitle` replaces it with
 *  `<file> — Mini-IDE`. */
function ensureMiniIdeWindow(): BrowserWindow {
  if (miniIdeWindow && !miniIdeWindow.isDestroyed()) return miniIdeWindow
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Mini-IDE',
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
    requires: [...MINI_IDE_PLUGIN_REQUIRES],
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
    // The window is this plugin's alone, so it wears the plugin's page title.
    { closeHostOnHide: true, mirrorTitle: true }
  )
  return true
}

/** Id of the Plans extension (the plan review surface). */
export const PLANS_PLUGIN_ID = 'navide.plans'

/** Directory of the bundled Plans copy: `resources/plugins/plans` inside the
 *  app package (shipped via electron-builder `extraResources`), or the local
 *  `dist-plugins/plans` build output when running unpackaged. Mirrors
 *  {@link bundledMiniIdeDir}. */
export function bundledPlansDir(source: BundledMiniIdeSource): string {
  return source.isPackaged
    ? join(source.resourcesPath, 'plugins', 'plans')
    : join(source.devRoot ?? join(__dirname, '../..'), 'dist-plugins', 'plans')
}

/**
 * Register the app-bundled Plans surface as a builtin descriptor at startup,
 * mirroring {@link registerBundledMiniIde} exactly (same precedence order and
 * fail-closed validation). Never throws: a missing dir, invalid manifest,
 * spoofed id, or missing entry file returns `registered: false` with a reason
 * (caller logs), so a corrupt bundle degrades instead of crashing startup.
 */
export function registerBundledPlans(
  manager: FrontendPluginManager,
  source: BundledMiniIdeSource
): { registered: boolean; reason?: string } {
  const dir = bundledPlansDir(source)
  const scanned = loadPluginDir(dir)
  if (!scanned.descriptor) {
    return { registered: false, reason: `${dir}: ${scanned.error ?? 'invalid plugin dir'}` }
  }
  if (scanned.descriptor.id !== PLANS_PLUGIN_ID) {
    return {
      registered: false,
      reason: `${dir}: manifest id '${scanned.descriptor.id}' is not '${PLANS_PLUGIN_ID}'`,
    }
  }
  if (!existsSync(scanned.descriptor.entryFile)) {
    return { registered: false, reason: `${dir}: entry file missing (${scanned.descriptor.entryFile})` }
  }
  manager.registerBuiltin(scanned.descriptor)
  return { registered: true }
}

/** Build the entry query PlanWindowApp reads from `window.location.search`:
 *  `workspace_path`, the backend `http_url` (resolved by the plans
 *  capabilityBackend shim), the optional `rel_path` of a plan to auto-open, and
 *  the current `theme` id so the plugin paints with the app theme before its
 *  first settings reconcile (zero-flash; see plugins/plans/mount.ts). */
function plansQuery(workspacePath: string, httpUrl: string, relPath: string, theme: string): string {
  const params = new URLSearchParams()
  if (workspacePath) params.set('workspace_path', workspacePath)
  if (httpUrl) params.set('http_url', httpUrl)
  if (relPath) params.set('rel_path', relPath)
  if (theme) params.set('theme', theme)
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
    requires: [...PLANS_PLUGIN_REQUIRES],
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
  relPath = '',
  theme = ''
): boolean {
  const base = frontendPluginManager.getDescriptor(PLANS_PLUGIN_ID)
  if (!base) return false
  frontendPluginManager.open(
    hostWindow,
    { ...base, query: plansQuery(workspacePath, httpUrl, relPath, theme) },
    {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    }
  )
  return true
}

/** Id of the Git extension (the standalone Git client surface). */
export const GIT_PLUGIN_ID = 'navide.git'

/** Legacy Git bundle retained as an explicit rollback artifact. It is no
 *  longer selected by the production composition, but remains buildable and
 *  available until the next migration issue removes it. */
export function bundledGitDir(source: BundledMiniIdeSource): string {
  return source.isPackaged
    ? join(source.resourcesPath, 'plugins', 'git')
    : join(source.devRoot ?? join(__dirname, '../..'), 'dist-plugins', 'git')
}

/** Active production Manifest v2 package directory. */
export function bundledGitV2Dir(source: BundledMiniIdeSource): string {
  return source.isPackaged
    ? join(source.resourcesPath, 'plugins', 'navide-git')
    : join(source.devRoot ?? join(__dirname, '../..'), 'dist-plugins', 'navide-git')
}

function registerScannedGitV2(
  manager: FrontendPluginManager,
  dir: string
): { registered: boolean; reason?: string } {
  const scanned = loadPluginDir(dir)
  if (!scanned.descriptor) {
    return { registered: false, reason: `${dir}: ${scanned.error ?? 'invalid plugin dir'}` }
  }
  if (
    scanned.descriptor.id !== GIT_PLUGIN_ID ||
    !nonEmptyString(scanned.descriptor.packageVersion) ||
    scanned.descriptor.capabilityPolicy?.kind !== 'manifest-v2'
  ) {
    return { registered: false, reason: `${dir}: not a canonical Git Manifest v2 package` }
  }
  const keys = new Set(scanned.descriptor.views?.map((view) => view.contributionKey) ?? [])
  for (const key of [`${GIT_PLUGIN_ID}.left`, `${GIT_PLUGIN_ID}.window`]) {
    if (!keys.has(key)) return { registered: false, reason: `${dir}: missing view '${key}'` }
  }
  for (const view of scanned.descriptor.views ?? []) {
    if (!existsSync(view.entryFile)) {
      return { registered: false, reason: `${dir}: entry file missing (${view.entryFile})` }
    }
  }
  manager.registerBuiltin(scanned.descriptor)
  return { registered: true }
}

/**
 * Register the app-bundled Git surface as a builtin descriptor at startup,
 * mirroring {@link registerBundledPlans} exactly (same precedence order and
 * fail-closed validation). Never throws: a missing dir, invalid manifest,
 * spoofed id, or missing entry file returns `registered: false` with a reason
 * (caller logs), so a corrupt bundle degrades instead of crashing startup.
 */
export function registerBundledGit(
  manager: FrontendPluginManager,
  source: BundledMiniIdeSource
): { registered: boolean; reason?: string } {
  const v2 = registerScannedGitV2(manager, bundledGitV2Dir(source))
  if (v2.registered) return v2
  // An installed, Host-approved package may already own this id. Its
  // descriptor remains authoritative when the bundled copy is unavailable.
  if (manager.getDescriptor(GIT_PLUGIN_ID)) return { registered: true }
  // Keep the independently built legacy bundle as a recoverable startup
  // fallback. A malformed or missing v2 package must not erase the user's Git
  // surface; normal startup still selects v2 whenever its complete descriptor
  // validates.
  const legacy = registerLegacyBundledGit(manager, source)
  return legacy.registered ? { registered: true } : v2
}

/** Explicit rollback registration for diagnostics and recovery tooling. The
 *  normal Host startup prefers v2; this path replaces live v2 instances only
 *  when recovery is explicitly requested. */
export function registerLegacyBundledGit(
  manager: FrontendPluginManager,
  source: BundledMiniIdeSource
): { registered: boolean; reason?: string } {
  const dir = bundledGitDir(source)
  const scanned = loadPluginDir(dir)
  if (!scanned.descriptor || scanned.descriptor.id !== GIT_PLUGIN_ID) {
    return { registered: false, reason: `${dir}: legacy Git bundle unavailable` }
  }
  if (!existsSync(scanned.descriptor.entryFile)) {
    return { registered: false, reason: `${dir}: entry file missing (${scanned.descriptor.entryFile})` }
  }
  manager.replaceBuiltinForRecovery(scanned.descriptor)
  return { registered: true }
}

/** Build the entry query GitWindowApp reads from `window.location.search`:
 *  `workspace_path`, the backend `http_url` (resolved by the Git package's
 *  capability backend), the current `theme` id so the plugin paints with the
 *  app theme before its first settings reconcile (zero-flash; see
 *  plugins/navide-git/src/mount.ts), plus `extraParams` forwarding an optional diff target
 *  (`git_diff_filepath`/`git_diff_staged`/`git_diff_commit`) GitWindowApp reads
 *  to show a file diff in its own panel instead of the mini-IDE. */
function gitQuery(
  workspacePath: string,
  httpUrl: string,
  theme: string,
  extraParams: Record<string, string> = {},
  v2 = true,
  contribution: 'left' | 'window' = 'window',
): string {
  const params = new URLSearchParams()
  if (workspacePath) params.set('workspace_path', workspacePath)
  if (httpUrl) params.set('http_url', httpUrl)
  for (const [key, value] of Object.entries(extraParams)) {
    if (value) params.set(key, value)
  }
  if (v2) params.set('v2', '1')
  if (v2) params.set('contribution', contribution)
  if (theme) params.set('theme', theme)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Dev-only Git descriptor pointing at the LOCAL Manifest v2 build output
 * (`dist-plugins/navide-git/`, produced by `pnpm run build:git:v2`). Registered at
 * startup only under `AGENT_TEAM_PLUGIN_DEV=1`, mirroring
 * {@link devPlansPluginDescriptor}. The bundle is built separately
 * (plugins/navide-git/vite.config.ts) with the package-local capability
 * backend, so it
 * is not served by the electron-vite dev server: `devUrl` is empty and it
 * always loadFiles. The packaged Manifest v2 permissions are the source of the
 * system grant; the Host adds the official package's authenticated workspace
 * binding at open time.
 */
export function devGitPluginDescriptor(): PluginLaunchDescriptor {
  const dir = join(__dirname, '../../dist-plugins/navide-git')
  const scanned = loadPluginDir(dir)
  if (scanned.descriptor) return scanned.descriptor
  return {
    id: GIT_PLUGIN_ID,
    packageVersion: '0.0.0-dev',
    requires: [],
    capabilityPolicy: {
      kind: 'manifest-v2',
      system: ['fs', 'ui', 'aiCli'],
      shell: 'allowlist',
      grants: [],
    },
    devUrl: '',
    entryFile: join(dir, 'frontend/window/index.html'),
    views: [
      {
        id: 'left',
        contributionKey: `${GIT_PLUGIN_ID}.left`,
        kind: 'custom',
        location: 'left',
        title: 'Git',
        entryFile: join(dir, 'frontend/left/index.html'),
      },
      {
        id: 'window',
        contributionKey: `${GIT_PLUGIN_ID}.window`,
        kind: 'custom',
        location: 'window',
        title: 'Git',
        entryFile: join(dir, 'frontend/window/index.html'),
      },
    ],
  }
}

/** The dedicated Git host window (one at a time, recreated after close). The
 *  plugin WebContentsView fills its content bounds; the main window is never
 *  overlaid. Mirrors {@link ensureMiniIdeWindow} — the standalone SourceTree-
 *  style Git client lives in its own window, wider (1280x820) than the editor. */
let gitWindow: BrowserWindow | null = null
let gitWindowViewInstanceId: string | null = null
const gitLeftViews = new Map<number, PluginViewHandle>()
const gitLeftViewHostCleanup = new Map<number, () => void>()

type GitLeftViewResult = { ok: boolean; fallback?: 'legacy' }

function clearGitLeftView(hostWindow: BrowserWindow): void {
  const handle = gitLeftViews.get(hostWindow.id)
  if (handle) frontendPluginManager.destroyInstance(handle.instanceId)
  gitLeftViews.delete(hostWindow.id)
  gitLeftViewHostCleanup.get(hostWindow.id)?.()
  gitLeftViewHostCleanup.delete(hostWindow.id)
}

function ensureGitWindow(): BrowserWindow {
  if (gitWindow && !gitWindow.isDestroyed()) return gitWindow
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Git',
    titleBarStyle: 'hidden',
    backgroundColor: '#0d1117',
  })
  gitWindow = win
  win.on('closed', () => {
    if (gitWindow === win) {
      gitWindow = null
      gitWindowViewInstanceId = null
    }
  })
  return win
}

/**
 * Open the Git plugin view in its own dedicated BrowserWindow (mini-IDE
 * parity): opening never touches or covers the main window, reopening
 * restores/focuses the live window and re-points its workspace, and closing the
 * window tears the view down so the next open recreates both cleanly. Looks the
 * descriptor up in the loader registry; returns false when the Git extension is
 * not registered (the caller surfaces the fallback).
 */
export async function openGitPluginView(
  workspacePath: string,
  httpUrl = '',
  theme = '',
  extraParams: Record<string, string> = {}
): Promise<boolean> {
  const base = frontendPluginManager.getDescriptor(GIT_PLUGIN_ID)
  if (!base) return false
  const hostWindow = ensureGitWindow()
  if (base.capabilityPolicy?.kind !== 'manifest-v2' || !base.views) {
    // Explicit recovery may select the untouched V1 bundle. Keep this branch
    // isolated from the production package path: it uses the legacy adapter,
    // its original entry, and no v2 query/capability context.
    frontendPluginManager.open(
      hostWindow,
      {
        ...base,
        query: gitQuery(workspacePath, httpUrl, theme, extraParams, false),
      },
      'fill',
      { closeHostOnHide: true, mirrorTitle: true },
    )
    gitWindowViewInstanceId = null
    return true
  }
  const query = gitQuery(workspacePath, httpUrl, theme, extraParams, true, 'window')
  const currentWorkspace = gitWindowViewInstanceId
    ? frontendPluginManager.workspacePathOfInstance(gitWindowViewInstanceId)
    : null
  if (gitWindowViewInstanceId && currentWorkspace && resolve(currentWorkspace) === resolve(workspacePath)) {
    frontendPluginManager.updateViewQuery(gitWindowViewInstanceId, query)
    frontendPluginManager.activate(gitWindowViewInstanceId)
    frontendPluginManager.focusInstance(gitWindowViewInstanceId)
    return true
  }
  if (gitWindowViewInstanceId) frontendPluginManager.destroyInstance(gitWindowViewInstanceId)
  const context = frontendPluginManager.gitCapabilityContext(
    base.packageVersion ?? '0.0.0-dev',
    workspacePath,
    'git-window'
  )
  const view = base.views?.find((candidate) => candidate.contributionKey === `${GIT_PLUGIN_ID}.window`)
  if (!view) return false
  const handle = await frontendPluginManager.openView(base, view, {
    hostWindow,
    bounds: 'fill',
    query,
    closeHostOnHide: true,
    mirrorTitle: true,
    workspacePath,
    capabilityContext: context,
  })
  gitWindowViewInstanceId = handle.instanceId
  return true
}

/** Open the same active package's left contribution in a Host-owned main
 *  window. One left instance is tracked per host window; workspace changes
 *  recreate only that instance and never touch the separate Git window. */
export async function openGitLeftPluginView(
  hostWindow: BrowserWindow,
  workspacePath: string,
  bounds: PluginBounds,
  httpUrl = '',
  theme = ''
): Promise<GitLeftViewResult> {
  const base = frontendPluginManager.getDescriptor(GIT_PLUGIN_ID)
  if (!base) return { ok: false }
  if (base.capabilityPolicy?.kind !== 'manifest-v2' || !base.packageVersion || !base.views) {
    // Recovery swaps the descriptor before the renderer's next geometry tick.
    // Clear any stale v2 handle and let the main-window renderer compose the
    // retained legacy bundle in-process.
    clearGitLeftView(hostWindow)
    return { ok: true, fallback: 'legacy' }
  }
  const view = base.views?.find((candidate) => candidate.contributionKey === `${GIT_PLUGIN_ID}.left`)
  if (!view) return { ok: false }
  const existing = gitLeftViews.get(hostWindow.id)
  if (existing) {
    const existingWorkspace = frontendPluginManager.workspacePathOfInstance(existing.instanceId)
    if (existingWorkspace && resolve(existingWorkspace) === resolve(workspacePath)) {
      frontendPluginManager.setBounds(existing.instanceId, bounds)
      frontendPluginManager.updateViewQuery(existing.instanceId, gitQuery(workspacePath, httpUrl, theme, {}, true, 'left'))
      frontendPluginManager.activate(existing.instanceId)
      return { ok: true }
    }
    clearGitLeftView(hostWindow)
  }
  const handle = await frontendPluginManager.openView(base, view, {
    hostWindow,
    bounds,
    query: gitQuery(workspacePath, httpUrl, theme, {}, true, 'left'),
    workspacePath,
    capabilityContext: frontendPluginManager.gitCapabilityContext(
      base.packageVersion,
      workspacePath,
      'git-left'
    ),
  })
  gitLeftViews.set(hostWindow.id, handle)
  const onHostClosed = (): void => {
    if (gitLeftViews.get(hostWindow.id)?.instanceId !== handle.instanceId) return
    gitLeftViews.delete(hostWindow.id)
    gitLeftViewHostCleanup.delete(hostWindow.id)
  }
  hostWindow.once('closed', onHostClosed)
  gitLeftViewHostCleanup.set(hostWindow.id, () => hostWindow.removeListener('closed', onHostClosed))
  return { ok: true }
}

export function updateGitLeftPluginView(
  hostWindow: BrowserWindow,
  bounds: PluginBounds,
  visible: boolean
): GitLeftViewResult {
  const base = frontendPluginManager.getDescriptor(GIT_PLUGIN_ID)
  const isLegacy = !!base && (base.capabilityPolicy?.kind !== 'manifest-v2' || !base.packageVersion || !base.views)
  if (isLegacy) {
    clearGitLeftView(hostWindow)
    return { ok: true, fallback: 'legacy' }
  }
  const handle = gitLeftViews.get(hostWindow.id)
  if (!handle) return { ok: false }
  frontendPluginManager.setBounds(handle.instanceId, bounds)
  if (visible) frontendPluginManager.activate(handle.instanceId)
  else frontendPluginManager.deactivate(handle.instanceId)
  return { ok: true }
}

export function closeGitLeftPluginView(hostWindow: BrowserWindow): { ok: boolean } {
  const handle = gitLeftViews.get(hostWindow.id)
  const cleanup = gitLeftViewHostCleanup.get(hostWindow.id)
  if (!handle) {
    cleanup?.()
    gitLeftViewHostCleanup.delete(hostWindow.id)
    return { ok: true }
  }
  frontendPluginManager.destroyInstance(handle.instanceId)
  gitLeftViews.delete(hostWindow.id)
  cleanup?.()
  gitLeftViewHostCleanup.delete(hostWindow.id)
  return { ok: true }
}
