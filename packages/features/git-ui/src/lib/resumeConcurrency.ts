// Max number of resume spawns allowed to run terminal.create concurrently; the
// rest queue. Resume is the heaviest spawn — it reprints the whole transcript
// and the backend does serial pre-ack work per create (login-shell PATH
// refresh, ~8s CLI probe, PTY fork, attribution scan) on its single event-loop
// thread. Firing many resume at once stacks that work and pushes later acks past
// the request timeout ("request terminal.create timeout" → pane setup failed).
// Fresh spawns are light and stay unthrottled. User-adjustable in Settings.

import { settingsGet } from './settings'

/** Settings-store key (ui_settings.json via lib/settings.ts). */
export const RESUME_CONCURRENCY_SETTING_KEY = 'agentTeam.resumeConcurrency'
export const DEFAULT_RESUME_CONCURRENCY = 3
export const MIN_RESUME_CONCURRENCY = 1
export const MAX_RESUME_CONCURRENCY = 10

/** Coerce a stored/UI value to an integer within [MIN, MAX]; anything
 *  unparseable falls back to the default. */
export function clampResumeConcurrency(v: unknown): number {
  // Empty/absent (e.g. the user cleared the input) → default, not 0-clamped-to-1.
  if (v === '' || v === null || v === undefined) return DEFAULT_RESUME_CONCURRENCY
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return DEFAULT_RESUME_CONCURRENCY
  return Math.min(MAX_RESUME_CONCURRENCY, Math.max(MIN_RESUME_CONCURRENCY, n))
}

/** Current cap, read live from the settings cache. The cache updates
 *  synchronously on this window's own settingsSet and merges other-window
 *  broadcasts, so reading at spawn time always reflects the latest value —
 *  no ref/subscription needed (onSettingsChanged skips same-window writes). */
export function getResumeConcurrency(): number {
  return clampResumeConcurrency(settingsGet(RESUME_CONCURRENCY_SETTING_KEY, DEFAULT_RESUME_CONCURRENCY))
}
