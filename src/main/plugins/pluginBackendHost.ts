import {
  BackendPluginError,
  createAuthenticatedBackendRuntime,
  PluginBackendSupervisor,
  type AuthenticatedBackendRuntime,
  type BackendPluginCallOptions,
  type BackendPluginEvent,
  type BackendPluginLaunchSpec,
  type BackendPluginSubscription,
  type BackendPluginSubscriptionOptions,
  type BackendRuntimeContext,
  type JsonValue,
  type PluginBackendSupervisorOptions,
} from './pluginBackendSupervisor'
import {
  isAuthenticatedInitiator,
  type AuthenticatedInitiator,
} from './pluginCapabilityBroker'
import type { ExecutionPolicySnapshot } from './executionPolicy'
import {
  isAllowedBackendTimeout,
  MAX_BACKEND_CALLS_PER_INSTANCE,
  MAX_BACKEND_CHILDREN,
  MAX_BACKEND_SUBSCRIPTIONS_PER_INSTANCE,
} from './pluginBackendLimits'
import {
  createProductionPlansBridgeDispatcher,
  type BackendBridgeDispatcher,
} from './plansBridge'
import {
  canonicalExistingDirectory,
  isWorkspaceContainedPath,
} from './workspacePathPolicy'
import { lstatSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

export interface PlanRootResolverInput {
  readonly runtime: BackendRuntimeContext
  readonly workspacePath: string
  readonly signal: AbortSignal
}

export type PlanRootResolver = (input: PlanRootResolverInput) => Promise<string>

export interface PluginBackendHostOptions {
  environment?: Readonly<Record<string, string>>
  createSupervisor?: (
    activation: BackendPluginLaunchSpec,
    options: PluginBackendSupervisorOptions,
  ) => PluginBackendSupervisor
  /** Internal Host-owned Plans Bridge; never passed to renderer/SDK code. */
  bridgeDispatcher?: BackendBridgeDispatcher
  /** Resolve the Host-authorized Plans repository root for one bound view. */
  resolvePlanRoot?: PlanRootResolver
  /** Resolve the current agent policy for one Host-bound child bridge call. */
  resolveExecutionPolicy?: (
    runtime: BackendRuntimeContext,
    workspacePath?: string,
  ) => ExecutionPolicySnapshot | undefined
  /** Observe a bound child becoming unavailable before the next call. */
  onBackendFailure?: (runtime: BackendRuntimeContext, error: BackendPluginError) => void
  /** Observe child diagnostic output (stderr / startup failure diagnostics). */
  onStderr?: (chunk: string) => void
}

interface RegisteredBackend {
  activation: BackendPluginLaunchSpec
}

interface BoundView {
  runtime: AuthenticatedBackendRuntime
  workspacePath?: string
  activation: BackendPluginLaunchSpec
  supervisor?: PluginBackendSupervisor
  authorizedPlanRoot: { value: string | null }
  bindingController: AbortController
  bindingTask: Promise<void>
  closing: boolean
  closingReason?: 'view-destroyed' | 'plugin-stopping'
  slotReleased: boolean
  calls: Set<AbortController>
  subscriptions: Set<BackendPluginSubscription>
  pendingSubscriptions: number
}

function backendKey(pluginId: string, packageVersion: string): string {
  return `${pluginId}\u0000${packageVersion}`
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Resolve the package root that the Host owns for an activation or descriptor.
 * A package root must be an existing, real directory; accepting a symlink here
 * would let a later target change silently alter which descriptor is bound.
 */
export function canonicalBackendPackageDir(packageDir: unknown): string | null {
  if (!nonEmptyString(packageDir)) return null
  try {
    const resolved = resolve(packageDir)
    const entry = lstatSync(resolved)
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null
    const canonical = realpathSync(resolved)
    if (canonical !== resolved) return null
    const canonicalEntry = lstatSync(canonical)
    if (!canonicalEntry.isDirectory() || canonicalEntry.isSymbolicLink()) return null
    return canonical
  } catch {
    return null
  }
}

function isViewRuntime(runtime: BackendRuntimeContext): boolean {
  return (
    nonEmptyString(runtime.pluginId) &&
    nonEmptyString(runtime.packageVersion) &&
    nonEmptyString(runtime.workspaceId) &&
    nonEmptyString(runtime.instanceId) &&
    nonEmptyString(runtime.contributionKey) &&
    (runtime.hostWindowId === null || nonEmptyString(runtime.hostWindowId)) &&
    isAuthenticatedInitiator(runtime.initiator)
  )
}

function runtimeWithInitiator(
  runtime: AuthenticatedBackendRuntime,
  initiator: AuthenticatedInitiator | undefined,
): AuthenticatedBackendRuntime {
  if (initiator === undefined) return runtime
  if (!isAuthenticatedInitiator(initiator)) {
    throw new BackendPluginError('INVALID_RUNTIME')
  }
  const sameKindAndId =
    runtime.initiator.kind === initiator.kind &&
    runtime.initiator.id === initiator.id
  const sameAgentSource =
    runtime.initiator.kind === 'agent' &&
    initiator.kind === 'agent' &&
    runtime.initiator.source === initiator.source
  if (
    sameKindAndId &&
    (runtime.initiator.kind === 'user' || sameAgentSource)
  ) return runtime
  return createAuthenticatedBackendRuntime({ ...runtime, initiator })
}

function defaultSupervisor(
  activation: BackendPluginLaunchSpec,
  options: PluginBackendSupervisorOptions,
): PluginBackendSupervisor {
  return new PluginBackendSupervisor(activation, options)
}

/**
 * Host-owned router for one package's Backend Wire child processes.
 *
 * A registered package is only metadata. Each bound view gets its own
 * supervisor, authenticated runtime, root binding, and process slot. Renderer
 * code never receives this object or any of those Host-owned handles.
 */
export class PluginBackendHost {
  private readonly environment: Readonly<Record<string, string>>
  private readonly createSupervisor: (
    activation: BackendPluginLaunchSpec,
    options: PluginBackendSupervisorOptions,
  ) => PluginBackendSupervisor
  private bridgeDispatcher: BackendBridgeDispatcher
  private readonly resolvePlanRoot?: PlanRootResolver
  private readonly resolveExecutionPolicy?: PluginBackendHostOptions['resolveExecutionPolicy']
  private readonly onBackendFailure?: PluginBackendHostOptions['onBackendFailure']
  private readonly onStderr?: PluginBackendHostOptions['onStderr']
  private readonly backends = new Map<string, RegisteredBackend>()
  private readonly views = new Map<string, BoundView>()
  /** Package-version revocations are serialized and also act as an admission
   *  barrier while the old views and child are being drained. */
  private readonly packageRevocations = new Map<string, Promise<void>>()
  private readonly unbindTasks = new Map<
    string,
    { packageKey: string; task: Promise<void> }
  >()
  private reservedChildSlots = 0

  constructor(options: PluginBackendHostOptions = {}) {
    this.environment = Object.freeze({ ...(options.environment ?? {}) })
    this.bridgeDispatcher = options.bridgeDispatcher ?? createProductionPlansBridgeDispatcher()
    this.resolvePlanRoot = options.resolvePlanRoot
    this.resolveExecutionPolicy = options.resolveExecutionPolicy
    this.onBackendFailure = options.onBackendFailure
    this.onStderr = options.onStderr
    this.createSupervisor = options.createSupervisor ?? defaultSupervisor
  }

  /** Replace the Host-owned bridge composition before any package runtime is
   * bound. Production wiring uses this to connect the existing core
   * filesystem service; tests may keep their isolated dispatcher. */
  setBridgeDispatcher(dispatcher: BackendBridgeDispatcher): void {
    if (this.views.size > 0) {
      throw new BackendPluginError(
        'INVALID_RUNTIME',
        'Backend bridge composition cannot change while a view is bound.',
      )
    }
    this.bridgeDispatcher = dispatcher
  }

  register(activation: BackendPluginLaunchSpec): void {
    const packageDir = canonicalBackendPackageDir(activation.packageDir)
    if (!packageDir) throw new BackendPluginError('INVALID_ACTIVATION')
    const key = backendKey(activation.pluginId, activation.packageVersion)
    if (this.packageRevocations.has(key)) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    if (this.backends.has(key)) {
      throw new BackendPluginError('INVALID_ACTIVATION', 'Backend package version is already registered.')
    }
    const normalizedActivation = activation.packageDir === packageDir
      ? activation
      : { ...activation, packageDir }
    this.backends.set(key, { activation: normalizedActivation })
  }

  hasActivation(pluginId: string, packageVersion: string): boolean {
    return this.backends.has(backendKey(pluginId, packageVersion))
  }

  activationFor(
    pluginId: string,
    packageVersion: string,
    packageDir: string,
  ): BackendPluginLaunchSpec | undefined {
    const canonicalPackageDir = canonicalBackendPackageDir(packageDir)
    if (!canonicalPackageDir) return undefined
    const activation = this.backends.get(backendKey(pluginId, packageVersion))?.activation
    return activation?.packageDir === canonicalPackageDir ? activation : undefined
  }

  activationForPlugin(pluginId: string): BackendPluginLaunchSpec | undefined {
    return [...this.backends.values()].find(({ activation }) => activation.pluginId === pluginId)?.activation
  }

  /**
   * Bind a package backend to a workspace without requiring a visible view.
   * The generated instance id remains Host-private; MCP callers address this
   * binding through the Host's workspace routing seam instead.
   */
  async bindWorkspace(
    runtime: BackendRuntimeContext,
    packageDir: string,
    workspacePath: string,
  ): Promise<string> {
    if (!nonEmptyString(workspacePath)) throw new BackendPluginError('INVALID_RUNTIME')
    let instanceId = randomUUID()
    while (this.views.has(instanceId)) instanceId = randomUUID()
    const boundRuntime: BackendRuntimeContext = {
      ...runtime,
      instanceId,
      contributionKey: runtime.contributionKey ?? `${runtime.pluginId}.headless`,
      hostWindowId: runtime.hostWindowId ?? null,
    }
    await this.bindView(boundRuntime, packageDir, workspacePath)
    return instanceId
  }

  /**
   * Reserve a view synchronously, then resolve its root and create its child.
   * Synchronous input/identity errors still throw at the binding boundary;
   * asynchronous root failures are returned by the binding promise and by all
   * calls/subscriptions addressed to that view.
   */
  bindView(
    runtime: BackendRuntimeContext,
    packageDir: string,
    workspacePath?: string,
  ): Promise<void> {
    if (!isViewRuntime(runtime)) throw new BackendPluginError('INVALID_RUNTIME')
    const instanceId = runtime.instanceId
    if (!nonEmptyString(instanceId)) throw new BackendPluginError('INVALID_RUNTIME')
    const key = backendKey(runtime.pluginId, runtime.packageVersion)
    if (this.packageRevocations.has(key)) throw new BackendPluginError('PLUGIN_STOPPING')
    const backend = this.backends.get(key)
    if (!backend) throw new BackendPluginError('INVALID_RUNTIME')
    const canonicalPackageDir = canonicalBackendPackageDir(packageDir)
    if (!canonicalPackageDir || canonicalPackageDir !== backend.activation.packageDir) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    if (this.views.has(instanceId)) {
      throw new BackendPluginError('INVALID_RUNTIME', 'Backend view instance is already bound.')
    }
    if (workspacePath !== undefined && !nonEmptyString(workspacePath)) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    if (this.reservedChildSlots >= MAX_BACKEND_CHILDREN) {
      throw new BackendPluginError('RESOURCE_LIMIT', 'Backend child process limit reached.')
    }

    const view: BoundView = {
      runtime: createAuthenticatedBackendRuntime(runtime),
      ...(workspacePath === undefined ? {} : { workspacePath: resolve(workspacePath) }),
      activation: backend.activation,
      authorizedPlanRoot: { value: null },
      bindingController: new AbortController(),
      bindingTask: Promise.resolve(),
      closing: false,
      slotReleased: false,
      calls: new Set(),
      subscriptions: new Set(),
      pendingSubscriptions: 0,
    }
    this.views.set(instanceId, view)
    this.reservedChildSlots++
    view.bindingTask = this.finishBinding(view).catch((error: unknown) => {
      if (this.views.get(instanceId) === view) this.views.delete(instanceId)
      view.closing = true
      view.bindingController.abort()
      this.releaseChildSlot(view)
      throw error
    })
    return view.bindingTask
  }

  private async finishBinding(view: BoundView): Promise<void> {
    try {
      const needsFilesystem = view.activation.approvedBridgePorts?.includes('filesystem') ?? false
      if (needsFilesystem) {
        if (!view.workspacePath || !this.resolvePlanRoot) {
          throw new BackendPluginError('INVALID_RUNTIME')
        }
        const root = await this.resolvePlanRoot({
          runtime: view.runtime,
          workspacePath: view.workspacePath,
          signal: view.bindingController.signal,
        })
        if (view.bindingController.signal.aborted || view.closing) {
          throw new BackendPluginError('USER_CANCELLED')
        }
        const canonicalRoot = nonEmptyString(root) ? canonicalExistingDirectory(root) : null
        if (!canonicalRoot || !isWorkspaceContainedPath(canonicalRoot, view.workspacePath)) {
          throw new BackendPluginError('INVALID_RUNTIME', 'Plans root is outside the bound workspace.')
        }
        view.authorizedPlanRoot.value = canonicalRoot
      }

      if (view.bindingController.signal.aborted || view.closing) {
        throw new BackendPluginError('USER_CANCELLED')
      }
      const supervisorOptions: PluginBackendSupervisorOptions = {
        environment: this.environment,
        clientInfo: { name: 'navide-host', version: view.activation.packageVersion },
        bridgeDispatcher: this.bridgeDispatcher,
        authorizedPlanRoot: view.authorizedPlanRoot,
        ...(this.onStderr ? { onStderr: this.onStderr } : {}),
        ...(this.resolveExecutionPolicy
          ? { resolveExecutionPolicy: this.resolveExecutionPolicy }
          : {}),
        onFailure: (error: BackendPluginError): void => {
          if (this.views.get(view.runtime.instanceId ?? '') !== view) return
          try {
            this.onBackendFailure?.(view.runtime, error)
          } catch {
            // A liveness observer must not change the child failure result.
          }
        },
        ...(needsFilesystem && this.resolvePlanRoot && view.workspacePath !== undefined
          ? {
              refreshAuthorizedPlanRoot: (signal: AbortSignal): Promise<string> =>
                this.refreshPlanRoot(view, signal),
            }
          : {}),
      }
      view.supervisor = this.createSupervisor(view.activation, supervisorOptions)
    } catch (error) {
      if (error instanceof BackendPluginError) throw error
      throw new BackendPluginError('BACKEND_UNAVAILABLE')
    }
  }

  private async refreshPlanRoot(view: BoundView, signal: AbortSignal): Promise<string> {
    if (!this.resolvePlanRoot || !view.workspacePath) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    const root = await this.resolvePlanRoot({
      runtime: view.runtime,
      workspacePath: view.workspacePath,
      signal,
    })
    const canonicalRoot = nonEmptyString(root) ? canonicalExistingDirectory(root) : null
    if (!canonicalRoot || !isWorkspaceContainedPath(canonicalRoot, view.workspacePath)) {
      throw new BackendPluginError('INVALID_RUNTIME', 'Plans root is outside the bound workspace.')
    }
    view.authorizedPlanRoot.value = canonicalRoot
    return canonicalRoot
  }

  private releaseChildSlot(view: BoundView): void {
    if (view.slotReleased) return
    view.slotReleased = true
    this.reservedChildSlots--
  }

  async unbindView(
    instanceId: string,
    reason: 'view-destroyed' | 'plugin-stopping' = 'view-destroyed',
  ): Promise<void> {
    const existing = this.unbindTasks.get(instanceId)
    if (existing) {
      await existing.task
      return
    }
    const view = this.views.get(instanceId)
    if (!view) return
    const packageKey = backendKey(view.activation.pluginId, view.activation.packageVersion)
    const task = (async (): Promise<void> => {
      this.views.delete(instanceId)
      view.closing = true
      view.closingReason = reason
      if (reason === 'plugin-stopping') view.bindingController.abort('plugin-stopping')
      else view.bindingController.abort()
      for (const controller of view.calls) {
        if (reason === 'plugin-stopping') controller.abort('plugin-stopping')
        else controller.abort()
      }
      view.calls.clear()
      for (const subscription of view.subscriptions) {
        subscription.dispose(reason)
      }
      view.subscriptions.clear()
      try {
        await view.bindingTask
      } catch {
        // A failed binding has no child to close; callers already receive it.
      }
      await view.supervisor?.close()
      this.releaseChildSlot(view)
    })()
    this.unbindTasks.set(instanceId, { packageKey, task })
    try {
      await task
    } finally {
      if (this.unbindTasks.get(instanceId)?.task === task) this.unbindTasks.delete(instanceId)
    }
  }

  /** Revoke exactly one package-version activation. New binds are rejected as
   * soon as this method starts; existing views are drained before the selected
   * activation is removed from the Host registry. */
  async revokePackageVersion(pluginId: string, packageVersion: string): Promise<void> {
    const key = backendKey(pluginId, packageVersion)
    const existing = this.packageRevocations.get(key)
    if (existing) {
      await existing
      return
    }
    const task = Promise.resolve().then(async () => {
      const instances = [...this.views.entries()]
        .filter(([, view]) =>
          view.activation.pluginId === pluginId && view.activation.packageVersion === packageVersion,
        )
        .map(([instanceId]) => instanceId)
      const draining = [...this.unbindTasks.values()]
        .filter(({ packageKey }) => packageKey === key)
        .map(({ task }) => task)
      await Promise.all([
        ...instances.map((instanceId) => this.unbindView(instanceId, 'plugin-stopping')),
        ...draining,
      ])
      this.backends.delete(key)
    })
    this.packageRevocations.set(key, task)
    let completed = false
    try {
      await task
      completed = true
    } finally {
      // A failed drain cannot prove that the old child is gone. Retain its
      // admission barrier until process teardown rather than allowing respawn.
      if (completed && this.packageRevocations.get(key) === task) this.packageRevocations.delete(key)
    }
  }

  async call<Result extends JsonValue>(
    instanceId: string,
    name: string,
    args: JsonValue,
    options?: BackendPluginCallOptions,
  ): Promise<Result> {
    const unbinding = this.unbindTasks.get(instanceId)
    if (unbinding && this.packageRevocations.has(unbinding.packageKey)) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    const view = this.views.get(instanceId)
    if (!view) throw new BackendPluginError('INVALID_RUNTIME')
    if (this.packageRevocations.has(backendKey(view.activation.pluginId, view.activation.packageVersion))) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    if (!view.activation.approvedMethods.includes(name)) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    const initiator = options?.initiator ?? view.runtime.initiator
    if (initiator.kind === 'agent' && !view.activation.agentMethods?.includes(name)) {
      throw new BackendPluginError('CAPABILITY_DENIED')
    }
    if (options?.timeoutMs !== undefined && !isAllowedBackendTimeout(options.timeoutMs)) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    if (view.calls.size >= MAX_BACKEND_CALLS_PER_INSTANCE) {
      throw new BackendPluginError('RESOURCE_LIMIT')
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (options?.signal?.aborted) controller.abort()
    else options?.signal?.addEventListener('abort', abort, { once: true })
    view.calls.add(controller)
    try {
      const runtime = runtimeWithInitiator(view.runtime, options?.initiator)
      const supervisorOptions: BackendPluginCallOptions = { ...options }
      delete supervisorOptions.initiator
      try {
        await view.bindingTask
      } catch (error) {
        if (view.closingReason === 'plugin-stopping') {
          throw new BackendPluginError('PLUGIN_STOPPING')
        }
        throw error
      }
      if (controller.signal.aborted) {
        throw new BackendPluginError(
          controller.signal.reason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'USER_CANCELLED',
        )
      }
      if (this.views.get(instanceId) !== view || view.closing || !view.supervisor) {
        throw new BackendPluginError(
          view.closingReason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'INVALID_RUNTIME',
        )
      }
      await view.supervisor.start()
      if (controller.signal.aborted) {
        throw new BackendPluginError(
          controller.signal.reason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'USER_CANCELLED',
        )
      }
      return view.supervisor.clientFor(runtime, {
        workspacePath: view.workspacePath,
        authorizedPlanRoot: view.authorizedPlanRoot.value ?? undefined,
      }).call<Result>(name, args, {
        ...supervisorOptions,
        signal: controller.signal,
      })
    } finally {
      options?.signal?.removeEventListener('abort', abort)
      view.calls.delete(controller)
    }
  }

  async subscribe(
    instanceId: string,
    event: string,
    listener: (payload: JsonValue) => void,
    options?: BackendPluginSubscriptionOptions,
  ): Promise<BackendPluginSubscription> {
    const unbinding = this.unbindTasks.get(instanceId)
    if (unbinding && this.packageRevocations.has(unbinding.packageKey)) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    const view = this.views.get(instanceId)
    if (!view) throw new BackendPluginError('INVALID_RUNTIME')
    if (this.packageRevocations.has(backendKey(view.activation.pluginId, view.activation.packageVersion))) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    if (!view.activation.approvedEvents.includes(event)) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    if (options?.timeoutMs !== undefined && !isAllowedBackendTimeout(options.timeoutMs)) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    if (view.subscriptions.size + view.pendingSubscriptions >= MAX_BACKEND_SUBSCRIPTIONS_PER_INSTANCE) {
      throw new BackendPluginError('RESOURCE_LIMIT')
    }
    view.pendingSubscriptions++
    try {
      const runtime = runtimeWithInitiator(view.runtime, options?.initiator)
      const supervisorOptions: BackendPluginSubscriptionOptions = { ...options }
      delete supervisorOptions.initiator
      try {
        await view.bindingTask
      } catch (error) {
        if (view.closingReason === 'plugin-stopping') {
          throw new BackendPluginError('PLUGIN_STOPPING')
        }
        throw error
      }
      if (options?.signal?.aborted) {
        throw new BackendPluginError(
          options.signal.reason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'USER_CANCELLED',
        )
      }
      if (this.views.get(instanceId) !== view || view.closing || !view.supervisor) {
        throw new BackendPluginError(
          view.closingReason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'INVALID_RUNTIME',
        )
      }
      await view.supervisor.start()
      const subscription = view.supervisor.clientFor(runtime, {
        workspacePath: view.workspacePath,
        authorizedPlanRoot: view.authorizedPlanRoot.value ?? undefined,
      }).subscribe(
        [event],
        (backendEvent: BackendPluginEvent) => {
          if (backendEvent.event === event) listener(backendEvent.payload)
        },
        supervisorOptions,
      )
      view.subscriptions.add(subscription)
      void subscription.settled.then(() => view.subscriptions.delete(subscription))
      return subscription
    } finally {
      view.pendingSubscriptions--
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.views.keys()].map((instanceId) => this.unbindView(instanceId)))
    await Promise.all([...this.unbindTasks.values()].map(({ task }) => task))
    await Promise.all([...this.packageRevocations.values()])
    this.backends.clear()
  }
}
