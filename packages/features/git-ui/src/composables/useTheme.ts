import { ref } from 'vue'
import { settingsGet, settingsSet } from '../lib/settings'

/**
 * useTheme — theme selection + custom color overrides.
 *
 * Design (resolved 2026-06-04, storage moved to the settings module 2026-07):
 * - The user-level settings store (lib/settings → ui_settings.json) is the
 *   SOURCE OF TRUTH. Theme is a user-level preference, consistent across all
 *   workspaces; switching workspace does NOT change it.
 * - The backend workspace JSON `theme` / `theme_custom` fields are dormant
 *   legacy backups: no longer written by the renderer, only read as a one-time
 *   fallback (then promoted into the settings store). On startup the load
 *   order is: settings store → backend fallback → 'dark-github'.
 * - Custom overrides are a key→value map of CSS variables layered ON TOP of the
 *   currently selected built-in theme. Switching built-in theme KEEPS overrides;
 *   only resetCustom() clears them.
 */

export interface ThemeMeta {
  id: string
  label: string
}

export const BUILTIN_THEMES: ThemeMeta[] = [
  { id: 'dark-github', label: 'Dark (GitHub)' },
  { id: 'dark-midnight', label: 'Midnight' },
  { id: 'dark-forest', label: 'Forest' },
  { id: 'light', label: 'Light' },
  { id: 'high-contrast', label: 'High Contrast' },
]

export const DEFAULT_THEME = 'dark-github'

/** The 8 semantic tokens exposed to the custom color picker (Phase E). */
export const CUSTOMIZABLE_TOKENS: ThemeMeta[] = [
  { id: '--bg-base', label: 'Background' },
  { id: '--bg-subtle', label: 'Surface' },
  { id: '--text-primary', label: 'Text' },
  { id: '--text-secondary', label: 'Muted Text' },
  { id: '--border-default', label: 'Border' },
  { id: '--accent-fg', label: 'Accent' },
  { id: '--success-fg', label: 'Success' },
  { id: '--danger-fg', label: 'Danger' },
]

const THEME_KEY = 'agent-team:theme'
const CUSTOM_KEY = 'agent-team:theme-custom'

const VALID_IDS = new Set(BUILTIN_THEMES.map((t) => t.id))

// Module-level singleton state — shared across every component that calls useTheme().
const theme = ref<string>(DEFAULT_THEME)
const customOverrides = ref<Record<string, string>>({})

function docEl(): HTMLElement | null {
  return typeof document !== 'undefined' ? document.documentElement : null
}

// Values stay JSON-encoded strings in the settings store — the exact encoding
// the legacy localStorage entries used, so migrated values read back verbatim.
function readLocal<T>(key: string): T | null {
  try {
    const raw = settingsGet<string | null>(key, null)
    return raw == null ? null : (JSON.parse(raw) as T)
  } catch {
    return null
  }
}

function writeLocal(key: string, value: unknown): void {
  settingsSet(key, JSON.stringify(value))
}

/** Apply the `data-theme` attribute so theme token files take effect. */
function applyThemeAttr(id: string): void {
  docEl()?.setAttribute('data-theme', id)
}

/** Apply custom CSS var overrides inline on <html>, replacing any previous set. */
function applyOverrides(overrides: Record<string, string>): void {
  const el = docEl()
  if (!el) return
  // Clear stale overrides that are no longer present.
  for (const token of CUSTOMIZABLE_TOKENS) {
    if (!(token.id in overrides)) el.style.removeProperty(token.id)
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v) el.style.setProperty(k, v)
    else el.style.removeProperty(k)
  }
}

export function useTheme() {
  /**
   * Load theme from the settings store, falling back to the backend-provided
   * value, then the default. Applies immediately. Returns whether the store
   * already held a value (so callers know if the backend fallback was used).
   */
  function loadTheme(backendFallback?: { theme?: string; theme_custom?: Record<string, string> }): {
    fromLocal: boolean
  } {
    const localTheme = readLocal<string>(THEME_KEY)
    const localCustom = readLocal<Record<string, string>>(CUSTOM_KEY)
    const fromLocal = localTheme != null

    let next = localTheme ?? backendFallback?.theme ?? DEFAULT_THEME
    if (!VALID_IDS.has(next)) next = DEFAULT_THEME
    const nextCustom = localCustom ?? backendFallback?.theme_custom ?? {}

    theme.value = next
    customOverrides.value = { ...nextCustom }
    applyThemeAttr(next)
    applyOverrides(customOverrides.value)

    // If we adopted the backend value (no local copy), promote it to the source
    // of truth so subsequent loads are stable.
    if (!fromLocal && (backendFallback?.theme || backendFallback?.theme_custom)) {
      writeLocal(THEME_KEY, next)
      writeLocal(CUSTOM_KEY, customOverrides.value)
    }
    return { fromLocal }
  }

  /** Switch the active built-in theme. Custom overrides are preserved. */
  function setTheme(id: string): void {
    if (!VALID_IDS.has(id)) return
    theme.value = id
    applyThemeAttr(id)
    writeLocal(THEME_KEY, id)
  }

  /** Set or clear a single custom override and re-apply. */
  function setCustomOverride(token: string, value: string | null): void {
    const next = { ...customOverrides.value }
    if (value) next[token] = value
    else delete next[token]
    customOverrides.value = next
    applyOverrides(next)
    writeLocal(CUSTOM_KEY, next)
  }

  /** Replace the whole override map (used for live preview commits). */
  function setCustomOverrides(overrides: Record<string, string>): void {
    customOverrides.value = { ...overrides }
    applyOverrides(customOverrides.value)
    writeLocal(CUSTOM_KEY, customOverrides.value)
  }

  /** Clear all custom overrides, returning to the pure built-in theme. */
  function resetCustom(): void {
    customOverrides.value = {}
    applyOverrides({})
    writeLocal(CUSTOM_KEY, {})
  }

  return {
    theme,
    customOverrides,
    BUILTIN_THEMES,
    CUSTOMIZABLE_TOKENS,
    loadTheme,
    setTheme,
    setCustomOverride,
    setCustomOverrides,
    resetCustom,
  }
}
