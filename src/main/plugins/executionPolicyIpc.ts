import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  parseExecutionPolicy,
  PluginContractError,
  type ExecutionPolicy,
} from '../../../packages/plugin-contracts/src/index'
import type {
  ExecutionPolicyError,
  ExecutionPolicyErrorCode,
  ExecutionPolicyOperationResult,
  ExecutionPolicySettingsSnapshot,
  ExecutionPolicySourceRequest,
} from '../../shared/executionPolicy'
import {
  ExecutionPolicySourceCommitError,
  ExecutionPolicySourceStore,
  type ExecutionPolicySourceErrorCode,
} from './executionPolicySourceStore'
import {
  FAIL_CLOSED_EXECUTION_POLICY,
  HOST_DEFAULT_EXECUTION_POLICY,
  ExecutionPolicyManualRepairError,
  ExecutionPolicyRevisionConflictError,
} from './executionPolicyStore'

const ERROR_MESSAGES: Record<ExecutionPolicyErrorCode, string> = {
  'invalid-policy': 'The execution policy is invalid. Use supported modes, system namespaces, and executable names.',
  'high-risk-confirmation-required': 'Full mode requires explicit confirmation that arbitrary executables may run.',
  'recovery-confirmation-required': 'Rebuilding the execution policy requires explicit confirmation.',
  'source-reset-confirmation-required': 'Resetting all Policy Source selections requires explicit confirmation.',
  'invalid-revision': 'The policy revision token is invalid. Inspect the current policy and try again.',
  'policy-conflict': 'The policy changed while it was being edited. Reload the latest policy before saving.',
  'manual-repair-required': 'The policy storage contains an unsafe filesystem entry. Inspect the reported Host-owned path manually.',
  'recovery-unavailable': 'Execution policy recovery is unavailable. Check the policy directory and try again.',
  'invalid-source': 'The selected execution policy source is invalid.',
  'workspace-unavailable': 'The current workspace is unavailable.',
  'source-state-unavailable': 'Policy source selections are temporarily unavailable.',
  'source-state-corrupt': 'Policy source selections are corrupt or unsafe.',
  'source-state-too-large': 'Policy source selections are too large to load safely.',
  'recommendation-unavailable': 'The repository policy recommendation is unavailable.',
  'recommendation-invalid': 'The repository policy recommendation is invalid.',
  'recommendation-stale': 'The repository policy recommendation changed. Inspect it again before accepting it.',
  'user-policy-unavailable': 'No usable global user policy exists. Create one or choose the Host default.',
  'global-policy-corrupt': 'The global execution policy is corrupt. Rebuild it before changing to this source.',
  'recovery-blocked-by-global-policy': 'Source recovery is blocked while the global execution policy is unhealthy.',
  'commit-uncertain': 'The policy change could not be confirmed. The policy remains fail-closed; inspect it again.',
  'operation-unavailable': 'The execution policy could not be changed. Try again.',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalWorkspace(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const workspace = value.trim()
  return workspace.length > 0 ? workspace : undefined
}

function requiredRevision(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
}

function snapshotFallback(): ExecutionPolicySettingsSnapshot {
  return {
    defaultPolicy: { ...HOST_DEFAULT_EXECUTION_POLICY, system: [...HOST_DEFAULT_EXECUTION_POLICY.system], shell: [...HOST_DEFAULT_EXECUTION_POLICY.shell] },
    userPolicy: null,
    global: {
      policy: { ...FAIL_CLOSED_EXECUTION_POLICY, system: [], shell: [] },
      revision: 0,
      state: 'corrupt',
    },
    workspace: null,
    recovery: { state: 'directory-unavailable', canRebuild: false, unsafePaths: [] },
    sourceRecovery: { state: 'unavailable', canReset: false, unsafePaths: [] },
  }
}

function safeSnapshot(
  store: ExecutionPolicySourceStore,
  workspacePath?: string,
): ExecutionPolicySettingsSnapshot {
  try {
    return store.getSettingsSnapshot(workspacePath)
  } catch {
    return snapshotFallback()
  }
}

function errorFor(code: ExecutionPolicyErrorCode): ExecutionPolicyError {
  return { code, message: ERROR_MESSAGES[code] }
}

function sourceErrorCode(code: ExecutionPolicySourceErrorCode): ExecutionPolicyErrorCode {
  return code
}

function errorCodeFor(error: unknown): ExecutionPolicyErrorCode {
  if (error instanceof ExecutionPolicySourceCommitError) return 'commit-uncertain'
  if (error instanceof ExecutionPolicyRevisionConflictError) return 'policy-conflict'
  if (error instanceof ExecutionPolicyManualRepairError) return 'manual-repair-required'
  if (error instanceof PluginContractError && error.code === 'INVALID_EXECUTION_POLICY') {
    return 'invalid-policy'
  }
  const message = error instanceof Error ? error.message : ''
  if (message.includes('global execution policy is corrupt')) return 'global-policy-corrupt'
  if (message.includes('execution policy directory is unsafe')) return 'recovery-unavailable'
  if (message.includes('execution policy directory is unavailable')) return 'recovery-unavailable'
  if (message.includes('unsafe filesystem entry') || message.includes('owner-only JSON file is unsafe')) {
    return 'manual-repair-required'
  }
  if (message.includes('rebuild requires')) return 'recovery-unavailable'
  return 'operation-unavailable'
}

function failure(
  store: ExecutionPolicySourceStore,
  workspacePath: string | undefined,
  code: ExecutionPolicyErrorCode,
): ExecutionPolicyOperationResult {
  return {
    ok: false,
    error: errorFor(code),
    snapshot: safeSnapshot(store, workspacePath),
  }
}

function isFullPolicy(policy: ExecutionPolicy): boolean {
  return policy.mode === 'full'
}

function sourceRequest(value: unknown): SourceRequest | null {
  if (!isRecord(value)) return null
  if (value.source === 'default' || value.source === 'user') {
    return { source: value.source }
  }
  if (value.source === 'repository' && typeof value.expectedFingerprint === 'string') {
    return { source: 'repository', expectedFingerprint: value.expectedFingerprint }
  }
  return null
}

type SourceRequest = ExecutionPolicySourceRequest

export type ExecutionPolicyWorkspaceResolver = (
  event: IpcMainInvokeEvent,
  requestedWorkspace?: string,
) => string | undefined

export interface ExecutionPolicyIpcOptions {
  resolveWorkspace: ExecutionPolicyWorkspaceResolver
  onChanged?: () => void
}

export function registerExecutionPolicyIpc(
  store: ExecutionPolicySourceStore,
  authorizeSender: (event: IpcMainInvokeEvent) => boolean,
  options: ExecutionPolicyIpcOptions,
): void {
  const assertAuthorized = (event: IpcMainInvokeEvent): void => {
    if (!authorizeSender(event)) throw new Error('unauthorized execution policy request')
  }

  const resolveWorkspaceContext = (
    event: IpcMainInvokeEvent,
    requestedWorkspace: string | undefined,
  ): { ok: boolean; workspacePath?: string } => {
    const boundWorkspace = options.resolveWorkspace(event)
    if (requestedWorkspace === undefined) {
      return { ok: true, workspacePath: boundWorkspace }
    }
    const matchedWorkspace = options.resolveWorkspace(event, requestedWorkspace)
    return matchedWorkspace
      ? { ok: true, workspacePath: matchedWorkspace }
      : { ok: false, workspacePath: boundWorkspace }
  }

  ipcMain.handle('execution-policy:inspect', (event, _workspacePath?: unknown) => {
    assertAuthorized(event)
    return safeSnapshot(store, options.resolveWorkspace(event))
  })

  ipcMain.handle(
    'execution-policy:set-user',
    (event, args: unknown): ExecutionPolicyOperationResult => {
      assertAuthorized(event)
      const input = isRecord(args) ? args : {}
      const workspaceContext = resolveWorkspaceContext(event, optionalWorkspace(input.workspacePath))
      if (!workspaceContext.ok) return failure(store, workspaceContext.workspacePath, 'workspace-unavailable')
      const workspacePath = workspaceContext.workspacePath
      let policy: ExecutionPolicy
      try {
        policy = parseExecutionPolicy(input.policy)
      } catch (error) {
        return failure(store, workspacePath, errorCodeFor(error))
      }
      if (isFullPolicy(policy) && input.highRiskConfirmed !== true) {
        return failure(store, workspacePath, 'high-risk-confirmation-required')
      }
      const expectedRevision = requiredRevision(input.expectedRevision)
      if (expectedRevision === null) {
        return failure(store, workspacePath, 'invalid-revision')
      }
      const before = safeSnapshot(store, workspacePath)
      try {
        const snapshot = store.setUserPolicy(policy, workspacePath, expectedRevision)
        options.onChanged?.()
        return {
          ok: true,
          changed: snapshot.global.revision !== before.global.revision,
          snapshot,
        }
      } catch (error) {
        return failure(store, workspacePath, errorCodeFor(error))
      }
    },
  )

  ipcMain.handle(
    'execution-policy:reset-user',
    (event, args: unknown): ExecutionPolicyOperationResult => {
      assertAuthorized(event)
      const input = isRecord(args) ? args : {}
      const workspaceContext = resolveWorkspaceContext(event, optionalWorkspace(input.workspacePath))
      if (!workspaceContext.ok) return failure(store, workspaceContext.workspacePath, 'workspace-unavailable')
      const workspacePath = workspaceContext.workspacePath
      const expectedRevision = requiredRevision(input.expectedRevision)
      if (expectedRevision === null) {
        return failure(store, workspacePath, 'invalid-revision')
      }
      const before = safeSnapshot(store, workspacePath)
      try {
        const snapshot = store.resetUserPolicy(workspacePath, expectedRevision)
        const changed = snapshot.global.revision !== before.global.revision
        if (changed) options.onChanged?.()
        return { ok: true, changed, snapshot }
      } catch (error) {
        return failure(store, workspacePath, errorCodeFor(error))
      }
    },
  )

  ipcMain.handle(
    'execution-policy:select-source',
    (event, args: unknown): ExecutionPolicyOperationResult => {
      assertAuthorized(event)
      const input = isRecord(args) ? args : {}
      const requestedWorkspace = optionalWorkspace(input.workspacePath)
      const request = sourceRequest(input.request)
      if (!requestedWorkspace || request === null) {
        return failure(
          store,
          options.resolveWorkspace(event),
          !requestedWorkspace ? 'workspace-unavailable' : 'invalid-source',
        )
      }
      const workspaceContext = resolveWorkspaceContext(event, requestedWorkspace)
      if (!workspaceContext.ok) return failure(store, workspaceContext.workspacePath, 'workspace-unavailable')
      const workspacePath = workspaceContext.workspacePath
      if (!workspacePath) return failure(store, undefined, 'workspace-unavailable')
      let result: ReturnType<ExecutionPolicySourceStore['selectSource']>
      try {
        result = store.selectSource(workspacePath, request, { highRiskConfirmed: input.highRiskConfirmed === true })
      } catch (error) {
        return failure(store, workspacePath, errorCodeFor(error))
      }
      if (!result.ok) {
        return {
          ok: false,
          error: errorFor(sourceErrorCode(result.error.code)),
          snapshot: safeSnapshot(store, workspacePath),
        }
      }
      const snapshot = safeSnapshot(store, workspacePath)
      if (result.changed) options.onChanged?.()
      return { ok: true, changed: result.changed, snapshot }
    },
  )

  ipcMain.handle(
    'execution-policy:rebuild',
    (event, args: unknown): ExecutionPolicyOperationResult => {
      assertAuthorized(event)
      const input = isRecord(args) ? args : {}
      const workspaceContext = resolveWorkspaceContext(event, optionalWorkspace(input.workspacePath))
      if (!workspaceContext.ok) return failure(store, workspaceContext.workspacePath, 'workspace-unavailable')
      const workspacePath = workspaceContext.workspacePath
      if (input.confirmed !== true) {
        return failure(store, workspacePath, 'recovery-confirmation-required')
      }
      try {
        const snapshot = store.rebuildGlobalPolicy(workspacePath)
        options.onChanged?.()
        return { ok: true, changed: true, snapshot }
      } catch (error) {
        return failure(store, workspacePath, errorCodeFor(error))
      }
    },
  )

  ipcMain.handle(
    'execution-policy:reset-source-selections',
    (event, args: unknown): ExecutionPolicyOperationResult => {
      assertAuthorized(event)
      const input = isRecord(args) ? args : {}
      const workspaceContext = resolveWorkspaceContext(event, optionalWorkspace(input.workspacePath))
      if (!workspaceContext.ok) return failure(store, workspaceContext.workspacePath, 'workspace-unavailable')
      const workspacePath = workspaceContext.workspacePath
      if (input.confirmed !== true) {
        return failure(store, workspacePath, 'source-reset-confirmation-required')
      }
      try {
        const result = store.resetSourceState()
        if (!result.ok) {
          return {
            ok: false,
            error: errorFor(sourceErrorCode(result.error.code)),
            snapshot: safeSnapshot(store, workspacePath),
          }
        }
        const snapshot = safeSnapshot(store, workspacePath)
        if (result.changed) options.onChanged?.()
        return { ok: true, changed: result.changed, snapshot }
      } catch (error) {
        return failure(store, workspacePath, errorCodeFor(error))
      }
    },
  )
}
