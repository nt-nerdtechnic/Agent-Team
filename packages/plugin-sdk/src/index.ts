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
