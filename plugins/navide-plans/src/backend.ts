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

export function backendErrorMessage(error: unknown): string {
  if (error instanceof PluginBackendError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}
