// Bounded auto-restart for a backend that crashed after a successful start.
// Extracted electron-free (same pattern as backend-crash.ts) so it can be
// unit-tested without spawning anything.
//
// Why bounded: a backend that fails on every boot would otherwise be respawned
// forever, and each attempt pays a full health-check timeout (45 s by default)
// before failing. The attempt budget turns an unrecoverable backend into a
// terminal error the user can see instead of an invisible respawn loop.
//
// Why the stability window: resetting the counter the moment a restart
// connects would defeat the budget entirely — a backend that crashes 5 s after
// every start would reset-and-retry indefinitely. The counter only clears once
// a restarted backend has stayed up for the full window.

/** Delay before attempt 1, 2, 3 …; the array length is the attempt limit. */
export const DEFAULT_RESTART_DELAYS_MS = [1_000, 4_000, 10_000]
/** How long a restarted backend must stay healthy before the budget resets. */
export const DEFAULT_STABLE_MS = 60_000

type TimerHandle = ReturnType<typeof setTimeout>

export interface BackendAutoRestartOptions {
  /** Performs one restart attempt. Never expected to throw; failures surface
   *  through the caller's own error handling and, if the backend stays down,
   *  through the next crash. */
  restart: () => void
  /** Called when the attempt budget is exhausted, so the caller can move to a
   *  terminal error state. */
  onGiveUp?: (attempts: number) => void
  /** Called when a backend has stayed up for the full stability window — the
   *  app's single definition of "the backend is fine". Fires even when no
   *  restart was ever needed, so a clean first boot counts as stable too. */
  onStable?: () => void
  delaysMs?: number[]
  stableMs?: number
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

export interface BackendAutoRestart {
  /** Report a crash of the active backend. Returns the scheduled attempt
   *  number (1-based) when a restart was scheduled, or null when the budget is
   *  exhausted — the caller then goes to a terminal error. */
  onCrash(): number | null
  /** Report that a backend is up. Starts the stability window that clears the
   *  attempt budget and fires onStable. Call it on every successful start,
   *  including the first one of the run — with no attempts spent the budget
   *  reset is a no-op, but onStable still needs the signal. */
  onHealthy(): void
  /** Drop any pending attempt and reset the budget. Used by deliberate
   *  stop/restart/quit paths, where the exit is not a crash and a manual
   *  restart is a fresh start. */
  cancel(): void
  /** Attempts consumed so far (reset by cancel or a completed stability
   *  window). */
  attempts(): number
  /** True while a restart attempt is scheduled but has not fired yet. */
  isRestartPending(): boolean
  /** The attempt limit, for status reporting. */
  maxAttempts(): number
}

export function createBackendAutoRestart(opts: BackendAutoRestartOptions): BackendAutoRestart {
  const delays = opts.delaysMs ?? DEFAULT_RESTART_DELAYS_MS
  const stableMs = opts.stableMs ?? DEFAULT_STABLE_MS
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle))

  let attempts = 0
  let pendingTimer: TimerHandle | null = null
  let stableTimer: TimerHandle | null = null

  function clearPending(): void {
    if (pendingTimer !== null) {
      clearTimer(pendingTimer)
      pendingTimer = null
    }
  }

  function clearStable(): void {
    if (stableTimer !== null) {
      clearTimer(stableTimer)
      stableTimer = null
    }
  }

  function onCrash(): number | null {
    // A crash invalidates any in-flight stability window: the backend it was
    // measuring is the one that just died.
    clearStable()
    clearPending()
    if (attempts >= delays.length) {
      opts.onGiveUp?.(attempts)
      return null
    }
    const delay = delays[attempts]
    attempts++
    const attemptNo = attempts
    pendingTimer = setTimer(() => {
      pendingTimer = null
      opts.restart()
    }, delay)
    return attemptNo
  }

  function onHealthy(): void {
    clearStable()
    stableTimer = setTimer(() => {
      stableTimer = null
      attempts = 0
      opts.onStable?.()
    }, stableMs)
  }

  function cancel(): void {
    clearPending()
    clearStable()
    attempts = 0
  }

  return {
    onCrash,
    onHealthy,
    cancel,
    attempts: () => attempts,
    isRestartPending: () => pendingTimer !== null,
    maxAttempts: () => delays.length,
  }
}
