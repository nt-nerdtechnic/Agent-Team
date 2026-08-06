// Diagnostic ring buffer for the external UI action bus (ui.invoke.request).
// An MCP client can get `ok: true` back from an action that misbehaved
// in-window (e.g. injectText silently resending content because its echo
// check timed out) — the client has no way to see renderer console.warn/
// console.error output. This buffer lets that be recorded here and surfaced
// either inline on the action's reply (useUiActionBus) or pulled on demand
// (ui.diagnostics.read). Pure module state, no Vue dependency.

export type DiagnosticLevel = 'warn' | 'error'

export interface DiagnosticEntry {
  seq: number
  ts: string
  level: DiagnosticLevel
  code: string
  message: string
  paneId?: string
}

export interface RecordDiagnosticInput {
  level: DiagnosticLevel
  code: string
  message: string
  paneId?: string
}

export interface ReadDiagnosticsOptions {
  sinceSeq?: number
  paneId?: string
  limit?: number
}

const MAX_ENTRIES = 200

const buffer: DiagnosticEntry[] = []
let nextSeq = 1

/** Appends a diagnostic entry, stamping it with a monotonic `seq` and an ISO
 *  timestamp. Drops the oldest entry once the buffer exceeds MAX_ENTRIES. */
export function recordDiagnostic(entry: RecordDiagnosticInput): DiagnosticEntry {
  const recorded: DiagnosticEntry = {
    seq: nextSeq++,
    ts: new Date().toISOString(),
    level: entry.level,
    code: entry.code,
    message: entry.message,
    ...(entry.paneId !== undefined ? { paneId: entry.paneId } : {})
  }
  buffer.push(recorded)
  if (buffer.length > MAX_ENTRIES) buffer.shift()
  return recorded
}

/** Reads buffered entries, oldest to newest, optionally filtered by
 *  `sinceSeq` (exclusive), `paneId`, and capped at `limit`. */
export function readDiagnostics(opts: ReadDiagnosticsOptions = {}): DiagnosticEntry[] {
  const sinceSeq = opts.sinceSeq ?? 0
  let entries = buffer.filter((e) => e.seq > sinceSeq)
  if (opts.paneId !== undefined) entries = entries.filter((e) => e.paneId === opts.paneId)
  if (opts.limit !== undefined) entries = entries.slice(0, opts.limit)
  return entries
}

/** Entries recorded since `seq` — for "what happened during this action". */
export function takeDiagnosticsSince(seq: number, paneId?: string): DiagnosticEntry[] {
  return readDiagnostics({ sinceSeq: seq, paneId })
}

/** Current high-water mark, for a caller to record before starting an action
 *  so it can later ask takeDiagnosticsSince for only what happened during it. */
export function currentDiagnosticSeq(): number {
  return nextSeq - 1
}

/** Test-only: clears the buffer and resets the sequence counter. */
export function _resetDiagnostics(): void {
  buffer.length = 0
  nextSeq = 1
}
