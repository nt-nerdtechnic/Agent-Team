import type { GitTransport } from '../../../../packages/features/git/src'
import type { useBackend } from './useBackend'
import type {
  ConflictStages,
  DiscoveredRepo,
  GitBranch,
  GitStatus,
} from './useGit'
import type { Issue, IssueDetail, IssueProviderInfo } from './useIssues'
import type {
  GitBranchDiffPort,
  GitAccountPort,
  GitCredentialPort,
  GitFileAccessPort,
  GitFileReadResult,
  GitFileWriteResult,
  GitSettingsPort,
  GitPaneUiPort,
  GitWindowUiPort,
  IssuePort,
} from '../ports/gitSurface'
import type { KeybindingsPort } from '../ports/keybindings'
import { useGitAccounts } from './useGitAccounts'
import type {
  TerminalCreateRequest,
  TerminalDockPort,
  TerminalExitEvent,
  TerminalFileListResult,
  TerminalOutputEvent,
} from '../ports/terminalDock'

type HostBackend = ReturnType<typeof useBackend>
type BackendResponse<T = unknown> = Awaited<ReturnType<HostBackend['send']>> & { payload?: T | null }

function errorMessage(response: { error?: { message?: string } | null }): string {
  return response.error?.message || 'Host capability failed'
}

async function requireOk<T>(promise: Promise<BackendResponse<T>>): Promise<T | null> {
  const response = await promise
  if (!response.ok) throw new Error(errorMessage(response))
  return (response.payload as T | null) ?? null
}

export function createHostGitFileAccessPort(backend: HostBackend): GitFileAccessPort {
  return {
    async readFile(workspacePath: string, relPath: string): Promise<GitFileReadResult> {
      const response = await backend.send<{ ok: boolean; content: string; error?: string }>('fs.read_file', {
        workspace_path: workspacePath,
        rel_path: relPath,
      })
      return {
        ok: response.ok && response.payload?.ok === true,
        content: response.payload?.content ?? '',
        error: response.payload?.error || response.error?.message,
      }
    },
    async writeFile(workspacePath: string, relPath: string, content: string): Promise<GitFileWriteResult> {
      const response = await backend.send<{ ok: boolean; error?: string }>('fs.write_file', {
        workspace_path: workspacePath,
        rel_path: relPath,
        content,
      })
      return {
        ok: response.ok && response.payload?.ok === true,
        error: response.payload?.error || response.error?.message,
      }
    },
    async readImage(workspacePath: string, relPath: string): Promise<string> {
      const response = await backend.send<{ ok: boolean; data_url?: string }>('fs.read_image', {
        workspace_path: workspacePath,
        rel_path: relPath,
      })
      return response.ok && response.payload?.ok ? (response.payload.data_url ?? '') : ''
    },
  }
}

export function createHostGitWindowUiPort(backend: HostBackend): GitWindowUiPort {
  return {
    async openInEditor({ workspacePath, filepath, line }): Promise<void> {
      await requireOk(backend.send('ui.open_in_editor', {
        workspace_path: workspacePath,
        filepath,
        ...(line === undefined ? {} : { line }),
      }))
    },
    async openExternal(url: string): Promise<void> {
      await requireOk(backend.send('ui.open_external', { url }))
    },
    async revealPath(path: string): Promise<void> {
      await requireOk(backend.send('ui.reveal_path', { path }))
    },
    async pickFolder(defaultPath?: string): Promise<string | null> {
      const payload = await requireOk<{ ok: boolean; path: string | null }>(backend.send('ui.pick_folder', {
        ...(defaultPath ? { default_path: defaultPath } : {}),
      }))
      return payload?.path ?? null
    },
    async openWorkspace(path: string): Promise<void> {
      await requireOk(backend.send('ui.open_workspace', { workspace_path: path }))
    },
  }
}

export function createHostGitPaneUiPort(backend: HostBackend): GitPaneUiPort {
  const windowUi = createHostGitWindowUiPort(backend)
  return {
    openInEditor: windowUi.openInEditor,
    openExternal: windowUi.openExternal,
    revealPath: windowUi.revealPath,
    async openPath(path: string): Promise<void> {
      await window.agentTeam?.openPath?.(path)
    },
    async openTempFile(name: string, content: string): Promise<void> {
      await window.agentTeam?.openTempFile?.(name, content)
    },
    async pickWorkspace(defaultPath?: string): Promise<string | null> {
      return (await window.agentTeam?.pickWorkspace?.(defaultPath)) ?? null
    },
    async openMainWindow(workspacePath: string): Promise<void> {
      await window.agentTeam?.openMainWindow?.({ workspace_path: workspacePath })
    },
    async openBranchDiffWindow(workspacePath: string, base: string): Promise<void> {
      await (window as Window & {
        agentTeam?: { openBranchDiffWindow?: (args: { workspace_path: string; base: string }) => Promise<void> }
      }).agentTeam?.openBranchDiffWindow?.({ workspace_path: workspacePath, base })
    },
    async openGitWindow(args): Promise<void> {
      await window.agentTeam?.openGitWindow?.({
        workspace_path: args.workspacePath,
        ...(args.filepath === undefined ? {} : { filepath: args.filepath }),
        ...(args.staged === undefined ? {} : { staged: args.staged }),
        ...(args.commit === undefined ? {} : { commit: args.commit }),
        ...(args.base === undefined ? {} : { base: args.base }),
        ...(args.compare === undefined ? {} : { compare: args.compare }),
      })
    },
    async openGitHistoryWindow(workspacePath: string): Promise<void> {
      await window.agentTeam?.openGitHistoryWindow?.({ workspace_path: workspacePath })
    },
  }
}

