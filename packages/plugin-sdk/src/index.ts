import type {
  Disposable,
  JsonValue,
  Params,
  Payload,
  PluginErrorCode,
  PublicEvent,
  PublicMethod,
  Result,
  StorageGetResult,
  StoragePartitionScope,
} from '@navide/plugin-contracts'
import { PluginError } from '@navide/plugin-contracts'

export { PluginError } from '@navide/plugin-contracts'
export type {
  Disposable,
  JsonValue,
  Params,
  Payload,
  PluginErrorCode,
  PublicEvent,
  PublicMethod,
  Result,
  StorageGetResult,
  StoragePartitionScope,
} from '@navide/plugin-contracts'

export interface WorkspaceTarget {
  readonly path: string
  readonly kind: 'file' | 'directory'
}

export interface PluginAppearanceSnapshot {
  readonly locale: string
  readonly colorScheme: 'light' | 'dark'
  readonly themeId: string
  readonly uiScale: number
}

export interface PluginCredentialAccount {
  readonly id: string
  readonly provider: 'github' | 'gitlab' | 'other'
  readonly host: string
  readonly label: string
}

export interface PluginWorkspaceGrant {
  readonly grantId: string
  readonly path: string
}

export interface PluginContext {
  readonly pluginId: string
  readonly packageVersion: string
  readonly contributionKey: string
  readonly instanceId: string
  readonly workspaceId: string
  readonly startupDeadlineMs: number
  readonly capabilities: {
    invoke<M extends PublicMethod>(method: M, params: Params<M>): Promise<Result<M>>
  }
  readonly events: {
    subscribe<E extends PublicEvent>(
      event: E,
      listener: (payload: Payload<E>) => void
    ): Disposable
  }
  readonly lifecycle: {
    reportProgress(message: string): void
  }
  readonly view: {
    hide(): Promise<void>
    openContribution(contributionKey: string): Promise<void>
    setBadge(value: string | number | null): Promise<void>
  }
  readonly appearance: {
    current(): PluginAppearanceSnapshot
    subscribe(listener: (snapshot: PluginAppearanceSnapshot) => void): Disposable
  }
  readonly credentials: {
    listAccounts(): Promise<readonly PluginCredentialAccount[]>
    workspaceBinding(): Promise<string | null>
    openAccountSettings(): Promise<void>
  }
  readonly ui: {
    pickWorkspace(): Promise<PluginWorkspaceGrant | null>
    openWorkspace(grant: PluginWorkspaceGrant): Promise<void>
    revealInWorkspace(path: string): Promise<void>
    openTextPreview(title: string, content: string): Promise<void>
    openSettingsSection(section: string): Promise<void>
  }
  readonly targets: {
    subscribe(listener: (target: WorkspaceTarget | null) => void): Disposable
  }
}

export interface PluginBackendCallOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface PluginBackendSubscription extends Disposable {
  /** Resolves after the Host has accepted the event subscription. */
  readonly ready: Promise<void>
  /** Rejects when the Host/backend ends the subscription unexpectedly. */
  readonly settled: Promise<void>
}

/**
 * Public package-local backend surface. The implementation is supplied by the
 * Host runtime; package code never receives IPC, stdio, HTTP, or executable
 * handles.
 */
export interface PluginBackendClient {
  call<Result extends JsonValue>(
    name: string,
    args: JsonValue,
    options?: PluginBackendCallOptions
  ): Promise<Result>
  subscribe<Payload extends JsonValue>(
    event: string,
    listener: (payload: Payload) => void
  ): PluginBackendSubscription
}

export class PluginBackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PluginBackendError'
  }
}

interface RuntimeBackendResponse {
  reqId: string
  ok: boolean
  result?: JsonValue
  error?: { code: string; message?: string }
}

interface RuntimeBackendSubscription {
  readonly ready: Promise<void>
  readonly settled: Promise<void>
  dispose(): void
}

interface RuntimeCapabilityResponse {
  reqId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message?: string }
}

interface RuntimeCapabilityBridge {
  callCapability(
    namespace: string,
    method: string,
    args?: unknown,
  ): Promise<RuntimeCapabilityResponse>
  on(type: string, listener: (payload: unknown) => void): () => void
}

export interface PluginViewRuntimeClient {
  ready(): void
  onOpenTarget(listener: (target: Record<string, string>) => void): Disposable
}

interface RuntimeViewBridge {
  ready(): void
  onOpenTarget(listener: (target: Record<string, string>) => void): () => void
}

