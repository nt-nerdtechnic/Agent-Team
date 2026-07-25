import { ref, computed } from 'vue'
import type { useBackend } from './useBackend'

export type DepStatus = 'ok' | 'missing' | 'outdated'
/** How the binary got installed — decides which official command applies. */
export type InstallMethod = '' | 'npm' | 'homebrew' | 'native' | 'script' | 'unknown'
/** 'vendor' = the CLI keeps updating itself; 'manual' = its own opt-out env var is set. */
export type AutoupdatePolicy = '' | 'vendor' | 'manual'
export type MaintenanceAction = 'update' | 'doctor' | 'install'

export interface OnboardDep {
  id: string
  label: string
  description: string
  group: 'foundation' | 'agent_cli' | 'analyzer'
  status: DepStatus
  version: string
  min_version: string
  optional: boolean
  needs_terminal: boolean
  can_install: boolean
  docs_url: string
  binary_path: string
  resolved_path: string
  install_method: InstallMethod
  update_cmd: string
  doctor_cmd: string
  autoupdate_env: string
  autoupdate_policy: AutoupdatePolicy
}

export interface OnboardGate {
  foundation_ready: boolean
  has_any_cli: boolean
  analyzer_ready: boolean
  ollama_ok: boolean
  has_model: boolean
  all_required_ready: boolean
  suggested_model: string
}

export interface ModelOption {
  name: string
  size: string
  desc: string
  recommended: boolean
}

export interface CliHealthCandidate {
  path: string
  resolved_path: string
  aliases: string[]
  version: string
  status: 'ok' | 'failed'
  exit_code: number | null
  signal: string
  duration_ms: number | null
  is_primary: boolean
  install_method?: InstallMethod
  install_manager?: string
  removal_command?: string
}

/** One entry of the CLI's OWN update log, read back untouched. */
export interface CliUpdateRecord {
  scope: string
  home: string
  timestamp: string
  outcome: string
  status: string
  version_from: string
  version_to: string
}

export interface CliHealthEntry {
  agent_key: string
  label: string
  diagnostic_command: string
  update_command: string
  docs_url: string
  update_state: CliUpdateRecord[]
  candidates: CliHealthCandidate[]
}

export interface CliHealthFinding {
  type: 'probe_failed' | 'duplicate_install' | 'update_failed'
  agent_key: string
  label: string
  primary?: CliHealthCandidate
  candidates?: CliHealthCandidate[]
  records?: CliUpdateRecord[]
}

export interface CliHealthStatus {
  entries: CliHealthEntry[]
  findings: CliHealthFinding[]
  fingerprint: string
  dismissed: boolean
  needs_attention: boolean
}

export interface OnboardStatus {
  deps: OnboardDep[]
  models: string[]
  gate: OnboardGate
  model_catalog: ModelOption[]
  cli_health: CliHealthStatus
  complete: boolean
  skip: boolean
}

export function cliHealthGuideForLaunch(status: OnboardStatus | null | undefined): CliHealthStatus | null {
  if (!status?.complete || !status.cli_health?.needs_attention) return null
  // A failed vendor update is surfaced in CLI management, not by the repair
  // guide — on its own it must not open a modal the guide cannot resolve.
  const repairable = status.cli_health.findings.some((finding) => finding.type !== 'update_failed')
  return repairable ? status.cli_health : null
}

interface InstallResult {
  ok: boolean
  needs_terminal?: boolean
  command?: string
  output?: string
  error?: string
  docs_url?: string
}

/**
 * useOnboarding — drives the first-run environment wizard. The backend is the
 * single source of truth for dep definitions + status; this composable only
 * fetches, triggers installs, and exposes derived gate flags.
 */
