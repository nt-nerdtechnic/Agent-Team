// User customization of the pane status badges: what each status is called, in
// each language, and which colour it is painted.
//
// Module-scoped singleton refs, for the same reason useCliAgentPrefs is one —
// settingsGet() is not reactive, so the settings page (writer) and every badge
// surface (readers) have to share one ref for an edit to show up live.
//
// Persistence is the per-user KV (ui_settings), not the workspace: a status
// vocabulary is how one person reads their panes, and it should not change when
// they switch projects. The value is a JSON string, matching how every other
// settings-backed object in this app is stored.
//
// Storage shape — only what differs from the default is written, so a status
// the user never touched keeps following the shipped default even if that
// default changes in a later version:
//   { "idle": { "labelZh": "待命", "color": "cyan" }, "error": { "color": "pink" } }

import { computed, ref } from 'vue'

import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

import type { PaneStatusValue } from '../lib/paneStatusLabel'
import {
  DEFAULT_STATUS_COLORS,
  isPaneStatusValue,
  isStatusColorKey,
  STATUS_COLOR_PALETTE,
  type StatusColorKey,
} from '../lib/statusBadgePalette'

const STORAGE_KEY = 'agentTeam.statusBadges'

/** One status's overrides. Every field is optional: an absent field means
 *  "use the shipped default", which is what makes a partial edit survive a
 *  change to the defaults. */
export interface StatusBadgePref {
  /** Traditional Chinese label. Blank/absent → the i18n string. */
  labelZh?: string
  /** English label. Blank/absent → the i18n string. */
  labelEn?: string
  /** Palette colour. Absent or unknown → DEFAULT_STATUS_COLORS. */
  color?: StatusColorKey
}

export type StatusBadgePrefs = Partial<Record<PaneStatusValue, StatusBadgePref>>

/** Drop anything we do not recognise rather than repairing it. A settings blob
 *  written by a newer version (or hand-edited) must degrade to the defaults, not
 *  to a badge painted `var(--undefined)` or labelled `[object Object]`. */
function sanitize(raw: unknown): StatusBadgePrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: StatusBadgePrefs = {}
  for (const [status, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPaneStatusValue(status)) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const pref: StatusBadgePref = {}
    if (typeof entry.labelZh === 'string' && entry.labelZh.trim()) {
      pref.labelZh = entry.labelZh.trim()
    }
    if (typeof entry.labelEn === 'string' && entry.labelEn.trim()) {
      pref.labelEn = entry.labelEn.trim()
    }
    if (isStatusColorKey(entry.color)) pref.color = entry.color
    if (pref.labelZh || pref.labelEn || pref.color) out[status] = pref
  }
  return out
}

function load(): StatusBadgePrefs {
  try {
    return sanitize(JSON.parse(settingsGet(STORAGE_KEY, '')))
  } catch {
    // no/blank/corrupt setting → no overrides, i.e. shipped defaults
    return {}
  }
}

const prefs = ref<StatusBadgePrefs>(load())

/** Last string this window wrote or read back. Comparing the serialized value
 *  — rather than raising a boolean flag — is what stops a broadcast we caused
 *  from re-entering as a remote change; the same guard useLayoutStore uses. */
let lastSynced = JSON.stringify(prefs.value)

function persist(next: StatusBadgePrefs): void {
  const serialized = JSON.stringify(next)
  if (serialized === lastSynced) return
  lastSynced = serialized
  settingsSet(STORAGE_KEY, serialized)
}

// Another window editing the same preference must repaint this one's badges;
// they are the same user looking at the same vocabulary.
onSettingsChanged((keys) => {
  if (!keys.includes(STORAGE_KEY)) return
  const incoming = load()
  const serialized = JSON.stringify(incoming)
  if (serialized === lastSynced) return
  lastSynced = serialized
  prefs.value = incoming
})

/** The colour a status is painted in, override first. */
export function statusBadgeColorKey(status: PaneStatusValue): StatusColorKey {
  return prefs.value[status]?.color ?? DEFAULT_STATUS_COLORS[status]
}

/** Inline CSS variables for a status badge, or `undefined` when the status is
 *  at its default colour.
 *
 *  Returning nothing for the default case is deliberate: the surface's own
 *  `[data-status]` rule then paints it, unchanged, and the surfaces keep
 *  working with no override layer present at all (plugin windows, tests, the
 *  first frame before settings load). Only a customized status carries inline
 *  style. */
export function statusBadgeStyle(
  status: PaneStatusValue
): Record<string, string> | undefined {
  const custom = prefs.value[status]?.color
  if (!custom || !isStatusColorKey(custom)) return undefined
  const spec = STATUS_COLOR_PALETTE[custom]
  return { '--status-badge-bg': spec.bg, '--status-badge-fg': spec.fg }
}

/** The user's label for a status in `locale`, or '' when they have not set one.
 *  Blank is meaningful — it is how the settings page clears an override back to
 *  the translated default. */
export function statusBadgeLabelOverride(status: PaneStatusValue, locale: string): string {
  const pref = prefs.value[status]
  if (!pref) return ''
  const label = locale.startsWith('zh') ? pref.labelZh : pref.labelEn
  return label?.trim() ?? ''
}

/** Set one field of one status. An empty label or the default colour removes
 *  the override instead of storing it, so the blob never accumulates entries
 *  that say "same as default". */
export function setStatusBadgePref(
  status: PaneStatusValue,
  patch: Partial<StatusBadgePref>
): void {
  const next: StatusBadgePrefs = { ...prefs.value }
  const merged: StatusBadgePref = { ...next[status], ...patch }

  if (!merged.labelZh?.trim()) delete merged.labelZh
  if (!merged.labelEn?.trim()) delete merged.labelEn
  if (!merged.color || merged.color === DEFAULT_STATUS_COLORS[status]) delete merged.color

  if (merged.labelZh || merged.labelEn || merged.color) next[status] = merged
  else delete next[status]

  prefs.value = next
  persist(next)
}

/** Drop every override for one status. */
export function resetStatusBadgePref(status: PaneStatusValue): void {
  if (!prefs.value[status]) return
  const next: StatusBadgePrefs = { ...prefs.value }
  delete next[status]
  prefs.value = next
  persist(next)
}

/** Drop every override, restoring the shipped vocabulary and palette. */
export function resetAllStatusBadgePrefs(): void {
  if (!Object.keys(prefs.value).length) return
  prefs.value = {}
  persist({})
}

/** Test seam: reload from settings. Production code never needs this — the
 *  settings broadcast keeps the ref current. */
export function __reloadStatusBadgePrefsForTest(): void {
  prefs.value = load()
  lastSynced = JSON.stringify(prefs.value)
}

export function useStatusBadgePrefs() {
  return {
    prefs,
    hasOverrides: computed(() => Object.keys(prefs.value).length > 0),
    setStatusBadgePref,
    resetStatusBadgePref,
    resetAllStatusBadgePrefs,
  }
}
