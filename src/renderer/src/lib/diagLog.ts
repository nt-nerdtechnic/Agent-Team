// Renderer -> backend.log bridge for latency diagnostics.
//
// The renderer writes no log file, so everything only it can observe — how long
// a pane spent in each preparation step, an IME composition that latched — was
// invisible after the fact. A "typing lags" report could be answered with PTY
// and WebSocket evidence only, which is the half that turned out to be healthy.
// These lines land in the same backend.log as the PTY events, so the two halves
// can be read against one clock.
//
// Callers are expected to gate themselves: this bridge does no thresholding and
// no throttling, because what counts as "slow" is only knowable at the call
// site. Anything sent here costs a WebSocket round-trip, so send only what a
// person reading the log would want to see.

type DiagBackend = {
  send: (type: string, payload: Record<string, unknown>) => Promise<unknown>
}

/** Fire-and-forget: a diagnostic must never delay or break the path it observes. */
export function diagLog(
  backend: DiagBackend,
  category: string,
  message: string,
  level: 'info' | 'warning' = 'info'
): void {
  try {
    void backend.send('client.diagnostic', { category, message, level }).catch(() => {})
  } catch {
    /* backend not connected — a dropped diagnostic is not worth an exception */
  }
}

/**
 * A diagLog that cannot flood.
 *
 * The probes that watch a per-keystroke path have a nasty property: the worse
 * the problem gets, the more often they fire, so an unthrottled probe adds
 * WebSocket traffic to the exact path whose slowness it is measuring. Under
 * sustained trouble the useful fact is that it is happening and roughly how
 * often — not every individual instance.
 *
 * Suppressed lines are counted and reported by the next line that gets through,
 * so throttling never makes the log understate the problem.
 */
export function createThrottledDiag(
  backend: DiagBackend,
  category: string,
  minIntervalMs: number
): (message: string, level?: 'info' | 'warning') => void {
  let lastSentAt = 0
  let suppressed = 0
  return (message, level = 'info') => {
    const now = Date.now()
    if (lastSentAt && now - lastSentAt < minIntervalMs) {
      suppressed++
      return
    }
    lastSentAt = now
    const tail = suppressed ? ` (+${suppressed} suppressed since the last line)` : ''
    suppressed = 0
    diagLog(backend, category, message + tail, level)
  }
}