function runtimeCapabilityBridge(): RuntimeCapabilityBridge {
  const bridge = (globalThis as unknown as { nav?: Partial<RuntimeCapabilityBridge> }).nav
  if (
    !bridge ||
    typeof bridge.callCapability !== 'function' ||
    typeof bridge.on !== 'function'
  ) {
    throw new PluginError('BACKEND_UNAVAILABLE', 'Plugin capability runtime is unavailable.')
  }
  return bridge as RuntimeCapabilityBridge
}

function runtimeViewBridge(): RuntimeViewBridge {
  const bridge = (globalThis as unknown as { nav?: Partial<RuntimeViewBridge> }).nav
  if (
    !bridge ||
    typeof bridge.ready !== 'function' ||
    typeof bridge.onOpenTarget !== 'function'
  ) {
    throw new PluginError('BACKEND_UNAVAILABLE', 'Plugin view runtime is unavailable.')
  }
  return bridge as RuntimeViewBridge
}

/** Public lifecycle/target adapter for package views. The private preload
 * transport remains an SDK implementation detail. */
export function createPluginViewRuntimeClient(): PluginViewRuntimeClient {
  return Object.freeze({
    ready(): void {
      runtimeViewBridge().ready()
    },
    onOpenTarget(listener: (target: Record<string, string>) => void): Disposable {
      if (typeof listener !== 'function') {
        throw new PluginError('INVALID_ARGUMENT', 'Plugin target listener is invalid.')
      }
      return Object.freeze({ dispose: runtimeViewBridge().onOpenTarget(listener) })
    },
  })
}

function publicMethodAddress(method: PublicMethod): { namespace: string; name: string } {
  const separator = method.indexOf('.')
  if (separator < 1 || separator === method.length - 1) {
    throw new PluginError('METHOD_NOT_FOUND', `Invalid public capability '${method}'.`)
  }
  return { namespace: method.slice(0, separator), name: method.slice(separator + 1) }
}

function publicCapabilityError(code: string): PluginErrorCode {
  switch (code) {
    case 'CAP_DENIED': return 'CAPABILITY_DENIED'
    case 'UNKNOWN': return 'METHOD_NOT_FOUND'
    case 'BAD_REQUEST': return 'INVALID_ARGUMENT'
    case 'BACKEND_ERROR': return 'BACKEND_UNAVAILABLE'
    case 'CAPABILITY_DENIED':
    case 'METHOD_NOT_FOUND':
    case 'INVALID_ARGUMENT':
    case 'WORKSPACE_SCOPE_VIOLATION':
    case 'USER_CANCELLED':
    case 'TIMEOUT':
    case 'BACKEND_UNAVAILABLE':
    case 'PLUGIN_STOPPING':
    case 'STORAGE_QUOTA_EXCEEDED':
    case 'RESOURCE_LIMIT':
    case 'INTERNAL_ERROR':
      return code
    default:
      return 'INTERNAL_ERROR'
  }
}

/**
 * Public capability/event runtime for package frontends. The private preload
 * transport is resolved inside the SDK; package code receives only the typed
 * capability and Disposable seams declared by PluginContext.
 */
export function createPluginCapabilityClient(): Pick<PluginContext, 'capabilities' | 'events'> {
  return Object.freeze({
    capabilities: Object.freeze({
      async invoke<M extends PublicMethod>(method: M, params: Params<M>): Promise<Result<M>> {
        const address = publicMethodAddress(method)
        const response = await runtimeCapabilityBridge().callCapability(
          address.namespace,
          address.name,
          params,
        )
        if (!response || typeof response.ok !== 'boolean') {
          throw new PluginError('INTERNAL_ERROR', 'Plugin capability returned an invalid response.')
        }
        if (!response.ok) {
          throw new PluginError(
            publicCapabilityError(response.error?.code ?? 'INTERNAL_ERROR'),
            response.error?.message ?? 'Plugin capability request failed.',
          )
        }
        return response.result as Result<M>
      },
    }),
    events: Object.freeze({
      subscribe<E extends PublicEvent>(
        event: E,
        listener: (payload: Payload<E>) => void,
      ): Disposable {
        if (typeof listener !== 'function') {
          throw new PluginError('INVALID_ARGUMENT', 'Plugin event listener is invalid.')
        }
        return Object.freeze({
          dispose: runtimeCapabilityBridge().on(
            event,
            listener as (payload: unknown) => void,
          ),
        })
      },
    }),
  })
}

interface RuntimeBackendBridge {
  callBackend(
    reqId: string,
    name: string,
    args: JsonValue,
    timeoutMs?: number,
  ): Promise<RuntimeBackendResponse>
  cancelBackend(reqId: string): void
  subscribeBackend(
    event: string,
    listener: (payload: JsonValue) => void,
  ): RuntimeBackendSubscription
}

