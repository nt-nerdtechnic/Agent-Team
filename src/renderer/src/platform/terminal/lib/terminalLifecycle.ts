export interface TerminalStartupProbe {
  binary_path?: string
  version?: string
  duration_ms?: number
}

export interface TerminalExitDetails {
  reason: string
  exit_code: number | null
  uptime_ms?: number | null
  signal?: string | null
  startup_probe?: TerminalStartupProbe | null
}

export interface CrashLoopState {
  count: number
  open: boolean
}

export const TERMINAL_CREATE_TIMEOUT_MS = 30_000

const FAST_EXIT_MS = 1_000
const CRASH_LIMIT = 3
const crashLoops = new Map<string, CrashLoopState>()

export function terminalCrashKey(input: {
  agentKey?: string
  cwd: string
  resumeKey?: string
  command: string | string[]
}): string {
  const command = Array.isArray(input.command) ? input.command.join('\u0000') : input.command
  return [input.agentKey ?? 'terminal', input.cwd, input.resumeKey || command].join('\u0001')
}

export function recordTerminalExit(
  key: string,
  exit: TerminalExitDetails,
  fastExitMs = FAST_EXIT_MS,
  crashLimit = CRASH_LIMIT,
): CrashLoopState {
  const isFastCrash = exit.reason === 'exit'
    && typeof exit.uptime_ms === 'number'
    && exit.uptime_ms <= fastExitMs
  if (!isFastCrash) {
    crashLoops.delete(key)
    return { count: 0, open: false }
  }
  const count = (crashLoops.get(key)?.count ?? 0) + 1
  const state = { count, open: count >= crashLimit }
  crashLoops.set(key, state)
  return state
}

export function isTerminalCrashLoopOpen(key: string): boolean {
  return crashLoops.get(key)?.open ?? false
}

export function resetTerminalCrashLoop(key: string): void {
  crashLoops.delete(key)
}

export function formatTerminalExit(exit: TerminalExitDetails): string {
  const lifetime = typeof exit.uptime_ms === 'number'
    ? ` ${exit.uptime_ms}ms after spawn`
    : ''
  const cause = exit.signal
    ? `was terminated by ${exit.signal}`
    : exit.exit_code === null
      ? `ended (${exit.reason})`
      : `exited with code ${exit.exit_code}`
  const binary = exit.startup_probe?.binary_path
  return `Process ${cause}${lifetime}${binary ? ` — ${binary}` : ''}`
}
