/** Stop the cursor-blink timer a WebGL addon leaves behind when it is disposed.
 *
 *  @xterm/addon-webgl 0.19 does not clean this up. WebglRenderer registers
 *  every other MutableDisposable it owns —
 *
 *    private _cursorBlinkStateManager = new MutableDisposable()              // 32
 *    private _charAtlasDisposable = this._register(new MutableDisposable())  // 33
 *    private _observerDisposable  = this._register(new MutableDisposable())  // 37
 *
 *  — but not line 32, so disposing the renderer never disposes the blink
 *  manager, and its 600 ms setInterval keeps firing forever, each tick
 *  scheduling a requestAnimationFrame that redraws a renderer that is gone.
 *  CursorBlinkStateManager lives only in the WebGL addon (the DOM renderer
 *  blinks with a CSS class and no timer), so this is the only source of them.
 *
 *  It matters here more than in a normal xterm embedding because a pane gives
 *  its WebGL context up whenever it leaves the screen — Chromium caps how many
 *  a page may hold — so one timer leaks per show/hide cycle rather than one per
 *  terminal. Measured on a 30-pane window: 3 live WebGL renderers, 21 blink
 *  timers running.
 *
 *  handleBlur() is the renderer's own public way to stop the timer: it pauses
 *  the manager, which clears the interval and its pending timeout. Telling a
 *  renderer it lost focus one call before it is thrown away changes nothing an
 *  observer can see — the DOM renderer that takes over reads focus from the
 *  terminal core, which this does not touch.
 *
 *  Reached through the addon's private `_renderer` because the addon's public
 *  surface exposes no way to stop it. If a future xterm renames the field this
 *  quietly does nothing and the leak returns, which is why the fix is here, in
 *  one named place, rather than inlined at the dispose call.
 */
export function stopWebglCursorBlink(addon: unknown): void {
  const renderer = (addon as { _renderer?: { handleBlur?: () => void } } | null)?._renderer
  try {
    renderer?.handleBlur?.()
  } catch {
    /* A renderer whose context was lost may throw; it is being disposed anyway. */
  }
}
