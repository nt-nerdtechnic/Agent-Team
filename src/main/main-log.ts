import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Append one timestamped line to `<userData>/logs/main.log`, beside the
 * backend's own log.
 *
 * The main process only had stdout, which a packaged launch discards. A
 * degradation that merely `console.warn`ed — the Git v2 → legacy recovery
 * reason above all — therefore left no evidence at all once the app was
 * running, and the reason could not be recovered afterwards. Best-effort by
 * design: a logging failure must never take down the caller.
 */
export function logMain(line: string): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'main.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* observability is never worth a crash */
  }
}

/** `console.warn` for a live terminal, plus a durable line for a packaged run. */
export function warnMain(line: string): void {
  console.warn(line)
  logMain(line)
}
