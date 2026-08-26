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
