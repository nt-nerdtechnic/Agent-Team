// Pull a lazy chunk into memory before anybody asks for it.
//
// The two windows the title bar opens are `defineAsyncComponent`, so the first
// click pays for fetching and parsing the chunk before anything is drawn — and
// a click that draws nothing reads as a click that did nothing. Measured from
// the production build on this machine: SettingsModal is 507 KB of JavaScript,
// ~315 ms to parse, plus a 150 KB stylesheet; AccountModal 67 KB, ~25 ms, plus
// 18 KB.
//
// Settings already had a warm of exactly this shape written inline in App.vue;
// the account window had none. This is that code, shared, cancellable and
// tested, rather than a second mechanism beside it.
//
// The scheduling is the whole design. Idle is the right moment — not a fixed
// delay, which would only push the warm past clicks that arrive in the opening
// seconds — and the deadline is what stops a window that never goes idle from
// never warming at all.

export interface PrewarmClock {
  setTimeout: (fn: () => void, ms: number) => number
  clearTimeout: (id: number) => void
  /** Absent in older engines and in jsdom; the caller falls back to a timer. */
  requestIdleCallback?: (fn: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}

export interface PrewarmOptions {
  /** How long to wait for an idle moment before going ahead anyway. */
  idleTimeoutMs: number
  /** Used only where there is no idle scheduler at all. */
  fallbackDelayMs: number
  clock: PrewarmClock
}

/**
 * Run `load` once, at the first idle moment. Returns a disposer that cancels it
 * if it has not run yet.
 *
 * `load` is called at most once however the timers and the disposer interleave:
 * a prewarm that ran twice would parse the same chunk twice for nothing.
 */
export function schedulePrewarm(load: () => void, opts: PrewarmOptions): () => void {
  const { clock } = opts
  let done = false
  let timerId: number | null = null
  let idleId: number | null = null

  const run = () => {
    if (done) return
    done = true
    load()
  }

  if (clock.requestIdleCallback) {
    idleId = clock.requestIdleCallback(run, { timeout: opts.idleTimeoutMs })
  } else {
    timerId = clock.setTimeout(run, opts.fallbackDelayMs)
  }

  return () => {
    if (done) return
    done = true
    if (timerId !== null) clock.clearTimeout(timerId)
    if (idleId !== null) clock.cancelIdleCallback?.(idleId)
  }
}
