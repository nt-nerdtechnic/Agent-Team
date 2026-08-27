// Debounce for the system-resume reconnect, extracted so it can be unit-tested
// without an Electron runtime (same pattern as backend-broadcast.ts, see
// vitest.config.ts's "electron-free main-process modules" comment).
//
// Waking a Mac can deliver 'resume' more than once in quick succession — a
// dark wake promoted to a full wake, or a lid open landing on the tail of a
// maintenance cycle. Each one tears down and rebuilds every WebSocket, so an
// undebounced burst can keep the transport permanently mid-handshake: exactly
// the outage the reconnect exists to end. Collapsing a burst to its first
// event keeps the prompt reconnect without letting it repeat.

export interface ResumeGate {
  /** True when this resume should trigger a reconnect. */
  admit(nowMs: number): boolean
}

export function createResumeGate(windowMs = 3_000): ResumeGate {
  let lastAdmitted: number | null = null
  return {
    admit(nowMs: number): boolean {
      if (lastAdmitted !== null && nowMs - lastAdmitted < windowMs) return false
      lastAdmitted = nowMs
      return true
    },
  }
}
