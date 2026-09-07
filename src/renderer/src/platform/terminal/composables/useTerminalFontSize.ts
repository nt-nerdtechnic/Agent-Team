import { ref } from 'vue'

export const DEFAULT_FONT_SIZE = 12

const STORAGE_KEY = 'terminal.fontSize'

function loadPersisted(): number {
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
  // Guard the missing key explicitly: Number(null) is 0, which is finite.
  const raw = stored === null ? NaN : Number(stored)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_FONT_SIZE
  const size = Math.round(raw)
  return size > 0 ? size : DEFAULT_FONT_SIZE
}

/**
 * Terminal font size, shared by EVERY terminal pane in the window.
 *
 * This is deliberately module-level rather than per-pane: zooming is a single
 * app-wide setting, so all CLI panes stay the same size and newly-spawned panes
 * pick up the current size. Each terminal watches this ref (see useTerminal).
 *
 * This ref scales terminal CONTENT only. Scaling the app chrome and layout is a
 * separate setting (Settings -> Appearance, src/shared/uiScale.ts) applied by
 * the main process as Electron page zoom, and the two multiply the way a
 * browser's page zoom multiplies with a site's own font size. The built-in
 * Electron menu's zoomIn/zoomOut/resetZoom roles are still omitted in
 * src/main/menu.ts — their native accelerators would fire ahead of both.
 */
export const terminalFontSize = ref(loadPersisted())

function setFontSize(next: number): void {
  if (!Number.isFinite(next) || next <= 0 || next === terminalFontSize.value) return
  terminalFontSize.value = next
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, String(next))
}

export function zoomIn(): void { setFontSize(terminalFontSize.value + 1) }
export function zoomOut(): void { setFontSize(terminalFontSize.value - 1) }
export function zoomReset(): void { setFontSize(DEFAULT_FONT_SIZE) }

let installed = false

/**
 * Bind ⌘= / ⌘- / ⌘0 at the window level.
 *
 * Shift-bearing variants are deliberately excluded: ⇧⌘= / ⇧⌘- / ⇧⌘0 belong to
 * interface zoom (src/shared/uiScale.ts), which is dispatched by the keybinding
 * registry through another capture-phase listener on this same window. Without
 * an explicit guard here, which one won would depend on listener registration
 * order — the registry mounts with the app root, this installs with the first
 * pane — and nothing enforces that order.
 *
 * This must NOT live on xterm's `attachCustomKeyEventHandler`: that only fires
 * while a terminal's hidden helper textarea holds focus, so the shortcut would
 * silently do nothing whenever focus sat anywhere else (a pane title input, the
 * chat box, a pane that merely *looks* focused) — and it could only ever resize
 * the one terminal that had focus, not all of them.
 *
 * Capture phase, so it wins over anything downstream. Idempotent: every pane
 * calls this, but only the first call binds.
 */
export function installTerminalZoomShortcuts(): void {
  if (installed) return
  installed = true

  // Cross-window sync: each renderer window has its own copy of this module,
  // so a zoom in one window only reaches the others via localStorage. The
  // `storage` event fires only in OTHER windows (never the writer), so there
  // is no self-loop. loadPersisted re-reads the store and keeps its guards,
  // so a garbage value falls back to the default instead of poisoning the ref.
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return
    terminalFontSize.value = loadPersisted()
  })

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) return
    // Match `code` so keyboard-layout differences cannot break zoom-in. `+`
    // still reaches here unshifted from a numeric keypad (NumpadAdd); the
    // shifted ⇧⌘= form is interface zoom's, not this one's.
    if (!e.shiftKey && (e.code === 'Equal' || e.key === '=' || e.key === '+')) zoomIn()
    else if (!e.shiftKey && (e.code === 'Minus' || e.key === '-')) zoomOut()
    else if (!e.shiftKey && (e.code === 'Digit0' || e.key === '0')) zoomReset()
    else return
    e.preventDefault()
  }, true)
}
