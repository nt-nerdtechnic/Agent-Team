import type { GitTransport } from '@navide/git-feature'
import type { InjectionKey } from 'vue'
import type { PortResponse, ReactiveValue } from '@navide/shared'
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
  openWorkspace(path: string): Promise<void>
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
  pickWorkspace(defaultPath?: string): Promise<string | null>
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

export interface GitBranchDiffPort {
  load(workspacePath: string, base: string, compare: string): Promise<{
    ok: boolean
    diff: string
    error?: string
  }>
}

export interface GitCredentialPort {
  getCredential?(workspacePath: string): Promise<GitCredential | null>
}

export interface GitCredential {
  username: string
  token: string
  expectedHost: string
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

export interface GitAccountViewPort {
  accounts: ReactiveValue<GitAccountPublic[]>
  available: ReactiveValue<boolean>
}

export interface GitCredentialAccountPort extends GitAccountViewPort {
  refresh?(): Promise<void>
  addAccount?(input: GitAccountInput): Promise<boolean>
  bind?(workspacePath: string, accountId: string): Promise<boolean>
}

export interface GitAccountPort extends GitAccountViewPort {
  refresh(): Promise<void>
  addAccount(input: GitAccountInput): Promise<boolean>
  updateAccount(id: string, patch: Partial<GitAccountInput>): Promise<boolean>
  removeAccount(id: string): Promise<boolean>
  bind(workspacePath: string, accountId: string): Promise<boolean>
  unbind(workspacePath: string): Promise<boolean>
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

export interface GitSettingsPort {
  status: ReactiveValue<'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'>
  getAll(): Promise<Record<string, unknown> | null>
  setMany(updates: Record<string, unknown>): Promise<void>
  onChanged(callback: (payload: unknown) => void): () => void
}

export interface GitSurfacePorts {
  gitTransport: GitTransport
  fileAccess: GitFileAccessPort
  ui: GitWindowUiPort
  paneUi: GitPaneUiPort
  branchDiff: GitBranchDiffPort
  credentials?: GitCredentialPort
  accounts: GitAccountPort
  issues: IssuePort
  settings?: GitSettingsPort
}

export const GIT_TRANSPORT_KEY: InjectionKey<GitTransport> = Symbol('git-transport')
export const GIT_FILE_ACCESS_KEY: InjectionKey<GitFileAccessPort> = Symbol('git-file-access')
export const GIT_UI_KEY: InjectionKey<GitWindowUiPort> = Symbol('git-ui')
export const GIT_BRANCH_DIFF_KEY: InjectionKey<GitBranchDiffPort> = Symbol('git-branch-diff')
export const GIT_CREDENTIALS_KEY: InjectionKey<GitCredentialPort> = Symbol('git-credentials')
export const GIT_ACCOUNTS_KEY: InjectionKey<GitAccountViewPort> = Symbol('git-accounts')
export const GIT_ISSUES_KEY: InjectionKey<IssuePort> = Symbol('git-issues')

// Keep these imports type-only and colocated with the contracts so adapters can
// share the exact feature shapes without exposing a Host transport to the UI.
export type { ConflictStages, DiscoveredRepo, GitBranch, GitStatus, Issue, IssueComment }
