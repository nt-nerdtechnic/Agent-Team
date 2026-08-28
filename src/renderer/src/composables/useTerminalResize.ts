import type { Ref, ShallowRef } from 'vue'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { useBackend } from './useBackend'

type BackendSend = ReturnType<typeof useBackend>['send']

export interface ResizeController {
  applyFit(): void
  sendResizeNow(): void
  requestResizeRedraw(): void
  readonly ackedCols: number
  readonly ackedRows: number
  attachObserver(el: HTMLElement): void
  dispose(): void
}

// Handles all terminal resize logic: debounced ResizeObserver, xterm FitAddon,
// PTY size sync, and post-resize TUI redraw. Extracted from useTerminal so
// resize concerns live in one focused module.
export function createResizeController(
  term: Terminal,
  fit: FitAddon,
  sessionId: Ref<string>,
  containerRef: ShallowRef<HTMLElement | null>,
  lastRawActivityAt: Ref<number>,
  send: BackendSend,
  getPendingSpawn: () => boolean,
  onCreateWhenMeasurable: () => void,
): ResizeController {
  // How long the container must be quiet before we fit + send resize.
  // Also the quiet-gap gate in armResizeRedraw.
  const RESIZE_QUIET_MS = 250
  // Settle window before firing the TUI redraw after a width change.
  const RESIZE_REDRAW_SETTLE_MS = 220
  // Maximum wait before forcing the TUI redraw even on a busy agent.
  const RESIZE_REDRAW_MAX_WAIT_MS = 1500

  let resizeObserver: ResizeObserver | null = null
  let resizeRafId = 0
  // rAF is throttled/paused while a window is occluded or mid-fullscreen
  // transition, so a fit scheduled purely on rAF can be lost when the dev
  // window is behind another (then the terminal stays at its stale width —
  // visible as empty space on the right). This timer is the fallback so the
  // fit still runs. Mirrors the rAF+timeout pattern spawn() already uses.
  let resizeFrameTimer: ReturnType<typeof setTimeout> | null = null
  // Debounce before applyFit so layout churn fires one resize, not dozens.
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null
  // Last size the backend confirmed. Reconciler compares against this so a
  // dropped resize message is retried instead of desyncing forever.
  let _ackedCols = 0
  let _ackedRows = 0
  let resizeRedrawTimer: ReturnType<typeof setTimeout> | null = null
  let resizeRedrawDeadline = 0
  let lastRedrawCols = 0
  // True while the observer is attached (mount…dispose lifecycle).
  let active = false

  function sendResize(cols: number, rows: number): Promise<boolean> {
    if (!sessionId.value) return Promise.resolve(false)
    return send('terminal.resize', {
      terminal_session_id: sessionId.value,
      cols,
      rows,
    }).then((resp) => {
      if (resp?.ok) {
        _ackedCols = cols; _ackedRows = rows
        return true
      }
      return false
    }).catch(() => false /* reconciler retries */)
  }

  function sendResizeNow(): void {
    void sendResize(term.cols, term.rows)
  }

  // Run `cb` on the next animation frame, but fall back to a timer if rAF
  // doesn't fire in time — rAF is paused for occluded/background windows and
  // during fullscreen transitions, which would otherwise strand a pending fit.
  function scheduleFrame(cb: () => void): void {
    cancelAnimationFrame(resizeRafId)
    if (resizeFrameTimer) { clearTimeout(resizeFrameTimer); resizeFrameTimer = null }
    let fired = false
    const fire = (): void => {
      if (fired) return
      fired = true
      cancelAnimationFrame(resizeRafId)
      if (resizeFrameTimer) { clearTimeout(resizeFrameTimer); resizeFrameTimer = null }
      cb()
    }
    resizeRafId = requestAnimationFrame(fire)
    resizeFrameTimer = setTimeout(fire, 100)
  }

  // Single source of truth for sizing: fit xterm to its container, then push
  // that size to the backend. Entry points: the (debounced) ResizeObserver,
  // the post-spawn frame, the reconciler, and fitTerminal().
  function applyFit(): void {
    let poked = false
    const run = (): void => {
      const el = containerRef.value
      // Hidden (display:none ancestor → clientWidth 0): nothing to fit. It will
      // be retried by the ResizeObserver when the pane is shown.
      if (!el || el.clientWidth === 0) return
      // xterm hasn't measured its character cell yet — happens when the pane was
      // opened while hidden. fit.fit() is a no-op while cell.width is 0, so poke
      // xterm once to force measurement, then retry next frame until it's ready.
      if ((term as any)._core?._renderService?.dimensions?.css?.cell?.width === 0) {
        if (!poked) {
          try { term.resize(Math.max(term.cols, 2), Math.max(term.rows, 1)) } catch { /* ignore */ }
          poked = true
        }
        scheduleFrame(run)
        return
      }
      try {
        // VSCode-aligned ordering: resize xterm to the container FIRST, then
        // tell the PTY. The PTY resize raises SIGWINCH, so the CLI repaints its
        // cursor line (the live footer) directly into an already-correctly-sized
        // xterm — nothing reflows that fresh frame afterward. xterm does not
        // reflow the cursor line itself (reflowCursorLine defaults to false), so
        // the CLI owns that repaint; we just give it the right width first.
        //
        // This replaces the old shrink-grace dance (push PTY narrow first, wait
        // PTY_REPAINT_GRACE_MS, then fit xterm). That ordering left the CLI's
        // narrow repaint sitting in a still-wide xterm, which the subsequent
        // narrowing reflowed into the garbled-footer residue. The backend still
        // drains output around its resize ack, so ordering is preserved server
        // side; the brief client window where xterm is narrower than the PTY is
        // the same tradeoff VSCode's integrated terminal accepts.
        fit.fit()
        sendResizeNow()
      } catch { /* ignore transient fit errors during teardown */ }
    }
    scheduleFrame(run)
  }

  // After a width change settles, one SIGWINCH-based force_redraw makes the TUI
  // repaint cleanly at the new width — clearing the reflow residue xterm leaves
  // when it re-wraps the old frame (the garbled status footer on narrow
  // drag-resize). Gated so it fires once per settle, only on a real WIDTH
  // change, and only when xterm == backend-acked. We PREFER a quiet gap so the
  // repaint isn't interleaved with a burst, but a continuously-streaming agent
  // never goes quiet — so after a bounded wait we fire anyway (a SIGWINCH is
  // safe mid-output; it's exactly what a real terminal resize raises). Called
  // from the ResizeObserver path (genuine layout churn) and from _doCreate()
  // after a fresh spawn/resume — both can settle at a width that differs from
  // the one the CLI's first frame was drawn at, and only a SIGWINCH-based
  // repaint (not a numeric resize) fixes already-printed content.
  function requestResizeRedraw(): void {
    resizeRedrawDeadline = Date.now() + RESIZE_REDRAW_MAX_WAIT_MS
    armResizeRedraw()
  }

  // Internal poll: reschedules without resetting the deadline so a busy pane
  // can't postpone the redraw indefinitely.
  function armResizeRedraw(): void {
    if (resizeRedrawTimer) clearTimeout(resizeRedrawTimer)
    resizeRedrawTimer = setTimeout(() => {
      resizeRedrawTimer = null
      if (!active || !sessionId.value) return
      // Not fully settled yet (xterm still differs from the backend-acked size):
      // wait for the resize to finish, then re-check — but not past the deadline,
      // or a stalled/lost resize ack would postpone the redraw forever. force_redraw
      // sets the winsize to term's size anyway, so firing unacked still self-corrects.
      if ((term.cols !== _ackedCols || term.rows !== _ackedRows) && Date.now() < resizeRedrawDeadline) {
        armResizeRedraw(); return
      }
      // Width unchanged since the last clean repaint (rows-only / no-op): skip.
      if (term.cols === lastRedrawCols) return
      // Prefer a quiet gap, but don't wait past the deadline for a busy agent.
      // Exception: an alt-buffer TUI (Claude Code, vim, …) streams footer/spinner
      // bytes continuously so it never goes quiet, and xterm cannot reflow the
      // alternate buffer — the reflow residue (garbled footer on drag-resize)
      // stays visible until the CLI itself repaints. A SIGWINCH repaint is a full
      // ESC[2J + absolute redraw (safe mid-output), so for alt-buffer panes we
      // skip the quiet wait and fire at settle instead of stalling to the deadline.
      const altBuffer = term.buffer?.active?.type === 'alternate'
      const quiet = altBuffer || Date.now() - lastRawActivityAt.value >= RESIZE_QUIET_MS
      if (!quiet && Date.now() < resizeRedrawDeadline) { armResizeRedraw(); return }
      lastRedrawCols = term.cols
      // NOTE: we deliberately do NOT term.clear() on a width shrink. Wiping the
      // scrollback drops the user's conversation history (and, on a rebuild/
      // resume, the freshly reprinted transcript). Per user decision
      // (2026-06-23): never clear history — accept any reflow residue, repaint
      // the current frame via the SIGWINCH redraw below instead.
      void send('terminal.redraw', {
        terminal_session_id: sessionId.value,
        cols: term.cols,
        rows: term.rows,
      })
    }, RESIZE_REDRAW_SETTLE_MS)
  }

  // Wire up a ResizeObserver on the terminal container element. Debounced:
  // xterm holds its old size through layout churn, then fits once the
  // container is still.
  function attachObserver(el: HTMLElement): void {
    active = true
    resizeObserver = new ResizeObserver(() => {
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer)
      resizeDebounceTimer = setTimeout(() => {
        resizeDebounceTimer = null
        // A hidden-tab pane parked its spawn; becoming measurable (the tab was
        // shown) fires this — create the PTY now, at the real width.
        if (getPendingSpawn()) { onCreateWhenMeasurable(); return }
        applyFit()
        // Once this resize settles, repaint the TUI clean at the new width.
        requestResizeRedraw()
      }, RESIZE_QUIET_MS)
    })
    resizeObserver.observe(el)
  }

  // Release all timers and the ResizeObserver. Called from onScopeDispose.
  function dispose(): void {
    active = false
    cancelAnimationFrame(resizeRafId)
    if (resizeFrameTimer) clearTimeout(resizeFrameTimer)
    if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer)
    if (resizeRedrawTimer) clearTimeout(resizeRedrawTimer)
    resizeObserver?.disconnect()
  }

  return {
    applyFit,
    sendResizeNow,
    requestResizeRedraw,
    get ackedCols() { return _ackedCols },
    get ackedRows() { return _ackedRows },
    attachObserver,
    dispose,
  }
}
