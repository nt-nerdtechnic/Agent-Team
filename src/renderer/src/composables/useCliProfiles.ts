import { onScopeDispose, ref } from 'vue'
import { i18n } from '../i18n'
import type { useBackend } from './useBackend'

// A CLI account profile: an isolated login/home directory for one agent CLI so
// the user can keep several accounts per agent (claude/codex/kimi/grok). The
// object fields are camelCase (backend serializes them that way); the WS request
// payloads below are snake_case per the backend contract.
export interface CliProfile {
  id: string
  agentKey: string
  name: string
  createdAt: string
}

// Map of agentKey -> default profile id, or null for the built-in Default
// (the user's real home directory).
export type CliProfileDefaults = Record<string, string | null>

/**
 * Per-window cache of CLI account profiles. Loads from the backend on mount and
 * refreshes whenever any window broadcasts `cli_profiles.changed`. Reconnect-safe.
 * Mirrors the useRoles composable shape (WS CRUD + a `.changed` subscription).
 */
export function useCliProfiles(backend: ReturnType<typeof useBackend>) {
  const profiles = ref<CliProfile[]>([])
  const defaults = ref<CliProfileDefaults>({})
  const supportedAgents = ref<string[]>([])
  const loaded = ref<boolean>(false)
  const loading = ref<boolean>(false)
  const error = ref<string>('')

  let unsubChanged: (() => void) | null = null
  let unsubBackend: (() => void) | null = null

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const resp = await backend.send<{
        profiles: CliProfile[]
        defaults: CliProfileDefaults
        supported_agents: string[]
      }>('cli_profiles.list', {})
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'failed to load CLI profiles'
        return
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      supportedAgents.value = resp.payload.supported_agents
      loaded.value = true
    } catch (err) {
      error.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  async function create(agentKey: string, name: string): Promise<CliProfile | null> {
    try {
      const resp = await backend.send<{
        profile: CliProfile
        profiles: CliProfile[]
        defaults: CliProfileDefaults
      }>('cli_profiles.create', { agent_key: agentKey, name })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'create failed'
        return null
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      return resp.payload.profile
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'create failed'
      return null
    }
  }

  async function rename(id: string, name: string): Promise<CliProfile | null> {
    try {
      const resp = await backend.send<{
        profile: CliProfile
        profiles: CliProfile[]
        defaults: CliProfileDefaults
      }>('cli_profiles.rename', { id, name })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'rename failed'
        return null
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      return resp.payload.profile
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'rename failed'
      return null
    }
  }

  async function remove(id: string): Promise<boolean> {
    try {
      const resp = await backend.send<{
        profiles: CliProfile[]
        defaults: CliProfileDefaults
      }>('cli_profiles.delete', { id })
      if (!resp.ok || !resp.payload) {
        error.value =
          resp.error?.code === 'PROFILE_IN_USE'
            ? i18n.global.t('settings.accounts.cli.in-use-error')
            : (resp.error?.message ?? 'delete failed')
        return false
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'delete failed'
      return false
    }
  }

  async function setDefault(agentKey: string, profileId: string | null): Promise<boolean> {
    try {
      const resp = await backend.send<{ defaults: CliProfileDefaults }>('cli_profiles.set_default', {
        agent_key: agentKey,
        profile_id: profileId,
      })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'set default failed'
        return false
      }
      defaults.value = resp.payload.defaults
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'set default failed'
      return false
    }
  }

  /** Profiles belonging to one agent, in creation order. */
  function profilesForAgent(agentKey: string): CliProfile[] {
    return profiles.value.filter((p) => p.agentKey === agentKey)
  }

  /** True when the agent supports multiple accounts (has at least one profile). */
  function hasProfiles(agentKey: string): boolean {
    return profiles.value.some((p) => p.agentKey === agentKey)
  }

  /** The configured default profile id for an agent, or null (built-in Default). */
  function defaultProfileId(agentKey: string): string | null {
    return defaults.value[agentKey] ?? null
  }

  function findProfile(id: string | null | undefined): CliProfile | undefined {
    if (!id) return undefined
    return profiles.value.find((p) => p.id === id)
  }

  // Keep every window's cache in sync: any mutation broadcasts `cli_profiles.changed`.
  unsubChanged = backend.on('cli_profiles.changed', (raw) => {
    const payload = raw as { profiles?: CliProfile[]; defaults?: CliProfileDefaults }
    if (payload?.profiles) profiles.value = payload.profiles
    if (payload?.defaults) defaults.value = payload.defaults
  })

  // Initial load once connected; re-fetch on reconnect (mirrors useRoles).
  let lastStatus = backend.status.value
  function maybeLoad(): void {
    if (backend.status.value === 'connected') void refresh()
  }
  maybeLoad()
  unsubBackend = (() => {
    const id = window.setInterval(() => {
      if (backend.status.value !== lastStatus) {
        lastStatus = backend.status.value
        maybeLoad()
      }
    }, 500)
    return () => window.clearInterval(id)
  })()

  onScopeDispose(() => {
    unsubChanged?.()
    unsubBackend?.()
  })

  return {
    profiles,
    defaults,
    supportedAgents,
    loaded,
    loading,
    error,
    refresh,
    create,
    rename,
    remove,
    setDefault,
    profilesForAgent,
    hasProfiles,
    defaultProfileId,
    findProfile,
  }
}
