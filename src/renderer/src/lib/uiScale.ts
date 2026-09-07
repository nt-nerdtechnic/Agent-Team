// Renderer side of the interface-scale setting.
//
// Persistence goes through the normal settings facade (ui_settings.json), so
// the value survives restarts and other windows see it via the settings
// broadcast. The visible zoom itself is applied by the main process, which
// owns every WebContents — see src/main/ui-zoom-store.ts. Writing the setting
// and asking main to apply it are therefore two separate steps: the IPC lands
// immediately (no visible lag) while the settings write is debounced.

import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import {
  clampUiScale,
  DEFAULT_UI_SCALE,
  stepUiScale,
  UI_SCALE_SETTING_KEY
} from '../../../shared/uiScale'

export {
  clampUiScale,
  DEFAULT_UI_SCALE,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  UI_SCALE_SETTING_KEY,
  UI_SCALE_STEPS,
  formatUiScale
} from '../../../shared/uiScale'

/** Current interface scale, read live from the settings cache. */
export function getUiScale(): number {
  return clampUiScale(settingsGet(UI_SCALE_SETTING_KEY, DEFAULT_UI_SCALE))
}

/**
 * Persist a new scale and ask the main process to apply it to every window.
 * Returns the clamped value that was stored, so callers can reflect back the
 * value that actually took effect rather than the raw input.
 */
export function setUiScale(next: unknown): number {
  const scale = clampUiScale(next)
  settingsSet(UI_SCALE_SETTING_KEY, scale)
  // Plugin bundles run on a preload without this bridge, so the call is a no-op
  // there and nothing re-zooms until the next launch (main reads the stored
  // value at startup). Every surface that can change the scale — Settings and
  // the zoom shortcuts — lives in a host window that does have the bridge.
  void window.agentTeam?.setUiScale?.(scale)
  return scale
}

/** Move one notch up (+1) or down (-1) the scale ladder and apply it. */
export function stepUiScaleBy(direction: 1 | -1): number {
  return setUiScale(stepUiScale(getUiScale(), direction))
}

/** Restore 100%. */
export function resetUiScale(): number {
  return setUiScale(DEFAULT_UI_SCALE)
}