type HostAgentTeam = {
  gitDiffHead?: (args: { workspace_path: string; base?: string; compare?: string }) => Promise<{
    ok: boolean
    diff: string
    error?: string
  }>
  gitAccounts?: { getCredential?: (workspacePath: string) => Promise<{ ok?: boolean; credential?: { username: string; token: string } | null }> }
}

function hostAgentTeam(): HostAgentTeam | undefined {
  return (window as Window & { agentTeam?: HostAgentTeam }).agentTeam
}

export function createHostGitBranchDiffPort(backend: HostBackend): GitBranchDiffPort {
  return {
    async load(workspacePath: string, base: string, compare: string) {
      const direct = hostAgentTeam()?.gitDiffHead
      if (direct) return direct({
        workspace_path: workspacePath,
        base: base || undefined,
        compare: compare || undefined,
      })
      const response = await backend.send<{ ok: boolean; diff: string; error?: string }>('git.diff_branches', {
        workspace_path: workspacePath,
        base,
        compare: compare || '',
      })
      return {
        ok: response.ok && response.payload?.ok === true,
        diff: response.payload?.diff ?? '',
        error: response.payload?.error || response.error?.message,
      }
    },
  }
}

export function createHostGitCredentialPort(): GitCredentialPort {
  return {
    async getCredential(workspacePath: string): Promise<{ username: string; token: string } | null> {
      try {
        const result = await hostAgentTeam()?.gitAccounts?.getCredential?.(workspacePath)
        return result?.ok && result.credential ? result.credential : null
      } catch {
        return null
      }
    },
  }
}

export function createHostGitAccountPort(): GitAccountPort {
  return useGitAccounts()
}

export function createHostKeybindingsPort(): KeybindingsPort {
  const agentTeam = window.agentTeam
  const port: KeybindingsPort = {}
  if (agentTeam?.readKeybindings) port.read = () => agentTeam.readKeybindings()
  if (agentTeam?.writeKeybindings) port.write = (content) => agentTeam.writeKeybindings(content)
  if (agentTeam?.onKeybindingsChanged) {
    port.onChanged = (callback) => {
      agentTeam.onKeybindingsChanged!(callback)
      return () => {}
    }
  }
  return port
}

export function createHostIssuePort(backend: HostBackend): IssuePort {
  return {
    provider: (workspacePath) => backend.send<IssueProviderInfo>('issues.provider', { workspace_path: workspacePath }),
    list: (workspacePath, limit) => backend.send<{ ok: boolean; provider: string; issues: Issue[]; error?: string }>(
      'issues.list', { workspace_path: workspacePath, limit }, 30_000,
    ),
    get: (workspacePath, number) => backend.send<{ ok: boolean; issue: IssueDetail; error?: string }>(
      'issues.get', { workspace_path: workspacePath, number }, 30_000,
    ),
    create: (workspacePath, title, body) => backend.send<{ ok: boolean; url?: string; error?: string }>(
      'issues.create', { workspace_path: workspacePath, title, body }, 30_000,
    ),
    comment: (workspacePath, number, body) => backend.send<{ ok: boolean; error?: string }>(
      'issues.comment', { workspace_path: workspacePath, number, body }, 30_000,
    ),
    setState: (workspacePath, number, state) => backend.send<{ ok: boolean; error?: string }>(
      'issues.set_state', { workspace_path: workspacePath, number, state }, 30_000,
    ),
  }
}

export function createHostGitSettingsPort(backend: HostBackend): GitSettingsPort {
  return {
    status: backend.status,
    async getAll(): Promise<Record<string, unknown> | null> {
      const response = await backend.send<{ settings?: Record<string, unknown> }>('ui.settings.get', {})
      if (!response.ok) throw new Error(errorMessage(response))
      return response.payload?.settings ?? null
    },
    async setMany(updates: Record<string, unknown>): Promise<void> {
      const response = await backend.send('ui.settings.set', { updates })
      if (!response.ok) throw new Error(errorMessage(response))
    },
    onChanged(callback) {
      return backend.on('ui.settings_changed' as never, callback)
    },
  }
}

