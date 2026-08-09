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
