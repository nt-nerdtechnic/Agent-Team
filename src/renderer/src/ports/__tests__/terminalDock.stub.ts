import type {
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalDockPort,
  TerminalExitEvent,
  TerminalFileListResult,
  TerminalOutputEvent,
} from '@navide/terminal'
import type { PortResponse } from '@navide/shared'

function ok<T>(payload: T | null = null): PortResponse<T> {
  return { ok: true, payload, error: null }
}

/** A complete no-op port for component tests that do not exercise terminal I/O. */
export function createTerminalDockStub(): TerminalDockPort {
  return {
    status: { value: 'connected' },
    shell: { value: 'bash' },
    autoRestart: { value: null },
    input: async () => ok(),
    create: async (_request: TerminalCreateRequest, _timeoutMs: number) =>
      ok<TerminalCreateResult>({ terminal_session_id: 'test-terminal', pid: 0 }),
    cancelCreate: async () => ok(),
    reattach: async () => ok({ alive: [], dead: [] }),
    resize: async () => ok(),
    interrupt: async () => ok(),
    kill: async () => ok(),
    redraw: async () => ok(),
    onOutput: (_callback: (payload: TerminalOutputEvent) => void) => () => {},
    onExit: (_callback: (payload: TerminalExitEvent) => void) => () => {},
    listFiles: async () => ok<TerminalFileListResult>({ files: [] }),
    listAgentPanes: async () => ok({ panes: [] }),
    statPath: async () => ok({ exists: false }),
    openFile: async () => {},
    openExternal: async () => {},
  }
}
