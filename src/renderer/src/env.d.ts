/// <reference types="vite/client" />

import type { UpdateActionResult, UpdateSettingsResult, UpdaterSettings, UpdateState } from '../../shared/updater'

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface BackendInfo {
  status: 'starting' | 'ready' | 'error'
  host?: string
  port?: number
  pid?: number
  shell?: string
  httpUrl?: string
  wsUrl?: string
  error?: string
}

interface GitAccountPublic {
  id: string
  label: string
  host: string
  username: string
  tokenLast4: string
}

interface GitAccountInput {
  label: string
  host: string
  username: string
  token: string
}

interface GitCredential {
  username: string
  token: string
}

declare global {
  // Build tag injected by electron.vite.config.ts (git short-hash + dirty + time).
  const __APP_BUILD__: string
  // Prefixed: the DOM lib already owns the `PermissionStatus` global.
  type TccPermissionKey = 'automation' | 'notifications' | 'folders' | 'fullDisk'
  type TccPermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-applicable'
  interface Window {
    /** Set by useTerminal; read by the Edit > Copy menu item (see menu.ts). */
    __navideTerminalSelection?: () => string
    agentTeam?: {
      appName: string
      version: string
      getBackendInfo: () => Promise<BackendInfo>
      restartBackend: () => Promise<BackendInfo>
      stopBackend: () => Promise<{ ok: boolean }>
      onBackendChanged: (cb: (info: BackendInfo) => void) => void
      onMenuAction: (cb: (action: string) => void) => void
      onSystemResumed: (cb: () => void) => () => void
      setRecentWorkspaces: (list: { path: string; name: string; exists: boolean }[]) => void
      openMainWindow: (args?: { workspace_path?: string }) => Promise<{ ok: boolean }>
      pickWorkspace: (defaultPath?: string) => Promise<string | null>
      newWorkspace: () => Promise<string | null>
      getHomeDir: () => Promise<string>
      listOpenWorkspaces: () => Promise<string[]>
      focusWorkspaceWindow: (workspacePath: string) => Promise<boolean>
      requestSpawnInWorkspace: (workspacePath: string) => Promise<boolean>
      onSpawnRequested: (cb: () => void) => () => void
      onOpenWorkspacesChanged: (cb: () => void) => () => void
      openPath: (target: string) => Promise<{ ok: boolean; revealed?: boolean; error?: string }>
      revealPath: (target: string) => Promise<{ ok: boolean; error?: string }>
      /** Optional: absent on main processes built before the Storage tab.
       *  `freedBytes` is real even when `ok` is false (e.g. the updater cache
       *  was skipped because an update is downloading). */
      storage?: {
        clearElectronCaches: (opts: {
          chromium: boolean
          updater: boolean
        }) => Promise<{ ok: boolean; freedBytes: number; error: string | null }>
      }
      openTerminal: (command: string) => Promise<{ ok: boolean; error?: string }>
      openTempFile: (filename: string, content: string) => Promise<{ ok: boolean; path?: string; error?: string }>
      detachGroup: (args: { groupId: string; workspacePath: string; bounds?: { x: number; y: number; width: number; height: number } }) => Promise<{ ok: boolean }>
      getDetachedGroups: () => Promise<string[]>
      reattachGroup: (args?: { groupId?: string }) => Promise<{ ok: boolean }>
      onGroupDetached: (cb: (groupId: string) => void) => void
      onGroupReattached: (cb: (groupId: string) => void) => void
      onOpenPipelineManager: (handler: (payload: { pipelineId?: string }) => void) => () => void
      openPlansWindow: (args: { workspace_path: string; rel_path?: string }) => Promise<{ ok: boolean }>
      openGitHistoryWindow: (args: { workspace_path: string }) => Promise<{ ok: boolean }>
      openGitWindow: (args: {
        workspace_path: string
        filepath?: string
        staged?: boolean
        commit?: string
      }) => Promise<{ ok: boolean }>
      onPlanOpenDoc: (handler: (relPath: string) => void) => () => void
      openDiffWindow: (args: {
        workspace_path: string
        filepath: string
        staged: boolean
        name?: string
        commit?: string
      }) => Promise<{ ok: boolean }>
      openEditorWindow: (args: {
        workspace_path: string
        filepath?: string
        /** Root the file itself belongs to when it lives outside `workspace_path`. */
        file_ws?: string
        name?: string
        line?: number
        sidebar?: 'explorer' | 'search' | 'git'
      }) => Promise<{ ok: boolean }>
      /** Editors Navide can drive here; `available` is false when not found. */
      listEditors: (
        refresh?: boolean
      ) => Promise<{ id: string; command: string; available: boolean }[]>
      /** Open a folder in `editorId`, or the user's default editor when omitted. */
      openFolderInEditor: (dir: string, editorId?: string) => Promise<{ ok: boolean }>
      onOpenEditorFile: (cb: (params: Record<string, string>) => void) => void
      saveJson: (args: {
        defaultName?: string
        content: string
        title?: string
      }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
      openJson: (args?: {
        title?: string
      }) => Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean; error?: string }>
      readFileFrom: (filePath: string, fromByte: number) => Promise<{ ok: boolean; content: string; newOffset: number; error?: string }>
      realpath: (target: string) => Promise<string>
      findManualLog: (workspacePath: string, filename: string) => Promise<{ ok: boolean; path: string | null; error?: string }>
      searchHistoryLogs: (args: { query: string; files: Array<{ id: string; path: string }> }) => Promise<{ matchedIds: string[] }>
      pickFile: (args?: {
        title?: string
        filters?: Array<{ name: string; extensions: string[] }>
        defaultPath?: string
      }) => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
      getPathForFile: (file: File) => string
      stabilizeDroppedPaths: (paths: string[]) => Promise<{ ok: boolean; paths: string[] }>
      saveClipboardImage: (args: { bytes: Uint8Array; mediaType: string }) => Promise<{ ok: boolean; path?: string }>
      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
      onSwitchEditorSidebar: (cb: (sidebar: string) => void) => void
      onOpenEditorDiff: (cb: (params: Record<string, string>) => void) => void
      readKeybindings: () => Promise<{ ok: boolean; content?: string; error?: string }>
      writeKeybindings: (content: string) => Promise<{ ok: boolean; error?: string }>
      onKeybindingsChanged: (cb: (content: string) => void) => void
      getBootstrapSettings: () => string
      broadcastLanguageChange: (locale: string) => void
      onLanguageChanged: (cb: (locale: string) => void) => void
      setQuitConfirm: (cfg: {
        enabled: boolean
        message: string
        detail: string
        quitLabel: string
        cancelLabel: string
        dontShowLabel: string
      }) => void
      onQuitConfirmDisabled: (cb: () => void) => () => void
      onWindowVisibility: (cb: (visible: boolean) => void) => () => void
      readHealthCheckTimeout: () => Promise<{ ok: boolean; timeoutSec?: number }>
      writeHealthCheckTimeout: (timeoutSec: number) => Promise<{ ok: boolean; error?: string }>
      readCdpDebugConfig: () => Promise<{ ok: boolean; config?: { enabled: boolean; port: number } }>
      writeCdpDebugConfig: (config: { enabled: boolean; port: number }) => Promise<{ ok: boolean; error?: string }>
      notify: (args: { paneId?: string; title: string; body?: string }) => Promise<{ ok: boolean }>
      onFocusPane: (cb: (paneId: string) => void) => void
      dispatchPlanExecution: (args: {
        workspace_path: string
        rel_path: string
        agent_key: string
      }) => Promise<{ delivered: boolean }>
      onPlanExecutionDispatch: (
        handler: (args: { workspace_path: string; rel_path: string; agent_key: string }) => void
      ) => () => void
      reportPlanExecutionResult: (args: {
        workspace_path: string
        rel_path: string
        ok: boolean
        reason?: string
      }) => void
      onPlanExecutionResult: (
        handler: (args: { workspace_path: string; rel_path: string; ok: boolean; reason?: string }) => void
      ) => () => void
      getCliPaneBuffer: (
        paneId: string
      ) => Promise<{
        label?: string
        agentKey?: string
        sessionId?: string | null
        sessionHomeId?: string
        workspacePath?: string
        conversationLogPath?: string
        buffer?: string
        error?: string
      }>
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
      ) => void
      cliPaneDragEnd: (
        paneId: string,
        screenX: number,
        screenY: number,
        paneIds?: string[]
      ) => void
      onExternalPaneDrop: (
        handler: (args: {
          paneId: string
          paneIds?: string[]
          screenX: number
          screenY: number
        }) => void
      ) => () => void
      showTerminalContextMenu: (selection: string) => void
      reportTerminalSelection?: (selection: string) => void
      setBadgeCount: (count: number) => void
      reportWorkspace: (workspacePath: string) => void
      restore?: {
        getPending: () => Promise<string[] | null>
        /** Workspaces the restore failure breaker refused to reopen this
         *  launch. Not one-shot on the main side — see App.vue's notice. */
        getSkipped: () => Promise<string[]>
        apply: () => Promise<{ ok: boolean; opened: number }>
        dismiss: () => Promise<{ ok: boolean }>
        getAutoRestore: () => Promise<boolean>
        setAutoRestore: (value: boolean) => Promise<{ ok: boolean }>
      }
      updater?: {
        getState: () => Promise<UpdateState>
        check: () => Promise<UpdateActionResult>
        download: () => Promise<UpdateActionResult>
        install: () => Promise<UpdateActionResult>
        onStateChanged: (cb: (state: UpdateState) => void) => () => void
        getSettings: () => Promise<UpdaterSettings>
        setSettings: (patch: Partial<UpdaterSettings>) => Promise<UpdateSettingsResult>
      }
      gitAccounts?: {
        isAvailable: () => Promise<{ ok: boolean; available?: boolean; error?: string }>
        list: () => Promise<{ ok: boolean; accounts?: GitAccountPublic[]; error?: string }>
        add: (input: GitAccountInput) => Promise<{ ok: boolean; account?: GitAccountPublic; error?: string }>
        update: (id: string, patch: Partial<GitAccountInput>) => Promise<{ ok: boolean; error?: string }>
        remove: (id: string) => Promise<{ ok: boolean; error?: string }>
        bind: (workspacePath: string, accountId: string) => Promise<{ ok: boolean; error?: string }>
        unbind: (workspacePath: string) => Promise<{ ok: boolean; error?: string }>
        getBinding: (workspacePath: string) => Promise<{ ok: boolean; accountId?: string | null; error?: string }>
        getCredential: (
          workspacePath: string
        ) => Promise<{ ok: boolean; credential?: GitCredential | null; error?: string }>
      }
      permissions?: {
        status: () => Promise<Record<TccPermissionKey, TccPermissionStatus>>
        request: (
          key: TccPermissionKey,
          payload?: { title?: string; body?: string }
        ) => Promise<TccPermissionStatus>
        openSettings: (key: TccPermissionKey) => Promise<{ ok: boolean; error?: string }>
      }
      plugins?: {
        listInstalled: () => Promise<InstalledPluginSummary[]>
        marketplaceSearch: (query?: string) => Promise<MarketplaceListResponse>
        prepareInstall: (args: {
          namespace: string
          name: string
          version?: string
        }) => Promise<PreparedInstallSummary>
        commitInstall: (
          id: string,
          approval?: { publisherConfirmed?: boolean; riskConfirmed?: boolean }
        ) => Promise<{ id: string; requires: string[] }>
        remove: (id: string) => Promise<{ ok: boolean }>
      }
    }
  }

  interface InstalledPluginSummary {
    id: string
    requires: string[]
    sensitive: string[]
    provenance?: 'official-registry' | 'developer-local-unpacked'
    warning?: string
  }

  interface MarketplaceExtension {
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

  interface MarketplaceListResponse {
    items: MarketplaceExtension[]
    total: number
    offset: number
    limit: number
  }

  interface PreparedInstallSummary {
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
}

export {}
