import type {
  ExecutionPolicy,
  PluginShellMode,
  PluginSystemNamespace,
} from '../../packages/plugin-contracts/src/index'

export type ExecutionPolicySource = 'default' | 'user' | 'repository'

export type RepositoryPolicyRecommendationState =
  | 'missing'
  | 'valid'
  | 'invalid'
  | 'stale'
  | 'unavailable'

export type ExecutionPolicySourceStatus =
  | 'active'
  | 'stale'
  | 'unavailable'
  | 'corrupt'

export type ExecutionPolicyGlobalState = 'default' | 'user' | 'corrupt'

export interface ExecutionPolicyGlobalSnapshot {
  policy: ExecutionPolicy
  revision: number
  state: ExecutionPolicyGlobalState
}

export interface ExecutionPolicyRepositoryRecommendation {
  state: RepositoryPolicyRecommendationState
  policy: ExecutionPolicy | null
  fingerprint: string | null
}

export interface ExecutionPolicySourceSnapshot {
  policy: ExecutionPolicy
  revision: number
  selectedSource: ExecutionPolicySource | null
  activeSource: ExecutionPolicySource | null
  status: ExecutionPolicySourceStatus
  recommendation: ExecutionPolicyRepositoryRecommendation
  effectivePolicyKey: string
  effectivePolicyHash: string
}

export type ExecutionPolicyRecoveryState =
  | 'healthy'
  | 'missing'
  | 'corrupt'
  | 'unsafe-entry'
  | 'directory-unsafe'
  | 'directory-unavailable'

export interface ExecutionPolicyRecoveryStatus {
  state: ExecutionPolicyRecoveryState
  canRebuild: boolean
  unsafePaths: string[]
}

export type ExecutionPolicySourceRecoveryState =
  | 'healthy'
  | 'missing'
  | 'corrupt'
  | 'unsafe-entry'
  | 'unavailable'

export interface ExecutionPolicySourceRecoveryStatus {
  state: ExecutionPolicySourceRecoveryState
  canReset: boolean
  unsafePaths: string[]
}

export interface ExecutionPolicySettingsSnapshot {
  defaultPolicy: ExecutionPolicy
  userPolicy: ExecutionPolicy | null
  global: ExecutionPolicyGlobalSnapshot
  workspace: ExecutionPolicySourceSnapshot | null
  recovery: ExecutionPolicyRecoveryStatus
  sourceRecovery: ExecutionPolicySourceRecoveryStatus
}

export type ExecutionPolicySourceRequest =
  | { source: 'default' }
  | { source: 'user' }
  | { source: 'repository'; expectedFingerprint: string }

export type ExecutionPolicyErrorCode =
  | 'invalid-policy'
  | 'high-risk-confirmation-required'
  | 'recovery-confirmation-required'
  | 'source-reset-confirmation-required'
  | 'invalid-revision'
  | 'policy-conflict'
  | 'manual-repair-required'
  | 'recovery-unavailable'
  | 'invalid-source'
  | 'workspace-unavailable'
  | 'source-state-unavailable'
  | 'source-state-corrupt'
  | 'source-state-too-large'
  | 'recommendation-unavailable'
  | 'recommendation-invalid'
  | 'recommendation-stale'
  | 'user-policy-unavailable'
  | 'global-policy-corrupt'
  | 'recovery-blocked-by-global-policy'
  | 'commit-uncertain'
  | 'operation-unavailable'

export interface ExecutionPolicyError {
  code: ExecutionPolicyErrorCode
  message: string
}

export type ExecutionPolicyOperationResult =
  | { ok: true; changed: boolean; snapshot: ExecutionPolicySettingsSnapshot }
  | { ok: false; error: ExecutionPolicyError; snapshot: ExecutionPolicySettingsSnapshot }

export interface ExecutionPolicyApi {
  inspect: (workspacePath?: string) => Promise<ExecutionPolicySettingsSnapshot>
  setUser: (args: {
    policy: ExecutionPolicy
    expectedRevision: number
    highRiskConfirmed?: boolean
    workspacePath?: string
  }) => Promise<ExecutionPolicyOperationResult>
  resetUser: (args: {
    expectedRevision: number
    workspacePath?: string
  }) => Promise<ExecutionPolicyOperationResult>
  selectSource: (args: {
    workspacePath: string
    request: ExecutionPolicySourceRequest
    highRiskConfirmed?: boolean
  }) => Promise<ExecutionPolicyOperationResult>
  rebuild: (args: { confirmed?: boolean; workspacePath?: string }) => Promise<ExecutionPolicyOperationResult>
  resetSourceSelections: (args: {
    confirmed?: boolean
    workspacePath?: string
  }) => Promise<ExecutionPolicyOperationResult>
  onChanged: (handler: () => void) => () => void
}

export interface ManifestPermissionsSummary {
  system: PluginSystemNamespace[]
  shell?: PluginShellMode
}

export interface PackageVersionGrantSummary {
  packageVersion: string
  system: PluginSystemNamespace[]
  shell?: PluginShellMode
  highRiskShellConfirmed?: boolean
  storage?: boolean
}
