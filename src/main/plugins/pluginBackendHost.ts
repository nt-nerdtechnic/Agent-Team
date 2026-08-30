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
  MAX_BACKEND_SUBSCRIPTIONS_PER_INSTANCE,
} from './pluginBackendLimits'
import { lstatSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export interface PluginBackendHostOptions {
  environment?: Readonly<Record<string, string>>
  createSupervisor?: (activation: BackendPluginLaunchSpec) => PluginBackendSupervisor
}

interface RegisteredBackend {
  activation: BackendPluginLaunchSpec
  supervisor: PluginBackendSupervisor
}

interface BoundView {
  runtime: AuthenticatedBackendRuntime
  backend: RegisteredBackend
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
  environment: Readonly<Record<string, string>>,
): PluginBackendSupervisor {
  const options: PluginBackendSupervisorOptions = {
    // The child executable is already self-contained. Supplying an explicit
    // map prevents Electron's process environment from crossing the boundary.
    environment,
    clientInfo: { name: 'navide-host', version: activation.packageVersion },
  }
  return new PluginBackendSupervisor(activation, options)
}

/**
 * Host-owned router for one package's Backend Wire child processes.
 *
 * Renderer code never receives this object. Main registers a view from its
 * sender-bound record, then addresses calls by that opaque instance id.
 */
export class PluginBackendHost {
  private readonly environment: Readonly<Record<string, string>>
  private readonly createSupervisor: (activation: BackendPluginLaunchSpec) => PluginBackendSupervisor
  private readonly backends = new Map<string, RegisteredBackend>()
  private readonly views = new Map<string, BoundView>()

  constructor(options: PluginBackendHostOptions = {}) {
    this.environment = Object.freeze({ ...(options.environment ?? {}) })
    this.createSupervisor = options.createSupervisor ?? ((activation) =>
      defaultSupervisor(activation, this.environment))
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
    const supervisor = this.createSupervisor(normalizedActivation)
    this.backends.set(key, { activation: normalizedActivation, supervisor })
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

  bindView(runtime: BackendRuntimeContext, packageDir: string): void {
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
    this.views.set(instanceId, {
      runtime: createAuthenticatedBackendRuntime(runtime),
      backend,
      calls: new Set(),
      subscriptions: new Set(),
      pendingSubscriptions: 0,
    })
  }

  unbindView(instanceId: string): void {
    const view = this.views.get(instanceId)
    if (!view) return
    this.views.delete(instanceId)
    for (const controller of view.calls) controller.abort()
    view.calls.clear()
    for (const subscription of view.subscriptions) {
      subscription.dispose('view-destroyed')
    }
    view.subscriptions.clear()
  }

  async call<Result extends JsonValue>(
    instanceId: string,
    name: string,
    args: JsonValue,
    options?: BackendPluginCallOptions,
  ): Promise<Result> {
    const view = this.views.get(instanceId)
    if (!view) throw new BackendPluginError('INVALID_RUNTIME')
    if (!view.backend.activation.approvedMethods.includes(name)) {
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
      await view.backend.supervisor.start()
      if (controller.signal.aborted) throw new BackendPluginError('USER_CANCELLED')
      if (this.views.get(instanceId) !== view) throw new BackendPluginError('INVALID_RUNTIME')
      return view.backend.supervisor.clientFor(view.runtime).call<Result>(name, args, {
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
    if (!view.backend.activation.approvedEvents.includes(event)) {
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
      await view.backend.supervisor.start()
      const current = this.views.get(instanceId)
      if (current !== view) throw new BackendPluginError('INVALID_RUNTIME')
      const subscription = view.backend.supervisor.clientFor(view.runtime).subscribe(
        [event],
        (backendEvent: BackendPluginEvent) => {
          if (backendEvent.event === event) listener(backendEvent.payload)
        },
        options,
      )
      view.pendingSubscriptions--
      view.subscriptions.add(subscription)
      void subscription.settled.then(() => view.subscriptions.delete(subscription))
      return subscription
    } catch (error) {
      view.pendingSubscriptions--
      throw error
    }
  }

  async close(): Promise<void> {
    for (const instanceId of [...this.views.keys()]) this.unbindView(instanceId)
    const supervisors = [...this.backends.values()].map(({ supervisor }) => supervisor.close())
    this.backends.clear()
    await Promise.all(supervisors)
  }
}
