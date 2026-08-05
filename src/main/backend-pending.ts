/**
 * Backends that have been spawned but whose start has not finished yet.
 *
 * Quitting mid-start has to reach the process itself. Electron exiting does not
 * take a spawned backend down — it is reparented and keeps running, holding the
 * port, the shared app-data state and its own children — while the quit path
 * gives up waiting long before a slow start finishes. That wait is short on
 * purpose, and on macOS it is routinely outrun: the login-shell PATH probe
 * alone has been measured at 13s+ before the child even exists. So ending the
 * wait early is normal, and it must not mean ending it in a leak.
 *
 * A start that finishes hands its process to a BackendHandle and leaves this
 * set — from then on `handle.stop()` is what takes it down.
 */

/** The slice of ChildProcess this needs; small enough to fake in a test. */
export interface PendingChild {
  exitCode: number | null
  kill(signal?: NodeJS.Signals): boolean
}

const pending = new Set<PendingChild>()
let abandoned = false

function killQuietly(child: PendingChild): void {
  if (child.exitCode !== null) return
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

/**
 * Put a freshly spawned backend under shutdown's control until its start
 * finishes. Returns false when a quit already gave up waiting: the child
 * spawned into a shutdown, has been taken down again, and the caller must not
 * go on waiting for it.
 */
export function registerPendingBackend(child: PendingChild): boolean {
  if (abandoned) {
    killQuietly(child)
    return false
  }
  pending.add(child)
  return true
}

/** The start finished: its handle owns the process now (or it is already dead). */
export function releasePendingBackend(child: PendingChild): void {
  pending.delete(child)
}

/**
 * Kill every backend still starting, and make one that spawns after this call
 * die on arrival. Shutdown only, and one-way on purpose: the app is going away,
 * so the alternative to killing these is leaving them running without it.
 */
export function abandonPendingBackends(): void {
  abandoned = true
  for (const child of pending) killQuietly(child)
  pending.clear()
}
