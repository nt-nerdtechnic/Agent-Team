// Interface-level zoom: scales the whole Navide chrome — text, icons, borders,
// spacing — by driving Electron's page zoom factor rather than a CSS variable.
//
// A CSS/rem approach cannot work in this codebase: hundreds of `font-size: Npx`
// declarations and every inline SVG icon (`width="16"`) are hard-coded pixels
// that ignore the root font size, so icons would stay put while text grew.
// Page zoom scales the rendered CSS pixel itself, so every one of them follows
// with no per-call-site change.
//
// Shared by the main process (which owns the factor and applies it to every
// WebContents, including plugin windows) and the renderer (Settings UI and
// keyboard shortcuts). Keep this module dependency-free so both sides can
// import it.

/** Settings-store key (ui_settings.json via the renderer's lib/settings.ts). */
export const UI_SCALE_SETTING_KEY = 'agentTeam.uiScale'

export const DEFAULT_UI_SCALE = 1
export const MIN_UI_SCALE = 0.8
export const MAX_UI_SCALE = 1.5

/**
 * Discrete steps the UI offers (Settings dropdown and the zoom shortcuts).
 * Bounded by MIN/MAX above; a stored value between steps stays valid and is
 * only snapped when the user steps through with a shortcut.
 */
export const UI_SCALE_STEPS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25, 1.5]

/**
 * Coerce a stored/UI value into [MIN, MAX], rounded to whole percent.
 * Anything unparseable — including an empty input the user just cleared —
 * falls back to 100%.
 */
export function clampUiScale(v: unknown): number {
  if (v === '' || v === null || v === undefined) return DEFAULT_UI_SCALE
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_UI_SCALE
  const rounded = Math.round(n * 100) / 100
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, rounded))
}

/**
 * Step one notch through UI_SCALE_STEPS. A current value that sits between
 * steps moves to the next step beyond it in that direction, so zooming never
 * appears to do nothing. Already at the end of the ladder → unchanged.
 */
export function stepUiScale(current: unknown, direction: 1 | -1): number {
  const value = clampUiScale(current)
  if (direction === 1) {
    const next = UI_SCALE_STEPS.find((s) => s > value + 1e-9)
    return next ?? clampUiScale(UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1])
  }
  const prev = [...UI_SCALE_STEPS].reverse().find((s) => s < value - 1e-9)
  return prev ?? clampUiScale(UI_SCALE_STEPS[0])
}

/** Format a factor for display, e.g. 1.25 → "125%". */
export function formatUiScale(v: unknown): string {
  return `${Math.round(clampUiScale(v) * 100)}%`
}
