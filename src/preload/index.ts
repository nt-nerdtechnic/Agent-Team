import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  UpdateActionResult,
  UpdateSettingsResult,
  UpdaterSettings,
  UpdateState,
} from '../shared/updater'

/** Which Electron-owned cache groups to clear. Never touches user state. */
export interface ClearElectronCachesOptions {
  chromium: boolean
  updater: boolean
}

export interface ClearElectronCachesResult {
  ok: boolean
  freedBytes: number
  error: string | null
}

export interface BackendInfo {
  status: 'starting' | 'ready' | 'error'
  host?: string
  port?: number
  pid?: number
  shell?: string
  httpUrl?: string
  wsUrl?: string
  error?: string
}

export interface GitAccountPublic {
  id: string
  label: string
  host: string
  username: string
  tokenLast4: string
}

export interface GitAccountInput {
  label: string
  host: string
  username: string
  token: string
}

export interface GitCredential {
  username: string
  token: string
}

export type PermissionKey = 'automation' | 'notifications' | 'folders' | 'fullDisk'
export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-applicable'

export interface InstalledPluginSummary {
  id: string
  requires: string[]
  sensitive: string[]
  provenance?: 'official-registry' | 'developer-local-unpacked'
  warning?: string
}

export interface MarketplaceExtension {
  namespace: string
  name: string
  identity: string
  display_name: string | null
  description: string | null
  categories: string[]
  latest_version: string | null
  download_count: number
  rating_average: number
  featured: boolean
}

export interface MarketplaceListResponse {
  items: MarketplaceExtension[]
  total: number
  offset: number
  limit: number
}

export interface PreparedInstallSummary {
  id: string
  version: string
  trustTier: 'signed-verified' | 'unsigned'
  sensitive: string[]
  containsBackendExecutable: boolean
  requiresConfirmation: boolean
  publisherId: string
  requiresPublisherTrust: boolean
  requiresRiskConfirmation: boolean
}

const pendingEditorOpenFiles: Record<string, string>[] = []
let editorOpenFileCallback: ((params: Record<string, string>) => void) | null = null
ipcRenderer.on('editor:openFile', (_event, params: Record<string, string>) => {
  if (editorOpenFileCallback) editorOpenFileCallback(params)
  else pendingEditorOpenFiles.push(params)
})

