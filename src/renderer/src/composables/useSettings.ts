import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

const LANGUAGE_KEY = 'agent-team:language'
const SUPPORTED = new Set(['zh-TW', 'en-US'])

function normalizeLocale(raw: string): string {
  if (/^zh-(TW|Hant|HK)/i.test(raw) || /^zh/i.test(raw)) return 'zh-TW'
  if (/^en/i.test(raw)) return 'en-US'
  return 'zh-TW'
}

function parseSupportedLocale(raw: unknown): 'zh-TW' | 'en-US' | null {
  if (typeof raw !== 'string') return null
  const candidate = raw.trim()
  if (SUPPORTED.has(candidate)) return candidate as 'zh-TW' | 'en-US'
  try {
    const decoded = JSON.parse(candidate)
    return typeof decoded === 'string' && SUPPORTED.has(decoded) ? (decoded as 'zh-TW' | 'en-US') : null
  } catch {
    return null
  }
}

function readLocal(): 'zh-TW' | 'en-US' | null {
  const v = settingsGet<unknown>(LANGUAGE_KEY, null)
  return parseSupportedLocale(v)
}

function writeLocal(value: string): void {
  settingsSet(LANGUAGE_KEY, value)
}

// Module-level singleton — shared across every component that calls useSettings().
const initialLocale = readLocal() ?? (i18n.global.locale.value as string)
const language = ref<string>(initialLocale)
if (SUPPORTED.has(initialLocale) && i18n.global.locale.value !== initialLocale) {
  i18n.global.locale.value = initialLocale as 'zh-TW' | 'en-US'
}

let unwatchSettings: (() => void) | null = null

export function ensureLanguageSettingsSubscription(): void {
  unwatchSettings?.()
  unwatchSettings = onSettingsChanged((keys) => {
    if (keys.includes(LANGUAGE_KEY)) {
      const next = readLocal()
      if (next && next !== language.value) {
        language.value = next
        i18n.global.locale.value = next
      }
    }
  })
}
ensureLanguageSettingsSubscription()

function loadLanguage(backendFallback?: { language?: string }): void {
  const local = readLocal()
  if (local) {
    language.value = local
    i18n.global.locale.value = local
    return
  }
  const backend = backendFallback?.language ? parseSupportedLocale(backendFallback.language) : null
  const next = backend ?? normalizeLocale(navigator.language)
  language.value = next
  i18n.global.locale.value = next as 'zh-TW' | 'en-US'
  if (backend) writeLocal(next)
}

function setLanguage(locale: string, options: { broadcast?: boolean } = {}): void {
  const validated = parseSupportedLocale(locale)
  if (!validated) return
  const changed = language.value !== validated || i18n.global.locale.value !== validated
  language.value = validated
  i18n.global.locale.value = validated
  writeLocal(validated)
  if (options.broadcast !== false && changed) {
    window.agentTeam?.broadcastLanguageChange?.(validated)
  }
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
  const local = readLocal()
  if (local && language.value !== local) {
    language.value = local
    i18n.global.locale.value = local
  }
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
