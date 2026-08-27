/**
 * Host compatibility values for the optional navide.git package.
 *
 * The package owns its public/runtime constants. These values intentionally
 * live in the base application so installing or removing the package source
 * never changes the Host build graph.
 */
export const HOST_GIT_USER_PREFERENCE_KEYS = [
  'agentTeam.git.logScope',
  'agentTeam.git.logOrder',
  'agentTeam.git.autoCommit',
  'agentTeam.gitTopRatio',
] as const

export const HOST_GIT_READ_ONLY_KEYS = [
  'agentTeam.yolo',
  'agentTeam.analyzerModel',
  'agent-team:theme',
  'agent-team:theme-custom',
] as const

export const HOST_GIT_WORKSPACE_REPOSITORY_KEY = 'agentTeam.gitTabRepo' as const

export const HOST_GIT_TIMEOUT_MS = 10_000

export type HostGitTransportStatus = 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'

export interface HostGitTransportStatusSource {
  readonly value: HostGitTransportStatus
}

export interface HostGitTransportError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface HostGitTransportResponse<TPayload = unknown> {
  ok: boolean
  payload: TPayload | null
  error: HostGitTransportError | null
}

/**
 * Temporary Host-side inventory for the legacy recovery implementation.
 * Keep this structurally identical to navide.git's private contract until the
 * recovery sources are removed in Issue 31.
 */
export const HOST_GIT_REQUEST_TYPES = [
  'git.abort',
  'git.add_remote',
  'git.add_worktree',
  'git.amend',
  'git.apply_patch',
  'git.blame',
  'git.branches',
  'git.check_ignore',
  'git.check_staged',
  'git.checkout_commit',
  'git.checkout_remote_branch',
  'git.cherry_pick',
  'git.clean',
  'git.clone',
  'git.commit',
  'git.commit_file_diff',
  'git.compare_branches',
  'git.config_get',
  'git.config_set',
  'git.conflict_stages',
  'git.connect_to_remote',
  'git.create_branch',
  'git.create_tag',
  'git.credential_cancel',
  'git.credential_submit',
  'git.delete_branch',
  'git.delete_tag',
  'git.diff_blame',
  'git.diff_branches',
  'git.diff_file',
  'git.discard',
  'git.discover_repositories',
  'git.fetch',
  'git.file_log',
  'git.generate_message',
  'git.ignore',
  'git.init',
  'git.list_conflicts',
  'git.lock_worktree',
  'git.log',
  'git.mark_resolved',
  'git.merge',
  'git.merge_into',
  'git.move_worktree',
  'git.prune_worktrees',
  'git.pull',
  'git.pull_rebase',
  'git.push',
  'git.push_force',
  'git.push_upstream',
  'git.rebase',
  'git.remotes',
  'git.remove_remote',
  'git.remove_worktree',
  'git.repair_worktrees',
  'git.reset',
  'git.resolve_ours',
  'git.resolve_theirs',
  'git.restore_from_branch',
  'git.revert',
  'git.show_commit',
  'git.show_file',
  'git.stage',
  'git.stage_all',
  'git.stash',
  'git.stash_apply',
  'git.stash_drop',
  'git.stash_list',
  'git.stash_pop',
  'git.status',
  'git.switch_branch',
  'git.sync',
  'git.tags',
  'git.undo_commit',
  'git.unlock_worktree',
  'git.unstage',
  'git.worktrees',
] as const

export type HostGitRequestType = (typeof HOST_GIT_REQUEST_TYPES)[number]

export const HOST_GIT_EVENT_TYPES = [
  'git.changed',
  'git.credential_request',
  'git.credential_cancelled',
] as const

export type HostGitEventType = (typeof HOST_GIT_EVENT_TYPES)[number]

export interface HostGitTransport {
  readonly status: HostGitTransportStatusSource
  send<TPayload = unknown>(
    type: HostGitRequestType,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<HostGitTransportResponse<TPayload>>
  on(type: HostGitEventType, callback: (payload: unknown) => void): () => void
}

// Legacy recovery sources keep their historical type names locally. These
// aliases are not a public plugin API; they disappear with those sources.
export type GitTransportStatus = HostGitTransportStatus
export type GitTransportStatusSource = HostGitTransportStatusSource
export type GitTransportError = HostGitTransportError
export type GitTransportResponse<TPayload = unknown> = HostGitTransportResponse<TPayload>
export type GitRequestType = HostGitRequestType
export type GitEventType = HostGitEventType
export type GitTransport = HostGitTransport
