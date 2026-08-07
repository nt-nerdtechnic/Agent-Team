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
  /** The vendor command an install would run, shown before the user agrees. */
  install_cmd?: string
  /** Bootstrap tools this dep's install needs, with their current state. */
  requirements?: { name: string; ok: boolean }[]
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
  /** ollama is installed AND its daemon answered — pulling a model can work. */
  ollama_service_up: boolean
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
  /** Dep ids whose guided-install prompt the user switched off for good. */
  install_prompt_dismissed?: string[]
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

export interface InstallResult {
  ok: boolean
  needs_terminal?: boolean
  command?: string
  output?: string
  error?: string
  docs_url?: string
  dep_id?: string
  label?: string
  /** Bootstrap binaries (brew, npm) the install command needs but cannot find. */
  missing_requirements?: string[]
  /** Ollama is installed but its daemon is not answering. */
  needs_service?: boolean
  /** False when the external terminal never opened — `ok` alone would lie. */
  terminal_opened?: boolean
}

// Inline installs (brew) block the WS reply until the command finishes; the
// backend caps them at 900s, so the request deadline must outlive that —
// the default 10s send timeout aborts every real install mid-download.
const INSTALL_TIMEOUT_MS = 910_000

// An external-terminal install finishes outside the app, so nothing tells us
// when it is done. Poll instead of leaving the card stuck at "not installed".
const WATCH_INTERVAL_MS = 5_000
const WATCH_MAX_TICKS = 60 // ≈5 minutes, then the user re-detects manually

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
  const pulling = ref('') // model name currently being pulled ('' = none)
  const logLines = ref<string[]>([])
  /** Seconds the current install has been running — the only progress signal
   *  an inline brew install gives, since its output arrives only at the end. */
  const installElapsedSec = ref(0)
  /** Key of the external-terminal task being polled ('' = none). */
  const watching = ref('')
  /** How the last external-terminal watch ended — the UI has to say something
   *  when polling gives up, otherwise the card just sits at "not installed". */
  const watchOutcome = ref<'' | 'detected' | 'timeout'>('')

  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let watchTimer: ReturnType<typeof setTimeout> | null = null

  function log(line: string): void {
    logLines.value = [...logLines.value, line].slice(-200)
  }

  /** Log a headline plus the tail of a multi-line detail (stderr, etc.). */
  function logDetail(headline: string, detail: string): void {
    log(headline)
    for (const line of detail.trim().split('\n').slice(-20)) log(`  ${line}`)
  }

  function stopElapsed(): void {
    if (elapsedTimer !== null) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  }

  function startElapsed(): void {
    stopElapsed()
    installElapsedSec.value = 0
    elapsedTimer = setInterval(() => {
      installElapsedSec.value += 1
    }, 1000)
  }

  function stopWatch(): void {
    if (watchTimer !== null) {
      clearTimeout(watchTimer)
      watchTimer = null
    }
    watching.value = ''
  }

  /** Re-detect on an interval until `isDone()` or the ceiling is reached. */
  function watchUntil(
    key: string,
    isDone: () => boolean,
    onDone: () => void,
    onTimeout?: () => void,
  ): void {
    stopWatch()
    watching.value = key
    watchOutcome.value = ''
    let ticks = 0
    const tick = async (): Promise<void> => {
      if (watching.value !== key) return
      ticks += 1
      await refresh({ fresh: true })
      if (watching.value !== key) return // superseded or disposed while in flight
      if (isDone()) {
        stopWatch()
        watchOutcome.value = 'detected'
        onDone()
        return
      }
      if (ticks >= WATCH_MAX_TICKS) {
        stopWatch()
        // Giving up used to be silent: the user was left watching a card that
        // would never change, with nothing saying the polling had stopped.
        watchOutcome.value = 'timeout'
        onTimeout?.()
        return
      }
      watchTimer = setTimeout(() => void tick(), WATCH_INTERVAL_MS)
    }
    watchTimer = setTimeout(() => void tick(), WATCH_INTERVAL_MS)
  }

  /** Release timers — the wizard can be closed mid-install. */
  function dispose(): void {
    stopElapsed()
    stopWatch()
  }

  async function openInTerminal(command: string, hint: string): Promise<boolean> {
    // A failed openTerminal used to be swallowed, so the log claimed a terminal
    // had opened while nothing happened (TCC automation not granted yet).
    const opened = await window.agentTeam?.openTerminal(command)
    if (!opened?.ok) {
      log(`✗ Could not open an external terminal: ${opened?.error || 'unavailable'}`)
      log(`  Run this yourself, then click Re-detect: ${command}`)
      return false
    }
    log(`↗ Opened in external terminal: ${command}`)
    log(`  ${hint}`)
    return true
  }

  async function refresh(opts?: { fresh?: boolean }): Promise<void> {
    loading.value = true
    try {
      if (!status.value) {
        // First paint: the PATH-presence pass answers instantly (no login
        // shell, no version subprocesses), so a missing CLI shows "not
        // installed" immediately instead of after the full batch's slowest
        // probe. The full pass below replaces it.
        try {
          const quick = await backend.send<OnboardStatus>('onboarding.status_quick', {})
          if (quick.payload && !status.value) status.value = quick.payload
        } catch {
          // Older backend without the quick pass — the full status follows.
        }
      }
      // fresh re-probes the backend's login-shell PATH cache; pass it when an
      // installer just ran and may have written a new PATH export.
      const resp = await backend.send<OnboardStatus>(
        'onboarding.status',
        opts?.fresh ? { fresh: true } : {}
      )
      if (resp.payload) status.value = resp.payload
    } catch (e) {
      log(`✗ Detection failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      loading.value = false
    }
  }

  async function install(dep: OnboardDep): Promise<InstallResult | null> {
    if (installing.value) return null
    installing.value = dep.id
    startElapsed()
    log(`▶ Installing ${dep.label}…`)
    // Set only when the command ran here and exited 0 — that claim is worth
    // re-checking, because "installed" and "detectable" are not the same thing.
    let ranInlineOk = false
    let handedToTerminal = false
    try {
      const resp = await backend.send<InstallResult>(
        'onboarding.install',
        { dep_id: dep.id },
        INSTALL_TIMEOUT_MS
      )
      const r = resp.payload
      if (!r?.ok) {
        logDetail(
          `✗ ${dep.label} installation failed:`,
          r?.error || r?.output || resp.error?.message || 'unknown'
        )
        return r ?? null
      }
      if (r.needs_terminal && r.command) {
        handedToTerminal = await openInTerminal(
          r.command,
          'Watching for it to finish — or click Re-detect.'
        )
        if (handedToTerminal) {
          watchUntil(
            dep.id,
            () => deps.value.find((d) => d.id === dep.id)?.status === 'ok',
            () => log(`✓ ${dep.label} detected.`),
            () => log(`⚠ Stopped watching for ${dep.label} — click Re-detect once it finishes.`)
          )
        }
        return { ...r, terminal_opened: handedToTerminal }
      }
      ranInlineOk = true
      log(r.output?.trim() || `✓ ${dep.label} installed`)
      return r
    } catch (e) {
      log(`✗ ${dep.label} installation error: ${e instanceof Error ? e.message : String(e)}`)
      return null
    } finally {
      installing.value = ''
      stopElapsed()
      // Skip the immediate re-detect when the work moved to a terminal: it
      // cannot have finished yet, and the watcher polls for it anyway.
      if (!handedToTerminal) {
        await refresh({ fresh: true })
        const after = deps.value.find((d) => d.id === dep.id)
        if (ranInlineOk && after && after.status !== 'ok') {
          log(`⚠ ${dep.label} installed successfully but is still not detected.`)
          log('  It may need a new shell session, or it landed outside PATH.')
        }
      }
    }
  }

  async function pullModel(model?: string): Promise<InstallResult | null> {
    if (pulling.value) return null
    const name = model || status.value?.gate.suggested_model || 'qwen2.5-coder'
    pulling.value = name
    log(`▶ Downloading model ${name}…`)
    try {
      const resp = await backend.send<InstallResult>('onboarding.pull_model', { model: name })
      const r = resp.payload
      if (!r?.ok) {
        log(`✗ ${r?.error || 'download failed'}`)
        if (r?.needs_service) log('  Start the Ollama service, then try again.')
        return r ?? null
      }
      if (r.needs_terminal && r.command) {
        const opened = await openInTerminal(
          r.command,
          'Watching for the download to finish — or click Re-detect.'
        )
        if (opened) {
          watchUntil(
            `model:${name}`,
            () => models.value.includes(name),
            () => log(`✓ Model ${name} is available.`)
          )
        }
      }
      return r
    } catch (e) {
      log(`✗ Model download failed: ${e instanceof Error ? e.message : String(e)}`)
      return null
    } finally {
      pulling.value = ''
    }
  }

  /**
   * Start the Ollama daemon. Installing the formula does not start it, and
   * without it `ollama pull` fails and the model list stays empty forever.
   */
  async function startOllamaService(): Promise<InstallResult | null> {
    const resp = await backend.send<InstallResult>('onboarding.start_ollama', {})
    const r = resp.payload
    if (!r?.ok) {
      log(`✗ ${r?.error || 'cannot start the Ollama service'}`)
      return r ?? null
    }
    if (r.command) {
      const opened = await openInTerminal(
        r.command,
        'Watching for the service to come up — or click Re-detect.'
      )
      if (opened) {
        watchUntil(
          'ollama-service',
          () => gate.value?.ollama_service_up === true,
          () => log('✓ Ollama service is running.')
        )
      }
    }
    return r
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
        await openInTerminal(r.command, 'After it finishes, click Re-detect.')
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

  /**
   * Stop (or resume) raising the guided-install prompt for one CLI. Declining
   * a prompt is deliberately NOT the same as this: the prompt keeps coming
   * back until the user opts out here, and the choice is per CLI, not global.
   */
  async function dismissInstallPrompt(depId: string, dismissed = true): Promise<boolean> {
    const resp = await backend.send<InstallResult>('onboarding.install_prompt', {
      dep_id: depId,
      dismissed,
    })
    if (!resp.payload?.ok) {
      log(`✗ ${depId} install prompt: ${resp.payload?.error || 'rejected'}`)
      return false
    }
    if (status.value) {
      const current = new Set(status.value.install_prompt_dismissed ?? [])
      if (dismissed) current.add(depId)
      else current.delete(depId)
      status.value.install_prompt_dismissed = [...current]
    }
    return true
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
  const ollamaServiceUp = computed(() => gate.value?.ollama_service_up ?? false)
  const allRequiredReady = computed(() => gate.value?.all_required_ready ?? false)
  const cliHealth = computed<CliHealthStatus | null>(() => status.value?.cli_health ?? null)
  const installPromptDismissed = computed(
    () => new Set(status.value?.install_prompt_dismissed ?? [])
  )

  return {
    status, loading, installing, maintaining, pulling, logLines,
    installElapsedSec, watching, watchOutcome,
    refresh, install, pullModel, startOllamaService, markComplete, runMaintenance,
    setAutoupdatePolicy, dismissInstallPrompt, dispose,
    deps, foundationDeps, cliDeps, analyzerDeps, models, modelCatalog, gate,
    foundationReady, hasAnyCli, analyzerReady, allRequiredReady, ollamaServiceUp,
    cliHealth, installPromptDismissed,
  }
}
