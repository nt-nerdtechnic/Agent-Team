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
    nonEmptyString(runtime.hostWindowId)
  )
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
  private readonly bridgeDispatcher: BackendBridgeDispatcher
  private readonly resolvePlanRoot?: PlanRootResolver
  private readonly backends = new Map<string, RegisteredBackend>()
  private readonly views = new Map<string, BoundView>()
  private reservedChildSlots = 0

  constructor(options: PluginBackendHostOptions = {}) {
    this.environment = Object.freeze({ ...(options.environment ?? {}) })
    this.bridgeDispatcher = options.bridgeDispatcher ?? createProductionPlansBridgeDispatcher()
    this.resolvePlanRoot = options.resolvePlanRoot
    this.createSupervisor = options.createSupervisor ?? defaultSupervisor
  }

  register(activation: BackendPluginLaunchSpec): void {
    const packageDir = canonicalBackendPackageDir(activation.packageDir)
    if (!packageDir) throw new BackendPluginError('INVALID_ACTIVATION')
    const key = backendKey(activation.pluginId, activation.packageVersion)
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
    const backend = this.backends.get(backendKey(runtime.pluginId, runtime.packageVersion))
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

  async unbindView(instanceId: string): Promise<void> {
    const view = this.views.get(instanceId)
    if (!view) return
    this.views.delete(instanceId)
    view.closing = true
    view.bindingController.abort()
    for (const controller of view.calls) controller.abort()
    view.calls.clear()
    for (const subscription of view.subscriptions) {
      subscription.dispose('view-destroyed')
    }
    view.subscriptions.clear()
    try {
      await view.bindingTask
    } catch {
      // A failed binding has no child to close; callers already receive it.
    }
    await view.supervisor?.close()
    this.releaseChildSlot(view)
  }

  async call<Result extends JsonValue>(
    instanceId: string,
    name: string,
    args: JsonValue,
    options?: BackendPluginCallOptions,
  ): Promise<Result> {
    const view = this.views.get(instanceId)
    if (!view) throw new BackendPluginError('INVALID_RUNTIME')
    if (!view.activation.approvedMethods.includes(name)) {
      throw new BackendPluginError('INVALID_ARGUMENT')
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
      await view.bindingTask
      if (controller.signal.aborted) throw new BackendPluginError('USER_CANCELLED')
      if (this.views.get(instanceId) !== view || view.closing || !view.supervisor) {
        throw new BackendPluginError('INVALID_RUNTIME')
      }
      await view.supervisor.start()
      if (controller.signal.aborted) throw new BackendPluginError('USER_CANCELLED')
      return view.supervisor.clientFor(view.runtime, {
        workspacePath: view.workspacePath,
        authorizedPlanRoot: view.authorizedPlanRoot.value ?? undefined,
      }).call<Result>(name, args, {
        ...options,
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
    const view = this.views.get(instanceId)
    if (!view) throw new BackendPluginError('INVALID_RUNTIME')
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
      await view.bindingTask
      if (options?.signal?.aborted) throw new BackendPluginError('USER_CANCELLED')
      if (this.views.get(instanceId) !== view || view.closing || !view.supervisor) {
        throw new BackendPluginError('INVALID_RUNTIME')
      }
      await view.supervisor.start()
      const subscription = view.supervisor.clientFor(view.runtime, {
        workspacePath: view.workspacePath,
        authorizedPlanRoot: view.authorizedPlanRoot.value ?? undefined,
      }).subscribe(
        [event],
        (backendEvent: BackendPluginEvent) => {
          if (backendEvent.event === event) listener(backendEvent.payload)
        },
        options,
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
    this.backends.clear()
  }
}