export function useOnboarding(backend: ReturnType<typeof useBackend>) {
  const status = ref<OnboardStatus | null>(null)
  const loading = ref(false)
  const installing = ref('') // dep id currently being installed ('' = none)
  const maintaining = ref('') // '<agent>:<action>' currently running ('' = none)
  const logLines = ref<string[]>([])

  function log(line: string): void {
    logLines.value = [...logLines.value, line].slice(-200)
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const resp = await backend.send<OnboardStatus>('onboarding.status', {})
      if (resp.payload) status.value = resp.payload
    } catch (e) {
      log(`✗ Detection failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      loading.value = false
    }
  }

  async function install(dep: OnboardDep): Promise<void> {
    if (installing.value) return
    installing.value = dep.id
    log(`▶ Installing ${dep.label}…`)
    try {
      const resp = await backend.send<InstallResult>('onboarding.install', { dep_id: dep.id })
      const r = resp.payload
      if (!r?.ok) {
        log(`✗ ${dep.label} installation failed: ${r?.error || resp.error?.message || 'unknown'}`)
        return
      }
      if (r.needs_terminal && r.command) {
        await window.agentTeam?.openTerminal(r.command)
        log(`↗ Opened in external terminal: ${r.command}`)
        log('  After completing, click Re-detect.')
      } else {
        log(r.output?.trim() || `✓ ${dep.label} installed`)
      }
    } catch (e) {
      log(`✗ ${dep.label} installation error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      installing.value = ''
      await refresh()
    }
  }

  async function pullModel(model?: string): Promise<void> {
    const name = model || status.value?.gate.suggested_model || 'qwen2.5-coder'
    log(`▶ Downloading model ${name}…`)
    try {
      const resp = await backend.send<InstallResult>('onboarding.pull_model', { model: name })
      const r = resp.payload
      if (!r?.ok) { log(`✗ ${r?.error || 'download failed'}`); return }
      if (r.needs_terminal && r.command) {
        await window.agentTeam?.openTerminal(r.command)
        log(`↗ Opened in external terminal: ${r.command}`)
        log('  After completion, click Re-detect.')
      }
    } catch (e) {
      log(`✗ Model download failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Run one of the CLI's OWN maintenance commands in an external terminal.
   * The action id is resolved to a command by the backend registry — the
   * renderer never composes a command, and Navide never wraps the vendor's.
   * Serialised through `maintaining` so two CLIs cannot update at once.
   */
  async function runMaintenance(agentKey: string, action: MaintenanceAction): Promise<InstallResult | null> {
    if (maintaining.value) return null
    maintaining.value = `${agentKey}:${action}`
    try {
      const resp = await backend.send<InstallResult>('onboarding.cli_maintenance', {
        agent_key: agentKey,
        action,
      })
      const r = resp.payload
      if (!r?.ok) {
        log(`✗ ${agentKey} ${action}: ${r?.error || resp.error?.message || 'unavailable'}`)
        return r ?? null
      }
      if (r.command) {
        await window.agentTeam?.openTerminal(r.command)
        log(`↗ Opened in external terminal: ${r.command}`)
        log('  After it finishes, click Re-detect.')
      }
      return r
    } catch (e) {
      log(`✗ ${agentKey} ${action} failed: ${e instanceof Error ? e.message : String(e)}`)
      return null
    } finally {
      maintaining.value = ''
    }
  }

  async function setAutoupdatePolicy(agentKey: string, policy: AutoupdatePolicy): Promise<void> {
    const resp = await backend.send<InstallResult>('onboarding.cli_autoupdate', {
      agent_key: agentKey,
      policy,
    })
    if (!resp.payload?.ok) {
      log(`✗ ${agentKey} auto-update policy: ${resp.payload?.error || 'rejected'}`)
      return
    }
    await refresh()
  }

  async function markComplete(): Promise<void> {
    await backend.send('onboarding.complete', { complete: true })
    if (status.value) status.value.complete = true
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const deps = computed(() => status.value?.deps ?? [])
  const foundationDeps = computed(() => deps.value.filter((d) => d.group === 'foundation'))
  const cliDeps = computed(() => deps.value.filter((d) => d.group === 'agent_cli'))
  const analyzerDeps = computed(() => deps.value.filter((d) => d.group === 'analyzer'))
  const models = computed(() => status.value?.models ?? [])
  const modelCatalog = computed<ModelOption[]>(() => status.value?.model_catalog ?? [])
  const gate = computed<OnboardGate | null>(() => status.value?.gate ?? null)
  const foundationReady = computed(() => gate.value?.foundation_ready ?? false)
  const hasAnyCli = computed(() => gate.value?.has_any_cli ?? false)
  const analyzerReady = computed(() => gate.value?.analyzer_ready ?? false)
  const allRequiredReady = computed(() => gate.value?.all_required_ready ?? false)
  const cliHealth = computed<CliHealthStatus | null>(() => status.value?.cli_health ?? null)

  return {
    status, loading, installing, maintaining, logLines,
    refresh, install, pullModel, markComplete, runMaintenance, setAutoupdatePolicy,
    deps, foundationDeps, cliDeps, analyzerDeps, models, modelCatalog, gate,
    foundationReady, hasAnyCli, analyzerReady, allRequiredReady, cliHealth,
  }
}
