import type { GitTransport } from '#git-feature'
import type { InjectionKey } from 'vue'
import type { PortResponse } from '@navide/plugin-ui/shared'
import type { ReactiveValue } from '@navide/plugin-ui/shared'
import type {
  ConflictStages,
  DiscoveredRepo,
  GitBranch,
  GitStatus,
} from '../composables/useGit'
import type {
  Issue,
  IssueComment,
  IssueDetail,
  IssueProviderInfo,
} from '../composables/useIssues'

export interface GitFileReadResult {
  ok: boolean
  content: string
  error?: string
}

export interface GitFileWriteResult {
  ok: boolean
  error?: string
}

export interface GitFileAccessPort {
  readFile(workspacePath: string, relPath: string): Promise<GitFileReadResult>
  writeFile(workspacePath: string, relPath: string, content: string): Promise<GitFileWriteResult>
  readImage(workspacePath: string, relPath: string): Promise<string>
}

export interface GitWindowUiPort {
  openInEditor(args: {
    workspacePath: string
    filepath: string
    line?: number
  }): Promise<void>
  openExternal(url: string): Promise<void>
  revealPath(path: string): Promise<void>
  pickFolder(defaultPath?: string): Promise<string | null>
}

/** Legacy GitPane actions that open or manipulate Host-owned windows/files. */
export interface GitPaneUiPort {
  openInEditor(args: {
    workspacePath: string
    filepath: string
    line?: number
  }): Promise<void>
  openExternal(url: string): Promise<void>
  revealPath(path: string): Promise<void>
  openPath(path: string): Promise<void>
  openTempFile(name: string, content: string): Promise<void>
  pickWorkspace(defaultPath?: string): Promise<PickedWorkspace | null>
  openMainWindow(workspacePath: string): Promise<void>
  openBranchDiffWindow(workspacePath: string, base: string): Promise<void>
  openGitWindow(args: {
    workspacePath: string
    filepath?: string
    staged?: boolean
    commit?: string
    base?: string
    compare?: string
  }): Promise<void>
  openGitHistoryWindow(workspacePath: string): Promise<void>
}

/** An opaque Host picker grant accompanies the canonical picked path. */
export interface PickedWorkspace {
  path: string
  grant: string
}

/** Host-owned provenance for a workspace selected by the first-party picker. */
export interface GitWorkspaceGrantPort {
  pickWorkspace(defaultPath?: string): Promise<PickedWorkspace | null>
  openWorkspace(selection: PickedWorkspace): Promise<void>
}

/** Read-only compatibility seed owned by the plugin composition root.
 *
 * Domain components only know that a legacy repository selection may exist;
 * request names and backend transport details stay in the adapter. */
export interface LegacyRepoSelectionPort {
  readLegacyRepoSelection(workspacePath: string): Promise<string | null>
}

export interface GitBranchDiffPort {
  load(workspacePath: string, base: string, compare: string): Promise<{
    ok: boolean
    diff: string
    error?: string
  }>
}

export interface GitAccountPublic {
  id: string
  label: string
  host: string
  username: string
}

export interface GitAccountViewPort {
  accounts: ReactiveValue<GitAccountPublic[]>
  available: ReactiveValue<boolean>
}

export interface GitAccountPort extends GitAccountViewPort {
  refresh(): Promise<void>
  getBinding(workspacePath: string): Promise<string | null>
}

export interface IssuePort {
  provider(workspacePath: string): Promise<PortResponse<IssueProviderInfo>>
  list(workspacePath: string, limit: number): Promise<PortResponse<{
    ok: boolean
    provider: string
    issues: Issue[]
    error?: string
  }>>
  get(workspacePath: string, number: number): Promise<PortResponse<{
    ok: boolean
    issue: IssueDetail
    error?: string
  }>>
  create(workspacePath: string, title: string, body: string): Promise<PortResponse<{
    ok: boolean
    url?: string
    error?: string
  }>>
  comment(workspacePath: string, number: number, body: string): Promise<PortResponse<{
    ok: boolean
    error?: string
  }>>
  setState(workspacePath: string, number: number, state: 'open' | 'closed'): Promise<PortResponse<{
    ok: boolean
    error?: string
  }>>
}

export interface GitSurfacePorts {
  gitTransport: GitTransport
  fileAccess: GitFileAccessPort
  ui: GitWindowUiPort
  paneUi: GitPaneUiPort
  branchDiff: GitBranchDiffPort
  accounts: GitAccountPort
  issues: IssuePort
}

export const GIT_TRANSPORT_KEY: InjectionKey<GitTransport> = Symbol('git-transport')
export const GIT_FILE_ACCESS_KEY: InjectionKey<GitFileAccessPort> = Symbol('git-file-access')
export const GIT_UI_KEY: InjectionKey<GitWindowUiPort> = Symbol('git-ui')
export const GIT_BRANCH_DIFF_KEY: InjectionKey<GitBranchDiffPort> = Symbol('git-branch-diff')
export const GIT_ACCOUNTS_KEY: InjectionKey<GitAccountViewPort> = Symbol('git-accounts')
export const GIT_ISSUES_KEY: InjectionKey<IssuePort> = Symbol('git-issues')

// Keep these imports type-only and colocated with the contracts so adapters can
// share the exact feature shapes without exposing a Host transport to the UI.
export type { ConflictStages, DiscoveredRepo, GitBranch, GitStatus, Issue, IssueComment }
