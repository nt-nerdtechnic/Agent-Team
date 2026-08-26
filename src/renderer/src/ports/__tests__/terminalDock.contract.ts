import { describe, expect, it } from 'vitest'
import type {
  TerminalCreateRequest,
  TerminalDockPort,
  TerminalExitEvent,
  TerminalOutputEvent,
} from '@navide/terminal'

export interface TerminalDockRequestRecord {
  type: string
  payload: Record<string, unknown>
  timeoutMs?: number
}

export interface TerminalDockContractHarness {
  port: TerminalDockPort
  sent: TerminalDockRequestRecord[]
  emitOutput(payload: TerminalOutputEvent): void
  emitExit(payload: TerminalExitEvent): void
}

function createRequest(): TerminalCreateRequest {
  return {
    paneId: 'pane-1',
    createGeneration: 'generation-1',
    agentKey: 'claude',
    command: ['claude', '--resume'],
    cwd: '/workspace',
    env: { LANG: 'en_US.UTF-8' },
    cols: 120,
    rows: 32,
    metadata: { origin: 'contract' },
    outputLogFile: '/tmp/output.log',
    loginProfileId: 'profile-1',
    replacesTerminalId: 'old-session',
  }
}

/** Run the route-free terminal port contract against each concrete adapter. */
export function runTerminalDockContract(createHarness: () => TerminalDockContractHarness): void {
  describe('TerminalDockPort contract', () => {
    it('preserves the named PTY lifecycle request inventory and payloads', async () => {
      const harness = createHarness()

      expect(harness.port.status.value).toBe('connected')
      expect(harness.port.shell.value).toBe('bash')

      await harness.port.input('session-1', 'hello', 11)
      await harness.port.create(createRequest(), 22)
      await harness.port.cancelCreate('pane-1', 'generation-1')
      await harness.port.reattach(['session-1'], 120, 32)
      await harness.port.resize('session-1', 121, 32)
      await harness.port.interrupt('session-1')
      await harness.port.kill('session-1', true)
      await harness.port.redraw('session-1', 121, 32)
      await harness.port.listFiles('/workspace', 'src', 20)
      await harness.port.listAgentPanes()
      await harness.port.statPath('/workspace/src/app.ts', 33)

      expect(harness.sent).toEqual([
        { type: 'terminal.input', payload: { terminal_session_id: 'session-1', data: 'hello' }, timeoutMs: 11 },
        {
          type: 'terminal.create',
          payload: {
            pane_id: 'pane-1',
            create_generation: 'generation-1',
            agent_key: 'claude',
            command: ['claude', '--resume'],
            cwd: '/workspace',
            env: { LANG: 'en_US.UTF-8' },
            cols: 120,
            rows: 32,
            metadata: { origin: 'contract' },
            output_log_file: '/tmp/output.log',
            login_profile_id: 'profile-1',
            replaces_terminal_id: 'old-session',
          },
          timeoutMs: 22,
        },
        { type: 'terminal.create.cancel', payload: { pane_id: 'pane-1', create_generation: 'generation-1' } },
        { type: 'terminal.reattach', payload: { terminal_session_ids: ['session-1'], cols: 120, rows: 32 } },
        { type: 'terminal.resize', payload: { terminal_session_id: 'session-1', cols: 121, rows: 32 } },
        { type: 'terminal.interrupt', payload: { terminal_session_id: 'session-1' } },
        { type: 'terminal.kill', payload: { terminal_session_id: 'session-1', force: true } },
        { type: 'terminal.redraw', payload: { terminal_session_id: 'session-1', cols: 121, rows: 32 } },
        { type: 'fs.list_files_flat', payload: { workspace_path: '/workspace', query: 'src', max_results: 20 } },
        { type: 'agent_msg.list', payload: {} },
        { type: 'fs.stat_path', payload: { path: '/workspace/src/app.ts' }, timeoutMs: 33 },
      ])
    })

    it('delivers output and exit events through named subscriptions with cleanup', () => {
      const harness = createHarness()
      const outputs: TerminalOutputEvent[] = []
      const exits: TerminalExitEvent[] = []
      const offOutput = harness.port.onOutput((payload) => outputs.push(payload))
      const offExit = harness.port.onExit((payload) => exits.push(payload))

      const output = { terminal_session_id: 'session-1', data: 'ok' }
      const exit = { terminal_session_id: 'session-1', reason: 'exited', exit_code: 0, signal: null }
      harness.emitOutput(output)
      harness.emitExit(exit)
      expect(outputs).toEqual([output])
      expect(exits).toEqual([exit])

      offOutput()
      offExit()
      harness.emitOutput({ terminal_session_id: 'session-1', data: 'ignored' })
      harness.emitExit({ terminal_session_id: 'session-1', reason: 'exited', exit_code: 1, signal: null })
      expect(outputs).toEqual([output])
      expect(exits).toEqual([exit])
    })
  })
}
