import {
  createAiCliSessionController,
  type AiCliSessionController,
} from '@navide/plugin-ui'
import {
  createPluginCapabilityClient,
  createPluginBackendClient,
  createPluginViewRuntimeClient,
  PluginBackendError,
  type JsonValue,
  type PublicMethod,
  type Params,
} from '@navide/plugin-sdk'

export const plansBackend = createPluginBackendClient()
export const plansViewRuntime = createPluginViewRuntimeClient()
const pluginCapabilities = createPluginCapabilityClient()

export async function callCapability(
  namespace: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return pluginCapabilities.capabilities.invoke(
    `${namespace}.${method}` as PublicMethod,
    args as Params<PublicMethod>,
  )
}

export function subscribeHostEvent(
  type: string,
  listener: (payload: unknown) => void,
): () => void {
  const subscription = pluginCapabilities.events.subscribe(
    type as Parameters<typeof pluginCapabilities.events.subscribe>[0],
    listener as Parameters<typeof pluginCapabilities.events.subscribe>[1],
  )
  return () => subscription.dispose()
}

export function createPlansAiCliController(): AiCliSessionController {
  return createAiCliSessionController({
    capabilities: pluginCapabilities.capabilities,
    events: pluginCapabilities.events,
  })
}

export async function getWorkspacePreference(key: string): Promise<JsonValue | undefined> {
  const result = await callCapability('storage', 'get', { scope: 'workspace', key }) as {
    found?: unknown
    value?: JsonValue
  }
  return result?.found === true ? result.value : undefined
}

export async function setWorkspacePreference(key: string, value: JsonValue): Promise<void> {
  await callCapability('storage', 'set', { scope: 'workspace', key, value })
}

export const KNOWN_BACKEND_ERROR_KEYS = {
  // Renderer-facing codes from Host / Supervisor
  BACKEND_ERROR: 'pane.plans.v2.errors.backend-error',
  BACKEND_UNAVAILABLE: 'pane.plans.v2.errors.backend-unavailable',
  INVALID_ARGUMENT: 'pane.plans.v2.errors.invalid-argument',
  INVALID_ACTIVATION: 'pane.plans.v2.errors.invalid-activation',
  INVALID_RUNTIME: 'pane.plans.v2.errors.invalid-runtime',
  CAPABILITY_DENIED: 'pane.plans.v2.errors.capability-denied',
  RESOURCE_LIMIT: 'pane.plans.v2.errors.resource-limit',
  NOT_READY: 'pane.plans.v2.errors.not-ready',
  TIMEOUT: 'pane.plans.v2.errors.timeout',
  PLUGIN_STOPPING: 'pane.plans.v2.errors.plugin-stopping',
  USER_CANCELLED: 'pane.plans.v2.errors.user-cancelled',
  PROTOCOL_ERROR: 'pane.plans.v2.errors.protocol-error',
  WORKSPACE_SCOPE_VIOLATION: 'pane.plans.v2.errors.workspace-scope-violation',
  // Compatibility child codes if unprojected
  CONFLICT: 'pane.plans.v2.errors.conflict',
  INTERNAL_ERROR: 'pane.plans.v2.errors.internal-error',
  PLUGIN_ERROR: 'pane.plans.v2.errors.plugin-error',
} as const

export interface BackendErrorMessageI18n {
  t: (key: string, values?: Record<string, unknown>) => string
  te: (key: string) => boolean
}

export function backendErrorMessage(
  error: unknown,
  i18n?: BackendErrorMessageI18n,
): string {
  if (error instanceof PluginBackendError) {
    if (i18n) {
      const key = KNOWN_BACKEND_ERROR_KEYS[error.code as keyof typeof KNOWN_BACKEND_ERROR_KEYS]
      if (key && i18n.te(key)) {
        const translated = i18n.t(key)
        if (translated && translated !== key) return translated
      }
      const genericKey = 'pane.plans.v2.errors.generic'
      if (i18n.te(genericKey)) {
        const translated = i18n.t(genericKey, { code: error.code })
        if (translated && translated !== genericKey) return translated
      }
    }
    return `${error.code}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}
