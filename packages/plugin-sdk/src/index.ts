import type {
  Disposable,
  JsonValue,
  Params,
  Payload,
  PluginErrorCode,
  PublicEvent,
  PublicMethod,
  Result,
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
} from '@navide/plugin-contracts'

export interface WorkspaceTarget {
  readonly path: string
  readonly kind: 'file' | 'directory'
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
  }
  readonly targets: {
    subscribe(listener: (target: WorkspaceTarget | null) => void): Disposable
  }
}

export interface PluginDefinition {
  readonly activate: (context: PluginContext) => void | Promise<void>
}

export function definePlugin(
  activate: (context: PluginContext) => void | Promise<void>
): PluginDefinition {
  return Object.freeze({ activate })
}
