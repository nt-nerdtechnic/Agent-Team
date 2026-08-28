/** Durable preferences owned by the navide.git package. */
export const GIT_LOG_SCOPE_KEY = 'agentTeam.git.logScope' as const
export const GIT_LOG_ORDER_KEY = 'agentTeam.git.logOrder' as const
export const GIT_AUTO_COMMIT_KEY = 'agentTeam.git.autoCommit' as const
export const GIT_TOP_RATIO_KEY = 'agentTeam.gitTopRatio' as const

export const GIT_USER_PREFERENCE_KEYS = [
  GIT_LOG_SCOPE_KEY,
  GIT_LOG_ORDER_KEY,
  GIT_AUTO_COMMIT_KEY,
  GIT_TOP_RATIO_KEY,
  'git-ai-panel-width',
  'git-ai-panel-width.agent',
] as const

/** Host-owned settings bootstrapped into and broadcast to Git v2 views. */
export const GIT_HOST_READ_ONLY_KEYS = [
  'agentTeam.yolo',
  'agentTeam.analyzerModel',
  'agent-team:theme',
  'agent-team:theme-custom',
] as const

/** Workspace-scoped repository selection owned by the navide.git package. */
export const GIT_WORKSPACE_REPOSITORY_KEY = 'agentTeam.gitTabRepo' as const

/** Legacy renderer key prefix used only while seeding the new workspace key. */
export const GIT_LEGACY_WORKSPACE_REPOSITORY_PREFIX = 'agentTeam.gitTabRepo.' as const
