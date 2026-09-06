export {
  AGENT_SPECS,
  CLI_AGENT_SPECS,
  REBUILD_CAPABLE_AGENTS,
  RESTORE_PIN_AGENTS,
} from './agents'
export type { AgentKey, AgentSpec, DirLister, PaneArgContext } from './agents'

export { agentProfileFor, agentUsesBracketedPaste, encodeShiftEnter } from './agentProfile'

export {
  cliPermissionKey,
  parseCliPermissionMode,
  skipPermissionFlagFor,
} from './lib/cliPermission'
export type { CliPermissionMode } from './lib/cliPermission'

export { modelArgsFor, supportsEffort, supportsModel } from './lib/cliModel'
export type {
  CliModelCapability,
  CliModelRefusal,
  CliModelRequest,
  CliModelResult,
} from './lib/cliModel'

export { default as AiCliDock } from './components/AiCliDock.vue'
export { default as AiCliTerminal } from './components/AiCliTerminal.vue'

export {
  aiTerminalPaneId,
  bracketedPaste,
  buildPlanCliContext,
  resolveCliCommand,
  truncateText,
  PLAN_DOC_TRUNCATE_AT,
} from './lib/aiCliContext'
export type { PlanCliContextInput, PlanCliMetaSummary } from './lib/aiCliContext'

export {
  acquirePaneRebuildLock,
  buildResumeCommand,
  cancelStalePendingCreate,
  dedupeRestorablePanes,
  normalizeResumeSessionId,
  paneBusyForRebuild,
  paneCanRebuild,
  paneRebuildVisible,
  sessionHomeIdFor,
  shouldPreserveMissingSessionOnRestore,
  shouldWarnMissingResume,
  usesSessionHome,
} from './lib/resume-command'

export { shellEscape } from './lib/shellEscape'