contextBridge.exposeInMainWorld('agentTeam', {
  appName: 'Agent-Team',
  version: __APP_VERSION__,
  getBackendInfo: (): Promise<BackendInfo> => ipcRenderer.invoke('backend:info'),
  restartBackend: (): Promise<BackendInfo> => ipcRenderer.invoke('backend:restart'),
  stopBackend: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('backend:stop'),
  onBackendChanged: (cb: (info: BackendInfo) => void): void => {
    ipcRenderer.on('backend:changed', (_event, info: BackendInfo) => cb(info))
  },
  onMenuAction: (cb: (action: string) => void): void => {
    ipcRenderer.on('menu:action', (_event, action: string) => cb(action))
  },
  setRecentWorkspaces: (list: { path: string; name: string; exists: boolean }[]): void =>
    ipcRenderer.send('menu:setRecents', list),
  pickWorkspace: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('workspace:pick', defaultPath),
  newWorkspace: (): Promise<string | null> => ipcRenderer.invoke('workspace:new'),
  getHomeDir: (): Promise<string> => ipcRenderer.invoke('app:home-dir'),
  listOpenWorkspaces: (): Promise<string[]> => ipcRenderer.invoke('workspace:listOpen'),
  focusWorkspaceWindow: (workspacePath: string): Promise<boolean> =>
    ipcRenderer.invoke('workspace:focusExisting', workspacePath),
  // Returns a disposer — Welcome mounts/unmounts with the workspace gate.
  onOpenWorkspacesChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('workspace:openChanged', listener)
    return () => ipcRenderer.removeListener('workspace:openChanged', listener)
  },
  openPath: (target: string): Promise<{ ok: boolean; revealed?: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openPath', target),
  revealPath: (target: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:revealPath', target),
  openTerminal: (command: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openTerminal', command),
  openTempFile: (filename: string, content: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('shell:openTempFile', filename, content),
  openMainWindow: (args?: { workspace_path?: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openMain', args ?? {}),
  detachGroup: (args: { groupId: string; workspacePath: string; bounds?: { x: number; y: number; width: number; height: number } }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:detachGroup', args),
  getDetachedGroups: (): Promise<string[]> => ipcRenderer.invoke('window:getDetachedGroups'),
  onGroupDetached: (cb: (groupId: string) => void): void => {
    ipcRenderer.on('group:detached', (_event, arg: { groupId: string }) => cb(arg.groupId))
  },
  onGroupReattached: (cb: (groupId: string) => void): void => {
    ipcRenderer.on('group:reattached', (_event, arg: { groupId: string }) => cb(arg.groupId))
  },
  onOpenPipelineManager: (handler: (payload: { pipelineId?: string }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { pipelineId?: string }): void => handler(payload ?? {})
    ipcRenderer.on('menu:open-pipeline-manager', listener)
    return () => ipcRenderer.removeListener('menu:open-pipeline-manager', listener)
  },
  openPlansWindow: (args: { workspace_path: string; rel_path?: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openPlans', {
      workspace_path: args.workspace_path,
      ...(args.rel_path ? { rel_path: args.rel_path } : {}),
    }),
  openGitHistoryWindow: (args: { workspace_path: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openGitHistory', { workspace_path: args.workspace_path }),
  openGitWindow: (args: {
    workspace_path: string
    filepath?: string
    staged?: boolean
    commit?: string
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openGit', {
      workspace_path: args.workspace_path,
      ...(args.filepath
        ? { filepath: args.filepath, staged: String(args.staged ?? false), commit: args.commit ?? '' }
        : {}),
    }),
  // Plan-window side receiver: main asks an already-open plan window to switch
  // to a newly clicked plan instead of reopening the window. Returns a disposer.
  onPlanOpenDoc: (handler: (relPath: string) => void): (() => void) => {
    const listener = (_event: unknown, relPath: string): void => handler(relPath)
    ipcRenderer.on('plan:open-doc', listener)
    return () => ipcRenderer.removeListener('plan:open-doc', listener)
  },
  openDiffWindow: (args: {
    workspace_path: string
    filepath: string
    staged: boolean
    name?: string
    commit?: string
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openDiff', {
      workspace_path: args.workspace_path,
      filepath: args.filepath,
      staged: String(args.staged),
      name: args.name ?? args.filepath,
      commit: args.commit ?? '',
    }),
  openEditorWindow: (args: {
    workspace_path: string
    filepath?: string
    // Root the file itself belongs to (normally its parent directory) when it
    // lives outside `workspace_path`. Omitted/empty means the file is opened
    // against the workspace, as before.
    file_ws?: string
    name?: string
    line?: number
    sidebar?: 'explorer' | 'search' | 'git'
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openEditor', {
      workspace_path: args.workspace_path,
      ...(args.filepath ? { filepath: args.filepath, name: args.name ?? args.filepath } : {}),
      ...(args.file_ws ? { file_ws: args.file_ws } : {}),
      ...(args.line ? { line: String(args.line) } : {}),
      ...(args.sidebar ? { sidebar: args.sidebar } : {}),
    }),
  // Default-editor routing: the editors Navide can drive on this machine, and
  // opening a folder in one of them ("Open with…"; omit editorId for the
  // user's default).
  listEditors: (refresh = false): Promise<{ id: string; command: string; available: boolean }[]> =>
    ipcRenderer.invoke('editors:list', { refresh }),
  openFolderInEditor: (dir: string, editorId?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('editor:openFolder', { dir, ...(editorId ? { editorId } : {}) }),
  onSwitchEditorSidebar: (cb: (sidebar: string) => void): void => {
    ipcRenderer.on('editor:switchSidebar', (_event, sidebar: string) => cb(sidebar))
  },
  onOpenEditorFile: (cb: (params: Record<string, string>) => void): void => {
    editorOpenFileCallback = cb
    for (const params of pendingEditorOpenFiles.splice(0)) cb(params)
  },
  onOpenEditorDiff: (cb: (params: Record<string, string>) => void): void => {
    ipcRenderer.on('editor:openDiff', (_event, params: Record<string, string>) => cb(params))
  },
  openBranchDiffWindow: (args: {
    workspace_path: string
    base: string
    compare?: string
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openBranchDiff', {
      workspace_path: args.workspace_path,
      branch_diff_base: args.base,
      branch_diff_compare: args.compare ?? '',
    }),
  onOpenEditorBranchDiff: (cb: (params: Record<string, string>) => void): void => {
    ipcRenderer.on('editor:openBranchDiff', (_event, params: Record<string, string>) => cb(params))
  },
  gitDiffHead: (args: {
    workspace_path: string
    base?: string
    compare?: string
  }): Promise<{ ok: boolean; diff: string; error?: string }> =>
    ipcRenderer.invoke('git:diff-head', args),
  saveJson: (args: {
    defaultName?: string
    content: string
    title?: string
  }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('dialog:saveJson', args),
  openJson: (args?: {
    title?: string
  }): Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('dialog:openJson', args),
  readFileFrom: (filePath: string, fromByte: number): Promise<{ ok: boolean; content: string; newOffset: number; error?: string }> =>
    ipcRenderer.invoke('fs:readFrom', filePath, fromByte),
  realpath: (target: string): Promise<string> =>
    ipcRenderer.invoke('fs:realpath', target),
  findManualLog: (workspacePath: string, filename: string): Promise<{ ok: boolean; path: string | null; error?: string }> =>
    ipcRenderer.invoke('logs:findManualLog', workspacePath, filename),
  searchHistoryLogs: (args: { query: string; files: Array<{ id: string; path: string }> }): Promise<{ matchedIds: string[] }> =>
    ipcRenderer.invoke('logs:searchContent', args),
  pickFile: (args?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
    defaultPath?: string
  }): Promise<{ ok: boolean; path?: string; canceled?: boolean }> =>
    ipcRenderer.invoke('dialog:pickFile', args),
  pickFiles: (args?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
    defaultPath?: string
  }): Promise<{ ok: boolean; paths?: string[]; canceled?: boolean }> =>
    ipcRenderer.invoke('dialog:pickFiles', args),
  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openExternal', url),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  stabilizeDroppedPaths: (paths: string[]): Promise<{ ok: boolean; paths: string[] }> =>
    ipcRenderer.invoke('drop:stabilize', paths),
  saveClipboardImage: (args: {
    bytes: Uint8Array
    mediaType: string
  }): Promise<{ ok: boolean; path?: string }> => ipcRenderer.invoke('clipboard:saveImage', args),
  readKeybindings: (): Promise<{ ok: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('keybindings:read'),
  writeKeybindings: (content: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('keybindings:write', content),
  onKeybindingsChanged: (cb: (content: string) => void): void => {
    ipcRenderer.on('keybindings:changed', (_event, content: string) => cb(content))
  },
  // Synchronous on purpose: seeds the renderer settings cache before first
  // paint (zero-flash theme/language). Returns the ui_settings.json text,
  // '{}' when missing/corrupt.
  getBootstrapSettings: (): string => ipcRenderer.sendSync('settings:bootstrap') as string,
  broadcastLanguageChange: (locale: string): void => {
    ipcRenderer.send('settings:language-changed', locale)
  },
  onLanguageChanged: (cb: (locale: string) => void): void => {
    ipcRenderer.on('settings:language-changed', (_event, locale: string) => cb(locale))
  },
  setQuitConfirm: (cfg: {
    enabled: boolean
    message: string
    detail: string
    quitLabel: string
    cancelLabel: string
    dontShowLabel: string
  }): void => ipcRenderer.send('app:setQuitConfirm', cfg),
  onQuitConfirmDisabled: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('app:quitConfirmDisabled', listener)
    return () => ipcRenderer.removeListener('app:quitConfirmDisabled', listener)
  },
  // Real window visibility, reported by main. The Page Visibility API cannot be
  // used for this: terminal panes need backgroundThrottling disabled, which also
  // pins document.hidden to false for the whole renderer.
  onWindowVisibility: (cb: (visible: boolean) => void): (() => void) => {
    const listener = (_event: unknown, visible: boolean): void => cb(visible)
    ipcRenderer.on('window:visibility', listener)
    return () => ipcRenderer.removeListener('window:visibility', listener)
  },
  readHealthCheckTimeout: (): Promise<{ ok: boolean; timeoutSec?: number }> =>
    ipcRenderer.invoke('settings:health-timeout-read'),
  writeHealthCheckTimeout: (timeoutSec: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:health-timeout-write', timeoutSec),
  readCdpDebugConfig: (): Promise<{ ok: boolean; config?: { enabled: boolean; port: number } }> =>
    ipcRenderer.invoke('settings:cdp-debug-read'),
  writeCdpDebugConfig: (config: { enabled: boolean; port: number }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:cdp-debug-write', config),
  notify: (args: { paneId?: string; title: string; body?: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:notify', args),
  // Plan execute dispatch: the plan window hands an approved plan to a CLI
  // agent. Main focuses the workspace's main window and forwards the payload;
  // that window creates/reuses the agent pane and injects the execution
  // prompt. delivered:false when no main window is open for the workspace.
  dispatchPlanExecution: (args: {
    workspace_path: string
    rel_path: string
    agent_key: string
  }): Promise<{ delivered: boolean }> =>
    ipcRenderer.invoke('plans:dispatch-execution', args),
  // Main-window side receiver. Returns a disposer.
  onPlanExecutionDispatch: (
    handler: (args: { workspace_path: string; rel_path: string; agent_key: string }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      args: { workspace_path: string; rel_path: string; agent_key: string }
    ): void => handler(args)
    ipcRenderer.on('plans:execute-dispatch', listener)
    return () => ipcRenderer.removeListener('plans:execute-dispatch', listener)
  },
  // Main-window side: report the dispatch outcome so the plan window can
  // confirm (toast) or roll back the in-progress execution record.
  reportPlanExecutionResult: (args: {
    workspace_path: string
    rel_path: string
    ok: boolean
    reason?: string
  }): void => {
    ipcRenderer.send('plans:execution-result', args)
  },
  // Plan-window side receiver for the dispatch outcome. Returns a disposer.
  onPlanExecutionResult: (
    handler: (args: { workspace_path: string; rel_path: string; ok: boolean; reason?: string }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      args: { workspace_path: string; rel_path: string; ok: boolean; reason?: string }
    ): void => handler(args)
    ipcRenderer.on('plans:execution-result', listener)
    return () => ipcRenderer.removeListener('plans:execution-result', listener)
  },
  onFocusPane: (cb: (paneId: string) => void): void => {
    ipcRenderer.on('notify:focusPane', (_event, paneId: string) => cb(paneId))
  },
  // Cross-window CLI-context bridge: the editor window's AI Chat invokes
  // getCliPaneBuffer; the main process relays it to the main window(s), where
  // onCliPaneBufferRequest answers from the pane's live metadata and rendered scrollback.
  getCliPaneBuffer: (
    paneId: string
  ): Promise<{
    label?: string
    agentKey?: string
    sessionId?: string | null
    sessionHomeId?: string
    workspacePath?: string
    conversationLogPath?: string
    buffer?: string
    error?: string
  }> =>
    ipcRenderer.invoke('cli:get-pane-buffer', paneId),
  onCliPaneBufferRequest: (
    handler: (
      paneId: string
    ) => {
      label: string
      agentKey: string
      sessionId: string | null
      sessionHomeId: string
      workspacePath: string
      conversationLogPath: string
      buffer: string
    } | { error: string }
  ): void => {
    ipcRenderer.on('cli:get-pane-buffer:request', (_event, requestId: string, paneId: string) => {
      ipcRenderer.send('cli:get-pane-buffer:reply', requestId, handler(paneId))
    })
  },
  // Cross-window pane drop handoff: HTML5 DnD events never reach another
  // BrowserWindow, so the drag source reports the release point (screen coords
  // from dragend) and main forwards it to the window under that point.
  // `paneIds` carries every pane of a multi-select drag (the dragged pane alone
  // when there is no selection), so the receiving window can share all of them.
  cliPaneDragEnd: (
    paneId: string,
    screenX: number,
    screenY: number,
    paneIds?: string[]
  ): void => {
    ipcRenderer.send('cli:pane-drag-end', { paneId, screenX, screenY, paneIds })
  },
  // Returns a disposer — the AI Chat mounts/unmounts with the panel toggle.
  onExternalPaneDrop: (
    handler: (args: { paneId: string; paneIds?: string[]; screenX: number; screenY: number }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      args: { paneId: string; paneIds?: string[]; screenX: number; screenY: number }
    ): void => handler(args)
    ipcRenderer.on('cli:external-pane-drop', listener)
    return () => ipcRenderer.removeListener('cli:external-pane-drop', listener)
  },
  // Terminal right-click. xterm keeps its selection out of the DOM, so main
  // cannot read it from the context-menu params and the pane hands it over.
  showTerminalContextMenu: (selection: string): void => {
    ipcRenderer.send('terminal:context-menu', selection)
  },
  // Terminal selection, pushed as it changes. Edit > Copy then reads it from
  // main synchronously instead of racing this renderer for an answer — see
  // terminal-selection-cache.ts.
  reportTerminalSelection: (selection: string): void => {
    ipcRenderer.send('terminal:selection-changed', selection)
  },
  setBadgeCount: (count: number): void => {
    ipcRenderer.send('window:setBadgeCount', count)
  },
  reportWorkspace: (workspacePath: string): void => {
    ipcRenderer.send('window:reportWorkspace', workspacePath)
  },
  restore: {
    getPending: (): Promise<string[] | null> => ipcRenderer.invoke('restore:getPending'),
    apply: (): Promise<{ ok: boolean; opened: number }> => ipcRenderer.invoke('restore:apply'),
    dismiss: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('restore:dismiss'),
    getAutoRestore: (): Promise<boolean> => ipcRenderer.invoke('restore:getAutoRestore'),
    setAutoRestore: (value: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('restore:setAutoRestore', value),
  },
  storage: {
    clearElectronCaches: (opts: ClearElectronCachesOptions): Promise<ClearElectronCachesResult> =>
      ipcRenderer.invoke('storage:clear-electron-caches', opts),
  },
  updater: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke('updater:get-state'),
    check: (): Promise<UpdateActionResult> => ipcRenderer.invoke('updater:check'),
    download: (): Promise<UpdateActionResult> => ipcRenderer.invoke('updater:download'),
    install: (): Promise<UpdateActionResult> => ipcRenderer.invoke('updater:install'),
    getSettings: (): Promise<UpdaterSettings> => ipcRenderer.invoke('updater:get-settings'),
    setSettings: (patch: Partial<UpdaterSettings>): Promise<UpdateSettingsResult> =>
      ipcRenderer.invoke('updater:set-settings', patch),
    onStateChanged: (cb: (state: UpdateState) => void): (() => void) => {
      const listener = (_event: unknown, state: UpdateState): void => cb(state)
      ipcRenderer.on('updater:state-changed', listener)
      return () => ipcRenderer.removeListener('updater:state-changed', listener)
    },
  },
  gitAccounts: {
    isAvailable: (): Promise<{ ok: boolean; available?: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:available'),
    list: (): Promise<{ ok: boolean; accounts?: GitAccountPublic[]; error?: string }> =>
      ipcRenderer.invoke('git-accounts:list'),
    add: (input: GitAccountInput): Promise<{ ok: boolean; account?: GitAccountPublic; error?: string }> =>
      ipcRenderer.invoke('git-accounts:add', input),
    update: (id: string, patch: Partial<GitAccountInput>): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:update', id, patch),
    remove: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:remove', id),
    bind: (workspacePath: string, accountId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:bind', workspacePath, accountId),
    unbind: (workspacePath: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:unbind', workspacePath),
    getBinding: (workspacePath: string): Promise<{ ok: boolean; accountId?: string | null; error?: string }> =>
      ipcRenderer.invoke('git-accounts:getBinding', workspacePath),
    getCredential: (
      workspacePath: string
    ): Promise<{ ok: boolean; credential?: GitCredential | null; error?: string }> =>
      ipcRenderer.invoke('git-accounts:getCredential', workspacePath),
  },
  permissions: {
    status: (): Promise<Record<PermissionKey, PermissionStatus>> =>
      ipcRenderer.invoke('permissions:status'),
    request: (
      key: PermissionKey,
      payload?: { title?: string; body?: string }
    ): Promise<PermissionStatus> => ipcRenderer.invoke('permissions:request', key, payload),
    openSettings: (key: PermissionKey): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('permissions:open-settings', key),
  },
  plugins: {
    listInstalled: (): Promise<InstalledPluginSummary[]> =>
      ipcRenderer.invoke('plugins:listInstalled'),
    marketplaceSearch: (query?: string): Promise<MarketplaceListResponse> =>
      ipcRenderer.invoke('plugins:marketplaceSearch', query),
    prepareInstall: (args: {
      namespace: string
      name: string
      version?: string
    }): Promise<PreparedInstallSummary> => ipcRenderer.invoke('plugins:prepareInstall', args),
    commitInstall: (
      id: string,
      approval: { publisherConfirmed?: boolean; riskConfirmed?: boolean } = {}
    ): Promise<{ id: string; requires: string[] }> =>
      ipcRenderer.invoke('plugins:commitInstall', { id, ...approval }),
    remove: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('plugins:remove', { id }),
  },
})
