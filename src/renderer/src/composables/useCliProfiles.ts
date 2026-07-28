import { onScopeDispose, ref } from 'vue'
import { i18n } from '../i18n'
import type { useBackend } from './useBackend'

// A CLI account profile: a stored credential slot for one agent CLI so the
// user can keep several accounts per agent (claude/codex/kimi/grok). All
// accounts share the real home directory; switching swaps credentials in
// place. The object fields are camelCase (backend serializes them that way);
// the WS request payloads below are snake_case per the backend contract.
export interface CliProfile {
  id: string
  agentKey: string
  name: string
  createdAt: string
}

// Outcome of `setDefault`.
export type SetDefaultResult =
  | { ok: true }
  | { ok: false; code?: string; message?: string }

// Map of agentKey -> default profile id, or null for the built-in Default
// (the user's real home directory).
export type CliProfileDefaults = Record<string, string | null>

// Display-only identity of one account slot, resolved by the backend from the
// CLI's own credential files. `email` is null when the CLI stores no identity
// (kimi) or nobody is signed in.
export interface CliAccountIdentity {
  email: string | null
  signedIn: boolean
}

// agentKey -> slotId -> identity; the built-in Default row is keyed
// "__default__" (mirrors the backend's reserved slot id).
export type CliProfileIdentities = Record<string, Record<string, CliAccountIdentity>>

const DEFAULT_SLOT_ID = '__default__'

/**
 * Per-window cache of CLI account profiles. Loads from the backend on mount and
 * refreshes whenever any window broadcasts `cli_profiles.changed`. Reconnect-safe.
 * Mirrors the useRoles composable shape (WS CRUD + a `.changed` subscription).
 */
export function useCliProfiles(backend: ReturnType<typeof useBackend>) {
  const profiles = ref<CliProfile[]>([])
  const defaults = ref<CliProfileDefaults>({})
  const identities = ref<CliProfileIdentities>({})
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
        identities?: CliProfileIdentities
        supported_agents: string[]
      }>('cli_profiles.list', {})
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'failed to load CLI profiles'
        return
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      identities.value = resp.payload.identities ?? {}
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

  async function remove(id: string | null, agentKey?: string): Promise<boolean> {
    try {
      const resp = await backend.send<{
        profiles: CliProfile[]
        defaults: CliProfileDefaults
      }>('cli_profiles.delete', { id, agent_key: agentKey })
      if (!resp.ok || !resp.payload) {
        const code = resp.error?.code
        error.value =
          code === 'PROFILE_ACTIVE'
            ? i18n.global.t('settings.accounts.cli.active-error')
            : code === 'LOGIN_IN_PROGRESS'
              ? i18n.global.t('settings.accounts.cli.login-in-progress-error')
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

  async function setDefault(
    agentKey: string,
    profileId: string | null,
  ): Promise<SetDefaultResult> {
    try {
      const resp = await backend.send<{ defaults: CliProfileDefaults }>('cli_profiles.set_default', {
        agent_key: agentKey,
        profile_id: profileId,
      })
      if (!resp.ok || !resp.payload) {
        const code = resp.error?.code
        const message =
          code === 'PROFILE_SWAP_FAILED'
            ? i18n.global.t('cli-account.swap-failed')
            : (resp.error?.message ?? 'set default failed')
        error.value = message
        return { ok: false, code, message }
      }
      defaults.value = resp.payload.defaults
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'set default failed'
      error.value = message
      return { ok: false, message }
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

  /** Display identity of one account row; `profileId` null = built-in Default. */
  function identityFor(agentKey: string, profileId: string | null): CliAccountIdentity | null {
    return identities.value[agentKey]?.[profileId ?? DEFAULT_SLOT_ID] ?? null
  }

  // Keep every window's cache in sync: any mutation broadcasts `cli_profiles.changed`.
  unsubChanged = backend.on('cli_profiles.changed', (raw) => {
    const payload = raw as {
      profiles?: CliProfile[]
      defaults?: CliProfileDefaults
      identities?: CliProfileIdentities
    }
    if (payload?.profiles) profiles.value = payload.profiles
    if (payload?.defaults) defaults.value = payload.defaults
    if (payload?.identities) identities.value = payload.identities
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
    identities,
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
    identityFor,
  }
}