export function createHostTerminalDockPort(backend: HostBackend): TerminalDockPort {
  const send = <T = unknown>(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number) =>
    timeoutMs === undefined ? backend.send<T>(type, payload) : backend.send<T>(type, payload, timeoutMs)
  return {
    status: backend.status,
    shell: backend.shell,
    autoRestart: backend.autoRestart,
    input: (sessionId, data, timeoutMs) => send('terminal.input', { terminal_session_id: sessionId, data }, timeoutMs),
    create: (request: TerminalCreateRequest, timeoutMs) => send('terminal.create', {
      pane_id: request.paneId,
      create_generation: request.createGeneration,
      agent_key: request.agentKey,
      command: request.command,
      cwd: request.cwd,
      env: request.env,
      cols: request.cols,
      rows: request.rows,
      metadata: request.metadata,
      output_log_file: request.outputLogFile,
      login_profile_id: request.loginProfileId,
      replaces_terminal_id: request.replacesTerminalId,
    }, timeoutMs),
    cancelCreate: (paneId, createGeneration) => send('terminal.create.cancel', {
      pane_id: paneId,
      create_generation: createGeneration,
    }),
    reattach: (sessionIds, cols, rows) => send('terminal.reattach', {
      terminal_session_ids: sessionIds,
      cols,
      rows,
    }),
    resize: (sessionId, cols, rows) => send('terminal.resize', {
      terminal_session_id: sessionId,
      cols,
      rows,
    }),
    interrupt: (sessionId) => send('terminal.interrupt', { terminal_session_id: sessionId }),
    kill: (sessionId, force) => send('terminal.kill', { terminal_session_id: sessionId, force }),
    redraw: (sessionId, cols, rows) => send('terminal.redraw', {
      terminal_session_id: sessionId,
      cols,
      rows,
    }),
    onOutput: (callback: (payload: TerminalOutputEvent) => void) =>
      backend.on('terminal.output' as never, (payload) => callback(payload as TerminalOutputEvent)),
    onExit: (callback: (payload: TerminalExitEvent) => void) =>
      backend.on('terminal.exit' as never, (payload) => callback(payload as TerminalExitEvent)),
    listFiles: (workspacePath, query, maxResults) => send<TerminalFileListResult>('fs.list_files_flat', {
      workspace_path: workspacePath,
      query,
      max_results: maxResults,
    }),
    listAgentPanes: () => send('agent_msg.list', {}),
    statPath: (path, timeoutMs) => send('fs.stat_path', { path }, timeoutMs),
    async getHomeDirectory(): Promise<string> {
      return (await window.agentTeam?.getHomeDir?.()) || ''
    },
    async openFile({ workspacePath, filepath, fileWorkspace, line }): Promise<void> {
      await window.agentTeam?.openEditorWindow?.({
        workspace_path: workspacePath,
        filepath,
        ...(fileWorkspace ? { file_ws: fileWorkspace } : {}),
        ...(line === undefined ? {} : { line }),
      })
    },
    async openExternal(url: string): Promise<void> {
      await window.agentTeam?.openExternal?.(url)
    },
    async openPlan(args): Promise<void> {
      await window.agentTeam?.openPlansWindow?.({ workspace_path: args.workspacePath, rel_path: args.relPath })
    },
    reportSelection: (selection) => { window.agentTeam?.reportTerminalSelection?.(selection) },
    saveClipboardImage: async (image) => {
      const save = window.agentTeam?.saveClipboardImage
      if (!save) return null
      try {
        const bytes = new Uint8Array(await image.arrayBuffer())
        const result = await save({ bytes, mediaType: image.type })
        return result?.ok && result.path ? result.path : null
      } catch {
        return null
      }
    },
    showContextMenu: (selection) => { window.agentTeam?.showTerminalContextMenu?.(selection) },
    reportDragEnd: (paneId, screenX, screenY, paneIds) => {
      window.agentTeam?.cliPaneDragEnd?.(paneId, screenX, screenY, paneIds)
    },
    diagnostic: (category, message, level) => {
      try { void send('client.diagnostic', { category, message, level }).catch(() => {}) } catch { /* ignore */ }
    },
  }
}

export function createHostGitSurfacePorts(backend: HostBackend, gitTransport: GitTransport) {
  return {
    gitTransport,
    fileAccess: createHostGitFileAccessPort(backend),
    ui: createHostGitWindowUiPort(backend),
    paneUi: createHostGitPaneUiPort(backend),
    branchDiff: createHostGitBranchDiffPort(backend),
    credentials: createHostGitCredentialPort(),
    accounts: createHostGitAccountPort(),
    issues: createHostIssuePort(backend),
  }
}
