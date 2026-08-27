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
