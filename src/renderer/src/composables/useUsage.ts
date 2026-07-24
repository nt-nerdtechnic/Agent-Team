import { reactive, watch } from 'vue'
import type { useBackend } from './useBackend'
import { settingsGet, settingsSet } from '../lib/settings'

// Module-singleton store for per-CLI quota snapshots (CodexBar-style badges).
// The backend owns the poller (`usage_service.py`) and broadcasts
// `usage.changed`; this module mirrors the latest payload so any component
// (TerminalPane's UsageBadge) can read it without prop threading — same
// facade pattern as lib/settings.ts.

export const USAGE_ENABLED_KEY = 'agentTeam.usageBadge.enabled'
export const USAGE_REFRESH_KEY = 'agentTeam.usageBadge.refreshSec'
export const USAGE_REFRESH_OPTIONS = [60, 300, 900, 1800] as const
export const USAGE_DEFAULT_REFRESH_SEC = 300

/** Agent keys with a backend usage fetcher (same-name provider mapping). */
export const USAGE_PROVIDERS = ['claude', 'codex', 'kimi', 'grok'] as const

export type UsageStatus =
  | 'ok'
  | 'no-credentials'
  | 'expired'
  | 'rate-limited'
  | 'unavailable'
  | 'error'

export interface UsageWindow {
  kind: 'session' | 'weekly' | 'weekly-model' | 'monthly' | string
  label: string
  usedPercent: number
  resetsAt: string | null
}

export interface UsageSnapshot {
  provider: string
  status: UsageStatus
  planType: string | null
  windows: UsageWindow[]
  fetchedAt: string
  error: string | null
}

interface UsagePayload {
  providers?: Record<string, UsageSnapshot>
  enabled?: boolean
  intervalSec?: number
}

type Backend = ReturnType<typeof useBackend>

const state = reactive<{ providers: Record<string, UsageSnapshot> }>({ providers: {} })

let backend: Backend | null = null
let offChanged: (() => void) | null = null
let stopStatusWatch: (() => void) | null = null

function applyPayload(payload: UsagePayload | null | undefined): void {
  if (!payload || typeof payload !== 'object') return
  if (payload.providers && typeof payload.providers === 'object') {
    state.providers = { ...payload.providers }
  }
}

export function usageEnabled(): boolean {
  return settingsGet<boolean>(USAGE_ENABLED_KEY, true) !== false
}

export function usageRefreshSec(): number {
  const raw = Number(settingsGet<number>(USAGE_REFRESH_KEY, USAGE_DEFAULT_REFRESH_SEC))
  return Number.isFinite(raw) && raw >= 60 ? raw : USAGE_DEFAULT_REFRESH_SEC
}

async function sendConfigure(): Promise<void> {
  const b = backend
  if (!b || b.status.value !== 'connected') return
  try {
    const resp = await b.send<UsagePayload>('usage.configure', {
      enabled: usageEnabled(),
      intervalSec: usageRefreshSec()
    })
    if (resp.ok) applyPayload(resp.payload)
  } catch (err) {
    console.warn('[usage] configure failed', err)
  }
}

/** Wire the store to the window's backend (call once from App.vue, next to
 *  initSettingsBackend). Re-sends the poller config on every (re)connect. */
export function initUsage(b: Backend): void {
  if (backend) return
  backend = b
  offChanged = b.on('usage.changed', (raw) => applyPayload(raw as UsagePayload))
  stopStatusWatch = watch(
    () => b.status.value,
    (s) => {
      if (s === 'connected') void sendConfigure()
    },
    { immediate: true }
  )
}

/** Push the current settings values to the backend poller (call after a
 *  settings change; also hides/starts polling via `enabled`). */
export function reconfigureUsage(): void {
  void sendConfigure()
}

export function setUsageEnabled(enabled: boolean): void {
  settingsSet(USAGE_ENABLED_KEY, enabled)
  reconfigureUsage()
}

export function setUsageRefreshSec(sec: number): void {
  settingsSet(USAGE_REFRESH_KEY, sec)
  reconfigureUsage()
}

/** Force an immediate re-poll (clears provider cooldowns backend-side). */
export function refreshUsage(): void {
  const b = backend
  if (!b || b.status.value !== 'connected') return
  void b.send('usage.refresh', {}).catch(() => {})
}

/** Snapshot for a pane's agent key, or undefined when the agent has no
 *  usage provider (antigravity/terminal) or nothing was fetched yet. */
export function usageFor(agentKey: string | undefined | null): UsageSnapshot | undefined {
  if (!agentKey || !usageEnabled()) return undefined
  if (!(USAGE_PROVIDERS as readonly string[]).includes(agentKey)) return undefined
  return state.providers[agentKey]
}

/** Kinds that represent a GENERAL account limit (not a per-model bucket). */
const HEADLINE_KINDS = new Set(['session', 'weekly', 'monthly'])

/** Remaining percentage of the snapshot's headline window. Per-model windows
 *  (kind 'weekly-model', e.g. an exhausted promotional "Fable only" bucket that
 *  Anthropic reports at 100% used but does not actually enforce) must never
 *  drive the badge — otherwise a spent promo makes an otherwise-healthy pane
 *  read as blocked. Prefer the first general window; fall back to the first
 *  window only when no general one exists. */
export function remainingPercent(snap: UsageSnapshot | undefined): number | null {
  if (!snap || snap.status !== 'ok' || snap.windows.length === 0) return null
  const headline = snap.windows.find((w) => HEADLINE_KINDS.has(w.kind)) ?? snap.windows[0]
  return Math.max(0, Math.min(100, 100 - headline.usedPercent))
}

/** Severity by REMAINING quota: >40 ok (grey), 15–40 warn (orange), <15 crit (red). */
export function remainingTier(remaining: number): 'ok' | 'warn' | 'crit' {
  if (remaining < 15) return 'crit'
  if (remaining <= 40) return 'warn'
  return 'ok'
}

/** Compact remaining label: whole percent, CodexBar's `<1%` special case. */
export function formatRemaining(remaining: number): string {
  if (remaining > 0 && remaining < 1) return '<1%'
  return `${Math.round(remaining)}%`
}

/** Countdown like "2d 3h" / "3h 15m" / "12m" / '' (past). Minutes round up. */
export function formatResetCountdown(resetsAt: string | null, nowMs?: number): string {
  if (!resetsAt) return ''
  const target = Date.parse(resetsAt)
  if (!Number.isFinite(target)) return ''
  const now = nowMs ?? Date.now()
  const totalMin = Math.ceil((target - now) / 60000)
  if (totalMin <= 0) return ''
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  return `${mins}m`
}

/** Absolute local-time form for the popover ("7/28 08:00"). */
export function formatResetAbsolute(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const target = Date.parse(resetsAt)
  if (!Number.isFinite(target)) return ''
  const d = new Date(target)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Test-only: detach and clear the singleton state. */
export function __resetUsageForTest(): void {
  offChanged?.()
  offChanged = null
  stopStatusWatch?.()
  stopStatusWatch = null
  backend = null
  state.providers = {}
}
