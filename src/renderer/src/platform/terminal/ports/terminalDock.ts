import type { TerminalExitDetails, TerminalStartupProbe } from '../lib/terminalLifecycle'
import type { PortResponse, ReactiveValue } from '@navide/plugin-ui/shared'
import type { InjectionKey } from 'vue'

export interface TerminalSpawnOptions {
  command: string | string[]
  cwd: string
  env?: Record<string, string>
  agentKey?: string
  metadata?: Record<string, unknown>
  outputLogFile?: string
  resumeKey?: string
  isResume?: boolean
  restoreMode?: 'memory-resume' | 'fresh'
  skipReattach?: boolean
  loginProfileId?: string
}

export interface TerminalCreateRequest {
  paneId: string
  createGeneration: string
  agentKey: string | null
  command: string | string[]
  cwd: string
  env: Record<string, string> | null
  cols: number
  rows: number
  metadata: Record<string, unknown> | null
  outputLogFile: string | null
  loginProfileId: string | null
  replacesTerminalId: string | null
}

export interface TerminalCreateResult {
  terminal_session_id: string
  pid: number
  startup_probe?: TerminalStartupProbe | null
}

export interface TerminalOutputEvent {
  terminal_session_id: string
  data: string
}

export type TerminalExitEvent = TerminalExitDetails & { terminal_session_id: string }

export interface TerminalFileListResult {
  files?: string[]
}

export interface TerminalDockPort {
  readonly status: ReactiveValue<'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'>
  readonly shell: ReactiveValue<string>
  readonly autoRestart: ReactiveValue<{ attempt: number; max: number; reason: string } | null>

  input(sessionId: string, data: string, timeoutMs?: number): Promise<PortResponse>
  create(request: TerminalCreateRequest, timeoutMs: number): Promise<PortResponse<TerminalCreateResult>>
  cancelCreate(paneId: string, createGeneration: string): Promise<PortResponse>
  reattach(sessionIds: string[], cols: number, rows: number): Promise<PortResponse<{ alive: string[]; dead: string[] }>>
  resize(sessionId: string, cols: number, rows: number): Promise<PortResponse>
  interrupt(sessionId: string): Promise<PortResponse>
  kill(sessionId: string, force: boolean): Promise<PortResponse>
  redraw(sessionId: string, cols: number, rows: number): Promise<PortResponse>

  onOutput(callback: (payload: TerminalOutputEvent) => void): () => void
  onExit(callback: (payload: TerminalExitEvent) => void): () => void

  listFiles(workspacePath: string, query: string, maxResults: number): Promise<PortResponse<TerminalFileListResult>>
  listAgentPanes(): Promise<PortResponse<{ panes?: Array<{ pane_id?: string; qualified_name?: string }> }>>
  statPath(path: string, timeoutMs?: number): Promise<PortResponse<{ exists: boolean }>>
  getHomeDirectory?(): Promise<string>
  openFile(args: {
    workspacePath: string
    filepath: string
    fileWorkspace?: string
    line?: number
  }): Promise<void>
  openExternal(url: string): Promise<void>
  openPlan?(args: { workspacePath: string; relPath?: string }): Promise<void>
  reportSelection?(selection: string): void
  saveClipboardImage?(image: File): Promise<string | null>
  showContextMenu?(selection: string): void
  reportDragEnd?(paneId: string, screenX: number, screenY: number, paneIds: string[]): void
  diagnostic?(category: string, message: string, level: 'info' | 'warning'): void
}

export const TERMINAL_DOCK_KEY: InjectionKey<TerminalDockPort> = Symbol('terminal-dock')

export type TerminalStatusSource = ReactiveValue<TerminalDockPort['status']['value']>
