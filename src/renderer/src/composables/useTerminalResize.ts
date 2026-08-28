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
  // Bumped by every applyFit that starts an ack round-trip, so a resize whose
  // ack comes back late can tell that it has been superseded. See applyFit.
  let resizeGeneration = 0
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

  // The half of FitAddon.fit() that touches xterm: drop the renderer's cached
  // dimensions so it re-measures, then resize. Split out from proposeDimensions()
  // so applyFit can put the backend's ack between the two (see below).
  //
  // Resize inline. An earlier attempt deferred this behind term.write('', cb) so
  // the resize would land in byte-stream order rather than wall-clock order.
  // That was reverted, but honestly: not because it was measured worse. Both
  // orderings push roughly the same number of rows out of the viewport across a
  // drag (+32 vs +40 over 12 steps on a pre-scrolled buffer), and so does the
  // ordering that predates the ack barrier — the growth comes from reflowing a
  // frame that has already been materialised, which every ordering does
  // somewhere. With no measurable difference between them, this keeps the
  // simpler one.
  //
  // What the ack barrier above does fix is separate and is measured: an
  // old-width frame parsed at the new width leaves wrapped fragments in the
  // scrollback, where the CLI's repaint (viewport-only) can never reach them.
  function resizeTermTo(cols: number, rows: number): void {
    if (term.cols === cols && term.rows === rows) return
    try { (term as any)._core?._renderService?.clear() } catch { /* renderer not up yet */ }
    term.resize(cols, rows)
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
        // Resize xterm only once the backend has ACKED the new size — the ack
        // is an ordering barrier, not a receipt.
        //
        // Both naive orderings have shipped here, and both stranded residue
        // from opposite directions:
        //   PTY first  → the CLI's new-width repaint lands in a still-old-width
        //                xterm (the old shrink-grace dance; garbled footer).
        //   xterm first → a frame the CLI drew for the OLD width lands in an
        //                already-resized xterm (what this replaces).
        // Either way xterm soft-wraps the overhang, the wrapped remainder
        // scrolls out of the viewport, and the CLI can never repaint over it:
        // its redraw is ESC[H + ESC[2K per row (or ESC[2J), which address the
        // viewport only. Fragments that reach the scrollback are permanent —
        // the "one long line, one short line" divider. So the fix is not to
        // pick the other naive order; it is to leave no window at all.
        //
        // terminals.drain_output() flushes every buffered old-width byte and
        // AWAITS each emit before the ioctl, and terminal.output frames share
        // Session._send_lock with this ack — so on the wire it is strictly
        // old-width output < ack < new-width output. Resizing on the ack puts
        // xterm on the same side of that boundary as the bytes it renders.
        //
        // Pinned by useTerminalResize.widthRace.test.ts, which replays recorded
        // claude output through a real xterm buffer.
        const dims = fit.proposeDimensions()
        const cols = dims && Number.isFinite(dims.cols) ? dims.cols : term.cols
        const rows = dims && Number.isFinite(dims.rows) ? dims.rows : term.rows
        // No PTY yet (parked spawn, teardown): nothing is in flight, so there is
        // no barrier to wait for — and xterm must still fit its container.
        if (!sessionId.value) { resizeTermTo(cols, rows); return }
        // Already the right size: still tell the backend, exactly as before, so
        // a pane whose first fit is a no-op does not leave the PTY unsized.
        if (cols === term.cols && rows === term.rows) { sendResizeNow(); return }
        // Dragging is not a sequence of discrete resizes. The container changes
        // width dozens of times, applyFit re-enters long before the previous ack
        // returns, and several round-trips are in flight at once — each closing
        // over the size IT asked for. Without this guard a straggling ack puts
        // xterm back to a width the user has already dragged past, and it stays
        // there until the 2s reconciler notices: the PTY is at the new width, the
        // CLI lays its frame out for the new width, and that frame renders into
        // a terminal set to the old one. That is how two dividers of different
        // lengths (both full, neither wrapped) end up on screen at once, and why
        // a word like "tokens" gets its tail pushed onto its own line. Only
        // reachable from a real drag, which is why discrete-resize replays never
        // showed it — confirmed by CDP drag A/B against v0.
        const generation = ++resizeGeneration
        void sendResize(cols, rows).then((ok) => {
          // Superseded by a newer resize while this one was in flight: that one
          // owns xterm's size now, and the backend already has its width too.
          if (generation !== resizeGeneration) return
          // A lost or failed ack deliberately leaves xterm at its old size.
          // useBackend rejects in-flight requests when the socket goes down, so
          // this resolves false rather than hanging, and it self-heals from two
          // directions: the 2s reconciler compares proposeDimensions() against
          // term and calls applyFit again, and reattachAfterReconnect fits on
          // reconnect. The cost is that a pane stays visually unfitted while the
          // backend is unreachable — which is also when nothing can arrive to
          // reflow, so refitting blindly would buy nothing.
          if (ok) resizeTermTo(cols, rows)
        })
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
      // Exception: an alt-buffer TUI (vim, less, …) streams continuously so it
      // never goes quiet, and xterm cannot reflow the alternate buffer — residue
      // there stays until the CLI itself repaints. A SIGWINCH repaint is safe
      // mid-output, so for alt-buffer panes we fire at settle rather than stall
      // to the deadline.
      //
      // NOTE: Claude Code is NOT one of them, despite what this comment and
      // agents/claude.ts's `fullScreenTui: true` used to claim. Measured against
      // a real PTY (claude 2.1.250): ESC[?1049h, ESC[?1047h and ESC[?47h all
      // occur zero times — it lives in the normal buffer and repaints with
      // ESC[H + ESC[2K per row. The runtime check below is what actually
      // decides, so this branch simply never applies to a claude pane.
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
