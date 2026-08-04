import { onScopeDispose, ref, type InjectionKey } from 'vue'
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

// Outcome of `setDefault`. `count` is set for PANES_RUNNING refusals — the
// number of live non-login panes the backend saw for the agent. `needsLogin`
// marks a switch onto an account whose stored credentials cannot authenticate
// (empty slot, or an expired token the backend could not refresh) — the CLI is
// now signed out and the caller should start a sign-in.
export type SetDefaultResult =
  | { ok: true; needsLogin?: boolean }
  | { ok: false; code?: string; message?: string; count?: number }

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
    opts?: { force?: boolean },
  ): Promise<SetDefaultResult> {
    try {
      const payload: Record<string, unknown> = {
        agent_key: agentKey,
        profile_id: profileId,
      }
      if (opts?.force) payload.force = true
      const resp = await backend.send<{
        defaults: CliProfileDefaults
        needsLogin?: boolean
      }>('cli_profiles.set_default', payload, 30_000)
      if (!resp.ok || !resp.payload) {
        const code = resp.error?.code
        if (code === 'PANES_RUNNING') {
          // Quiescence refusal: live panes still use the current credentials.
          // Not a banner error — the caller either drives a confirm-and-force
          // flow (main window) or surfaces the message as an alert.
          const count = Number(resp.error?.details?.count ?? 0)
          return {
            ok: false,
            code,
            count,
            message: i18n.global.t('cli-account.panes-running', { count }),
          }
        }
        const message =
          code === 'PROFILE_SWAP_FAILED'
            ? i18n.global.t('cli-account.swap-failed')
            : (resp.error?.message ?? 'set default failed')
        error.value = message
        return { ok: false, code, message }
      }
      defaults.value = resp.payload.defaults
      return { ok: true, needsLogin: resp.payload.needsLogin === true }
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

// ── Quiescence-aware account switch ─────────────────────────────────────────

/** Switches an agent's default account like `setDefault`, but resolves the
 *  PANES_RUNNING refusal (confirm with the user, force the switch, restart
 *  the agent's live panes). Provided by the main window, which owns the pane
 *  roster; windows without it fall back to plain `setDefault`. */
export type CliAccountSwitchHandler = (
  agentKey: string,
  profileId: string | null,
) => Promise<SetDefaultResult>

export const cliAccountSwitchKey: InjectionKey<CliAccountSwitchHandler> =
  Symbol('cli-account-switch')

/** App-shell capabilities the switch flow needs but a component cannot own. */
export interface CliAccountSwitchCaps {
  /** Modal confirm — resolves true when the user accepts the restart. */
  confirm: (
    message: string,
    opts: { title: string; confirmText: string; cancelText: string },
  ) => Promise<boolean>
  /** Display label for the agent in the confirm copy. */
  agentLabel: (agentKey: string) => string
  /** Start a live sign-in for the agent — used when the switch landed on an
   *  account whose stored credentials cannot authenticate. The account is
   *  already active by then, so this is a LIVE login (not an isolated one). */
  startLogin: (agentKey: string) => void
}

/**
 * Build the main window's account-switch handler: try the plain switch; when
 * the backend refuses with PANES_RUNNING, ask the user, then force the switch.
 * The pane restart is NOT driven here: the backend broadcasts the forced
 * switch via `cli_profiles.changed` and every main window (this one included)
 * restarts its own panes from that event — see `forcedRestartAgentKey`.
 * A declined confirm returns a message-less failure so callers stay silent.
 */
export function createCliAccountSwitchHandler(
  api: Pick<ReturnType<typeof useCliProfiles>, 'setDefault'>,
  caps: CliAccountSwitchCaps,
): CliAccountSwitchHandler {
  // The switched-to account has no usable credentials: the CLI is signed out
  // right now, so start the sign-in for the user instead of leaving them at a
  // login prompt to resolve by hand.
  function afterSwitch(agentKey: string, res: SetDefaultResult): SetDefaultResult {
    if (res.ok && res.needsLogin) caps.startLogin(agentKey)
    return res
  }

  return async (agentKey, profileId) => {
    const first = await api.setDefault(agentKey, profileId)
    if (first.ok || first.code !== 'PANES_RUNNING') return afterSwitch(agentKey, first)
    const t = i18n.global.t
    const confirmed = await caps.confirm(
      t('cli-account.switch-restart-confirm-body', {
        count: first.count ?? 0,
        agent: caps.agentLabel(agentKey),
      }),
      {
        title: t('cli-account.switch-restart-confirm-title'),
        confirmText: t('cli-account.switch-restart-confirm-confirm'),
        cancelText: t('cli-account.switch-restart-confirm-cancel'),
      },
    )
    if (!confirmed) return { ok: false, code: 'PANES_RUNNING' }
    return afterSwitch(agentKey, await api.setDefault(agentKey, profileId, { force: true }))
  }
}

// ── Broadcast-driven pane restart (forced account switch) ───────────────────

/** Subset of the `cli_profiles.changed` payload relevant to forced switches. */
export interface CliProfilesChangedEvent {
  reason?: string
  agent_key?: string
  forced?: boolean
}

/**
 * The agent whose panes must restart after this `cli_profiles.changed`
 * broadcast, or null. Only a forced set_default (credentials swapped under
 * live panes) triggers a restart; a quiet switch never touches panes.
 */
export function forcedRestartAgentKey(
  ev: CliProfilesChangedEvent | null | undefined,
): string | null {
  if (!ev || ev.reason !== 'set_default') return null
  if (!ev.forced || !ev.agent_key) return null
  return ev.agent_key
}

/**
 * True when a pane belongs in the post-switch restart batch: a realized,
 * non-login pane of the switched agent whose terminal has not died.
 * `status` is the pane's display/terminal status ('exited'/'error' = dead);
 * undefined (terminal ref not mounted yet) keeps the pane in the batch — it
 * may be starting on the old credentials, and skipping it would leave the
 * stale account live.
 */
export function paneNeedsAccountRestart(
  pane: { realized?: boolean; agentKey?: string; isLogin?: boolean },
  agentKey: string,
  status: string | undefined,
): boolean {
  if (!pane.realized || pane.agentKey !== agentKey || pane.isLogin) return false
  return status !== 'exited' && status !== 'error'
}

/**
 * Run the post-switch restart batch and aggregate failures: `rebuild` resolves
 * undefined on success and a failure token otherwise (and may throw). Each
 * failure is logged; one summary toast is emitted when any pane could not be
 * restarted, none when all succeeded.
 */
export async function runAccountRestartBatch(
  ids: string[],
  rebuild: (id: string) => Promise<string | undefined>,
  log: (line: string) => void,
  toastPartial: (failed: number, total: number) => void,
): Promise<void> {
  const failures: Array<{ id: string; reason: string }> = []
  for (const id of ids) {
    try {
      const outcome = await rebuild(id)
      if (outcome !== undefined) failures.push({ id, reason: outcome })
    } catch (error) {
      failures.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const f of failures) {
    log(`⚠ account-switch rebuild pane ${f.id.slice(0, 8)} failed: ${f.reason}`)
  }
  if (failures.length > 0) toastPartial(failures.length, ids.length)
}