function runtimeBackendBridge(): RuntimeBackendBridge {
  const bridge = (globalThis as unknown as { nav?: Partial<RuntimeBackendBridge> }).nav
  if (
    !bridge ||
    typeof bridge.callBackend !== 'function' ||
    typeof bridge.cancelBackend !== 'function' ||
    typeof bridge.subscribeBackend !== 'function'
  ) {
    throw new PluginBackendError('BACKEND_UNAVAILABLE', 'Plugin backend runtime is unavailable.')
  }
  return bridge as RuntimeBackendBridge
}

function runtimeRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new PluginBackendError('BACKEND_UNAVAILABLE', 'Plugin backend runtime is unavailable.')
  }
  return globalThis.crypto.randomUUID()
}

/** Create the runtime adapter backed by the Host-owned private preload bridge. */
export function createPluginBackendClient(): PluginBackendClient {
  return Object.freeze({
    call<Result extends JsonValue>(
      name: string,
      args: JsonValue,
      options: PluginBackendCallOptions = {},
    ): Promise<Result> {
      const bridge = runtimeBackendBridge()
      const reqId = runtimeRequestId()
      return new Promise<Result>((resolve, reject) => {
        let settled = false
        const cleanup = (): void => {
          options.signal?.removeEventListener('abort', abort)
        }
        const abort = (): void => {
          if (settled) return
          settled = true
          cleanup()
          bridge.cancelBackend(reqId)
          reject(new PluginBackendError('USER_CANCELLED', 'Plugin backend call was cancelled.'))
        }
        const settle = (action: () => void): void => {
          if (settled) return
          settled = true
          cleanup()
          action()
        }
        if (options.signal?.aborted) {
          abort()
          return
        }
        options.signal?.addEventListener('abort', abort, { once: true })
        let request: Promise<RuntimeBackendResponse>
        try {
          request = bridge.callBackend(reqId, name, args, options.timeoutMs)
        } catch (error) {
          settle(() => reject(error))
          return
        }
        void request.then((response) => {
          settle(() => {
            if (!response || response.reqId !== reqId || typeof response.ok !== 'boolean') {
              reject(new PluginBackendError('PROTOCOL_ERROR', 'Plugin backend returned an invalid response.'))
              return
            }
            if (!response.ok) {
              reject(new PluginBackendError(
                response.error?.code ?? 'BACKEND_UNAVAILABLE',
                response.error?.message ?? 'Plugin backend request failed.'
              ))
              return
            }
            resolve(response.result as Result)
          })
        }).catch((error: unknown) => {
          settle(() => reject(error))
        })
      })
    },
    subscribe<Payload extends JsonValue>(
      event: string,
      listener: (payload: Payload) => void,
    ): PluginBackendSubscription {
      if (!event || typeof listener !== 'function') {
        throw new PluginBackendError('INVALID_ARGUMENT', 'Plugin backend subscription is invalid.')
      }
      const registration = runtimeBackendBridge().subscribeBackend(
        event,
        listener as (payload: JsonValue) => void,
      )
      const asPluginBackendError = (error: unknown): PluginBackendError => {
        if (error instanceof PluginBackendError) return error
        const record = error as { code?: unknown }
        const code = typeof record?.code === 'string' ? record.code : 'BACKEND_UNAVAILABLE'
        const message = error instanceof Error
          ? error.message
          : 'Plugin backend subscription failed.'
        return new PluginBackendError(code, message)
      }
      const ready = registration.ready.catch((error: unknown) => {
        throw asPluginBackendError(error)
      })
      const settled = registration.settled.catch((error: unknown) => {
        throw asPluginBackendError(error)
      })
      return Object.freeze({ ready, settled, dispose: registration.dispose })
    },
  })
}

export interface PluginSettingsStore {
  get(key: string): Promise<JsonValue | undefined>
  set(key: string, value: JsonValue): Promise<void>
  delete(key: string): Promise<boolean>
}

export function createPluginSettingsStore(
  context: PluginContext,
  scope: StoragePartitionScope = 'plugin'
): PluginSettingsStore {
  return Object.freeze({
    async get(key: string) {
      const result = await context.capabilities.invoke('storage.get', { scope, key })
      return result.found ? result.value : undefined
    },
    async set(key: string, value: JsonValue) {
      await context.capabilities.invoke('storage.set', { scope, key, value })
    },
    delete(key: string) {
      return context.capabilities.invoke('storage.delete', { scope, key })
    },
  })
}

export interface PluginDefinition {
  readonly activate: (context: PluginContext) => void | Promise<void>
}

export function definePlugin(
  activate: (context: PluginContext) => void | Promise<void>
): PluginDefinition {
  return Object.freeze({ activate })
}
