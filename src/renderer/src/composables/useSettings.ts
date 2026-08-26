import { ref } from 'vue'
import { i18n } from '@navide/ui-foundation'
import { settingsGet, settingsSet } from '@navide/shared'

const LANGUAGE_KEY = 'agent-team:language'
const SUPPORTED = new Set(['zh-TW', 'en-US'])

function normalizeLocale(raw: string): string {
  if (/^zh-(TW|Hant|HK)/i.test(raw) || /^zh/i.test(raw)) return 'zh-TW'
  if (/^en/i.test(raw)) return 'en-US'
  return 'zh-TW'
}

function readLocal(): string | null {
  const v = settingsGet<string | null>(LANGUAGE_KEY, null)
  return v && SUPPORTED.has(v) ? v : null
}

function writeLocal(value: string): void {
  settingsSet(LANGUAGE_KEY, value)
}

// Module-level singleton — shared across every component that calls useSettings().
const language = ref<string>(i18n.global.locale.value as string)

function loadLanguage(backendFallback?: { language?: string }): void {
  const local = readLocal()
  if (local) {
    language.value = local
    i18n.global.locale.value = local as 'zh-TW' | 'en-US'
    return
  }
  const backend = backendFallback?.language && SUPPORTED.has(backendFallback.language)
    ? backendFallback.language
    : null
  const next = backend ?? normalizeLocale(navigator.language)
  language.value = next
  i18n.global.locale.value = next as 'zh-TW' | 'en-US'
  if (backend) writeLocal(next)
}

function setLanguage(locale: string): void {
  if (!SUPPORTED.has(locale)) return
  language.value = locale
  i18n.global.locale.value = locale as 'zh-TW' | 'en-US'
  writeLocal(locale)
  window.agentTeam?.broadcastLanguageChange?.(locale)
}

// Health-check timeout (seconds): how long the main process waits for the
// backend's /health endpoint before giving up on startup/restart. Persisted
// in a main-owned file (not localStorage) because main needs the value before
// any renderer window exists — see src/main/health-timeout.ts.
export const DEFAULT_HEALTH_CHECK_TIMEOUT_SEC = 45
export const MIN_HEALTH_CHECK_TIMEOUT_SEC = 15
export const MAX_HEALTH_CHECK_TIMEOUT_SEC = 120

function clampHealthCheckTimeoutSec(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_HEALTH_CHECK_TIMEOUT_SEC
  return Math.min(MAX_HEALTH_CHECK_TIMEOUT_SEC, Math.max(MIN_HEALTH_CHECK_TIMEOUT_SEC, Math.round(raw)))
}

const healthCheckTimeoutSec = ref<number>(DEFAULT_HEALTH_CHECK_TIMEOUT_SEC)

async function loadHealthCheckTimeoutSec(): Promise<void> {
  try {
    const result = await window.agentTeam?.readHealthCheckTimeout?.()
    if (result?.ok && typeof result.timeoutSec === 'number') {
      healthCheckTimeoutSec.value = clampHealthCheckTimeoutSec(result.timeoutSec)
    }
  } catch {
    // IPC unavailable — keep default
  }
}

function setHealthCheckTimeoutSec(sec: number): void {
  const clamped = clampHealthCheckTimeoutSec(sec)
  healthCheckTimeoutSec.value = clamped
  void window.agentTeam?.writeHealthCheckTimeout?.(clamped)
}

async function syncToBackend(
  sender: (type: string, payload: Record<string, unknown>) => Promise<unknown>,
  workspacePath: string,
): Promise<void> {
  if (!workspacePath) return
  try {
    await sender('project.set_language', {
      workspace_path: workspacePath,
      language: language.value,
    })
  } catch {
    // backup only — ignore failures
  }
}

export function useSettings() {
  return {
    language,
    loadLanguage,
    setLanguage,
    syncToBackend,
    healthCheckTimeoutSec,
    loadHealthCheckTimeoutSec,
    setHealthCheckTimeoutSec,
  }
}
