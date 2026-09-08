import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  isHighRiskExecutionPolicy,
  parseExecutionPolicyJson,
  type ExecutionPolicy,
} from '../../../packages/plugin-contracts/src/index'
import {
  canonicalExistingDirectory,
  resolveWorkspaceRelativePath,
} from './workspacePathPolicy'
import { cloneExecutionPolicy, type ExecutionPolicySnapshot } from './executionPolicy'
import {
  EXECUTION_POLICY_DIRECTORY,
  FAIL_CLOSED_EXECUTION_POLICY,
  HOST_DEFAULT_EXECUTION_POLICY,
  ExecutionPolicyManualRepairError,
  ExecutionPolicyStore,
} from './executionPolicyStore'
import { OwnerOnlyJsonPersistence } from './ownerOnlyJsonPersistence'
import type {
  ExecutionPolicySettingsSnapshot,
  ExecutionPolicySourceRecoveryStatus,
} from '../../shared/executionPolicy'

export const REPOSITORY_EXECUTION_POLICY_PATH = '.navide/execution-policy.json'
export const EXECUTION_POLICY_SOURCES_FILE = 'sources.json'
export const EXECUTION_POLICY_SOURCES_REVISION_FILE = 'sources-revision.json'

const REPOSITORY_POLICY_DIRECTORY = '.navide'
const REPOSITORY_POLICY_FILE = 'execution-policy.json'
const MAX_REPOSITORY_POLICY_BYTES = 256 * 1024
const MAX_SOURCE_STATE_BYTES = 256 * 1024
const NO_FOLLOW_FLAG = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW

export type ExecutionPolicySource = 'default' | 'user' | 'repository'

export type SourceSelectionRequest =
  | { source: 'default' }
  | { source: 'user' }
  | { source: 'repository'; expectedFingerprint: string }

export type RepositoryPolicyRecommendationState =
  | 'missing'
  | 'valid'
  | 'invalid'
  | 'stale'
  | 'unavailable'
export type ExecutionPolicySourceSnapshotStatus =
  | 'active'
  | 'stale'
  | 'unavailable'
  | 'corrupt'

export type ExecutionPolicySourceErrorCode =
  | 'invalid-source'
  | 'high-risk-confirmation-required'
  | 'workspace-unavailable'
  | 'source-state-unavailable'
  | 'source-state-corrupt'
  | 'source-state-too-large'
  | 'recommendation-unavailable'
  | 'recommendation-invalid'
  | 'recommendation-stale'
  | 'user-policy-unavailable'
  | 'global-policy-corrupt'
  | 'manual-repair-required'
  | 'recovery-blocked-by-global-policy'

export interface RepositoryPolicyRecommendation {
  state: RepositoryPolicyRecommendationState
  policy: ExecutionPolicy | null
  fingerprint: string | null
}

export interface ExecutionPolicySourceSnapshot {
  policy: ExecutionPolicy
  revision: number
  selectedSource: ExecutionPolicySource | null
  activeSource: ExecutionPolicySource | null
  status: ExecutionPolicySourceSnapshotStatus
  recommendation: RepositoryPolicyRecommendation
  effectivePolicyKey: string
  effectivePolicyHash: string
}

export interface ExecutionPolicySourceError {
  code: ExecutionPolicySourceErrorCode
  message: string
}

export type SourceOperationResult<TSnapshot> =
  | { ok: true; changed: boolean; snapshot: TSnapshot }
  | { ok: false; error: ExecutionPolicySourceError; snapshot: TSnapshot }

export type SelectSourceResult = SourceOperationResult<ExecutionPolicySourceSnapshot>
export type ResetSourceStateResult = SourceOperationResult<null>

export class ExecutionPolicySourceCommitError extends Error {
  constructor() {
    super('execution policy source commit outcome is uncertain')
    this.name = 'ExecutionPolicySourceCommitError'
  }
}

type FileReadResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' }
  | { kind: 'text'; value: string }

type PersistedSourceSelection =
  | { source: 'default' }
  | { source: 'user' }
  | { source: 'repository'; fingerprint: string }

type PersistedSourceState = {
  schemaVersion: 1
  revision: number
  selections: Record<string, PersistedSourceSelection>
}

type PersistedSourceRevision = {
  schemaVersion: 1
  highWater: number
}

type SourceStateRead =
  | { kind: 'missing'; revision: number; unsafePaths: string[] }
  | {
      kind: 'valid'
      revision: number
      selections: Record<string, PersistedSourceSelection>
      highWaterTrusted: true
      unsafePaths: string[]
    }
  | {
      kind: 'corrupt'
      revision: number
      highWaterTrusted: boolean
      reason: 'invalid' | 'too-large' | 'unsafe'
      unsafePaths: string[]
    }
  | { kind: 'unavailable'; revision: number; highWaterTrusted: boolean; unsafePaths: string[] }

type SourceSelectionContext = {
  global: ExecutionPolicySnapshot
  sourceState: SourceStateRead
  workspace: string | null
  recommendation: RepositoryPolicyRecommendation
  snapshot: ExecutionPolicySourceSnapshot
}

type JsonReadResult =
  | { kind: 'missing' }
  | { kind: 'present'; value: unknown }
  | { kind: 'corrupt'; reason: 'invalid' | 'unsafe' }
  | { kind: 'too-large' }
  | { kind: 'unavailable' }

class SourceStateTooLargeError extends Error {}

class BoundedFileTooLargeError extends Error {}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function isUnavailableError(error: unknown): boolean {
  return [
    'EACCES',
    'EBUSY',
    'EIO',
    'EMFILE',
    'ENFILE',
    'ENOSPC',
    'EPERM',
    'ETIMEDOUT',
  ].includes(errorCode(error) ?? '')
}

function sameFileSnapshot(
  left: { dev: number; ino: number; mode: number; size: number },
  right: { dev: number; ino: number; mode: number; size: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.size === right.size
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSourceSelection(value: unknown): PersistedSourceSelection {
  if (!isRecord(value) || typeof value.source !== 'string') {
    throw new Error('execution policy source selection is invalid')
  }

  if (value.source === 'repository') {
    if (Object.keys(value).some((key) => !['source', 'fingerprint'].includes(key)) ||
      typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(value.fingerprint)) {
      throw new Error('repository execution policy source selection is invalid')
    }
    return { source: 'repository', fingerprint: value.fingerprint }
  }

  if (value.source !== 'default' && value.source !== 'user') {
    throw new Error('execution policy source selection is invalid')
  }
  if (Object.keys(value).length !== 1) {
    throw new Error('execution policy source selection has unknown fields')
  }
  return { source: value.source }
}

function parsePersistedSourceState(value: unknown): PersistedSourceState {
  if (!isRecord(value) ||
    Object.keys(value).some((key) => !['schemaVersion', 'revision', 'selections'].includes(key))) {
    throw new Error('execution policy source state is invalid')
  }
  if (value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    !isRecord(value.selections)) {
    throw new Error('execution policy source state is invalid')
  }

  const selections: Record<string, PersistedSourceSelection> = {}
  for (const [workspace, selection] of Object.entries(value.selections)) {
    if (!isAbsolute(workspace) || workspace.includes('\0')) {
      throw new Error('execution policy source workspace key is invalid')
    }
    selections[workspace] = parseSourceSelection(selection)
  }
  if (value.revision === 0 && Object.keys(selections).length > 0) {
    throw new Error('execution policy source state has an invalid revision')
  }

  return {
    schemaVersion: 1,
    revision: value.revision as number,
    selections,
  }
}

function parsePersistedSourceRevision(value: unknown): PersistedSourceRevision {
  if (!isRecord(value) ||
    Object.keys(value).some((key) => !['schemaVersion', 'highWater'].includes(key)) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.highWater) || (value.highWater as number) < 0) {
    throw new Error('execution policy source revision is invalid')
  }
  return { schemaVersion: 1, highWater: value.highWater as number }
}

function canonicalPolicyFingerprint(policy: ExecutionPolicy): string {
  return createHash('sha256').update(canonicalPolicyJson(policy), 'utf8').digest('hex')
}

function missingRecommendation(): RepositoryPolicyRecommendation {
  return { state: 'missing', policy: null, fingerprint: null }
}

function invalidRecommendation(): RepositoryPolicyRecommendation {
  return { state: 'invalid', policy: null, fingerprint: null }
}

function unavailableRecommendation(): RepositoryPolicyRecommendation {
  return { state: 'unavailable', policy: null, fingerprint: null }
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalPolicyJson(policy: ExecutionPolicy): string {
  return JSON.stringify({
    schemaVersion: policy.schemaVersion,
    mode: policy.mode,
    system: [...policy.system].sort(compareStableStrings),
    shell: [...policy.shell].sort(compareStableStrings),
  })
}

function policyHash(policy: ExecutionPolicy): string {
  return `eph1:${createHash('sha256').update(canonicalPolicyJson(policy), 'utf8').digest('hex')}`
}

function effectiveKey(payload: {
  revision: number
  selectedSource: ExecutionPolicySource | null
  activeSource: ExecutionPolicySource | null
  status: ExecutionPolicySourceSnapshotStatus
  acceptedFingerprint: string | null
  recommendation: RepositoryPolicyRecommendation
  effectivePolicyHash: string
}): string {
  const canonical = JSON.stringify({
    schemaVersion: 1,
    revision: payload.revision,
    selectedSource: payload.selectedSource,
    activeSource: payload.activeSource,
    status: payload.status,
    acceptedFingerprint: payload.acceptedFingerprint,
    recommendationState: payload.recommendation.state,
    recommendationFingerprint: payload.recommendation.fingerprint,
    effectivePolicyHash: payload.effectivePolicyHash,
  })
  return `epk1:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

const SOURCE_ERROR_MESSAGES: Record<ExecutionPolicySourceErrorCode, string> = {
  'high-risk-confirmation-required': 'full repository policy requires explicit high-risk confirmation',
  'invalid-source': 'execution policy source is invalid',
  'workspace-unavailable': 'workspace is unavailable',
  'source-state-unavailable': 'execution policy source state is unavailable',
  'source-state-corrupt': 'execution policy source state is corrupt or unsafe',
  'source-state-too-large': 'execution policy source state is too large',
  'recommendation-unavailable': 'repository execution policy recommendation is unavailable',
  'recommendation-invalid': 'repository execution policy recommendation is invalid',
  'recommendation-stale': 'repository execution policy recommendation is stale',
  'user-policy-unavailable': 'global user execution policy is unavailable',
  'global-policy-corrupt': 'global execution policy is corrupt or unsafe',
  'manual-repair-required': 'execution policy state requires manual repair',
  'recovery-blocked-by-global-policy': 'source recovery is blocked by global policy state',
}

function sourceError(code: ExecutionPolicySourceErrorCode): ExecutionPolicySourceError {
  return { code, message: SOURCE_ERROR_MESSAGES[code] }
}

function readBoundedUtf8(fd: number, initialSize: number, maximumBytes: number): string {
  if (!Number.isSafeInteger(initialSize) || initialSize < 0 || initialSize > maximumBytes) {
    throw new BoundedFileTooLargeError('repository execution policy is too large')
  }

  const chunks: Buffer[] = []
  const buffer = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1))
  let total = 0
  while (true) {
    const count = readSync(fd, buffer, 0, buffer.length, null)
    if (count === 0) break
    total += count
    if (total > maximumBytes) {
      throw new BoundedFileTooLargeError('repository execution policy is too large')
    }
    chunks.push(Buffer.from(buffer.subarray(0, count)))
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export class ExecutionPolicySourceStore {
  private readonly policyStore: ExecutionPolicyStore
  private readonly sourceDirectory: string
  private readonly sourceFile: string
  private readonly sourceRevisionFile: string
  private readonly persistence: OwnerOnlyJsonPersistence
  private sourceRevisionFloor = 0

  constructor(userData: string, policyStore = new ExecutionPolicyStore(userData)) {
    this.policyStore = policyStore
    this.sourceDirectory = join(userData, EXECUTION_POLICY_DIRECTORY)
    this.sourceFile = join(this.sourceDirectory, EXECUTION_POLICY_SOURCES_FILE)
    this.sourceRevisionFile = join(this.sourceDirectory, EXECUTION_POLICY_SOURCES_REVISION_FILE)
    this.persistence = new OwnerOnlyJsonPersistence(
      this.sourceDirectory,
      MAX_SOURCE_STATE_BYTES,
      MAX_SOURCE_STATE_BYTES,
    )
  }

  inspectRepository(workspacePath: string): RepositoryPolicyRecommendation {
    const workspace = canonicalExistingDirectory(workspacePath)
    return workspace === null
      ? unavailableRecommendation()
      : this.readRepositoryRecommendation(workspace)
  }

  getEffectivePolicy(workspacePath: string): ExecutionPolicySourceSnapshot {
    return this.readSelectionContext(workspacePath).snapshot
  }

  /** Return only the global policy for plugin-scoped operations that have no
   * workspace source to select. Repository recommendations are workspace
   * scoped and therefore do not participate in this snapshot. */
  getGlobalEffectivePolicy(): ExecutionPolicySnapshot {
    return this.policyStore.getEffectivePolicy()
  }

  getSettingsSnapshot(workspacePath?: string): ExecutionPolicySettingsSnapshot {
    const globalState = this.policyStore.getSettingsState()
    const sourceState = this.readSourceState()
    const workspace = typeof workspacePath === 'string' && workspacePath.trim().length > 0
      ? this.readSelectionContext(workspacePath, globalState.global, sourceState).snapshot
      : null
    return {
      ...globalState,
      workspace,
      sourceRecovery: this.sourceRecoveryStatus(sourceState),
    }
  }

  setUserPolicy(
    raw: unknown,
    workspacePath?: string,
    expectedRevision?: number,
  ): ExecutionPolicySettingsSnapshot {
    this.assertSettingsMutationAvailable()
    this.policyStore.setUserPolicy(raw, expectedRevision)
    return this.getSettingsSnapshot(workspacePath)
  }

  resetUserPolicy(
    workspacePath?: string,
    expectedRevision?: number,
  ): ExecutionPolicySettingsSnapshot {
    this.assertSettingsMutationAvailable()
    this.policyStore.resetUserPolicy(expectedRevision)
    return this.getSettingsSnapshot(workspacePath)
  }

  rebuildGlobalPolicy(workspacePath?: string): ExecutionPolicySettingsSnapshot {
    const sourceState = this.readSourceState()
    const sourceRevisionFloor = Math.max(this.sourceRevisionFloor, sourceState.revision)
    this.policyStore.rebuild(sourceRevisionFloor)
    return this.getSettingsSnapshot(workspacePath)
  }

  private assertSettingsMutationAvailable(): void {
    const recovery = this.policyStore.getRecoveryStatus()
    if (recovery.state === 'unsafe-entry') {
      throw new Error('execution policy state contains an unsafe filesystem entry')
    }
    if (recovery.state === 'corrupt') {
      throw new Error('global execution policy is corrupt or unsafe; rebuild is required')
    }
    if (recovery.state === 'directory-unsafe') {
      throw new Error('execution policy directory is unsafe')
    }
    if (recovery.state === 'directory-unavailable') {
      throw new Error('execution policy directory is unavailable')
    }
  }

  private sourceRecoveryStatus(state: SourceStateRead): ExecutionPolicySourceRecoveryStatus {
    if (state.kind === 'missing') {
      return { state: 'missing', canReset: false, unsafePaths: [] }
    }
    if (state.kind === 'unavailable') {
      return { state: 'unavailable', canReset: false, unsafePaths: state.unsafePaths }
    }
    if (state.kind === 'corrupt') {
      return {
        state: state.reason === 'unsafe' ? 'unsafe-entry' : 'corrupt',
        canReset: state.highWaterTrusted && state.reason !== 'unsafe',
        unsafePaths: state.unsafePaths,
      }
    }
    return {
      state: 'healthy',
      canReset: Object.keys(state.selections).length > 0,
      unsafePaths: [],
    }
  }

  private readSelectionContext(
    workspacePath: string,
    suppliedGlobal?: ExecutionPolicySnapshot,
    suppliedSourceState?: SourceStateRead,
  ): SourceSelectionContext {
    const global = suppliedGlobal ?? this.policyStore.getEffectivePolicy()
    const sourceState = suppliedSourceState ?? this.readSourceState()
    const workspace = canonicalExistingDirectory(workspacePath)
    const recommendation = workspace === null
      ? unavailableRecommendation()
      : this.readRepositoryRecommendation(workspace)
    const snapshot = this.makeEffectiveSnapshot({
      global,
      sourceState,
      workspace,
      recommendation,
    })
    return { global, sourceState, workspace, recommendation, snapshot }
  }

  private makeEffectiveSnapshot(input: {
    global: ExecutionPolicySnapshot
    sourceState: SourceStateRead
    workspace: string | null
    recommendation: RepositoryPolicyRecommendation
  }): ExecutionPolicySourceSnapshot {
    const { global, sourceState, workspace, recommendation } = input
    const revision = Math.max(global.revision, sourceState.revision, this.sourceRevisionFloor)

    if (workspace === null) {
      return this.makeSnapshot({
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        revision,
        selectedSource: null,
        activeSource: null,
        status: 'unavailable',
        recommendation,
        acceptedFingerprint: null,
      })
    }

    const selection = sourceState.kind === 'valid'
      ? sourceState.selections[workspace]
      : undefined
    const selectedSource = selection?.source ?? null

    if (sourceState.kind === 'unavailable') {
      return this.makeSnapshot({
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        revision,
        selectedSource: null,
        activeSource: null,
        status: 'unavailable',
        recommendation,
        acceptedFingerprint: null,
      })
    }

    if (sourceState.kind === 'corrupt' ||
      (sourceState.kind === 'valid' && sourceState.revision > global.revision)) {
      return this.makeSnapshot({
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        revision,
        selectedSource: null,
        activeSource: null,
        status: 'corrupt',
        recommendation,
        acceptedFingerprint: null,
      })
    }

    if (global.state === 'corrupt') {
      if (selection?.source === 'default') {
        return this.makeSnapshot({
          policy: HOST_DEFAULT_EXECUTION_POLICY,
          revision,
          selectedSource: 'default',
          activeSource: 'default',
          status: 'active',
          recommendation,
          acceptedFingerprint: null,
        })
      }
      return this.makeSnapshot({
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        revision,
        selectedSource,
        activeSource: null,
        status: 'corrupt',
        recommendation,
        acceptedFingerprint: selection?.source === 'repository' ? selection.fingerprint : null,
      })
    }

    if (selection?.source === 'repository') {
      if (recommendation.state === 'valid' && recommendation.policy !== null &&
        recommendation.fingerprint === selection.fingerprint) {
        return this.makeSnapshot({
          policy: recommendation.policy,
          revision: global.revision,
          selectedSource: 'repository',
          activeSource: 'repository',
          status: 'active',
          recommendation,
          acceptedFingerprint: selection.fingerprint,
        })
      }

      if (recommendation.state === 'valid') {
        return this.makeSnapshot({
          policy: FAIL_CLOSED_EXECUTION_POLICY,
          revision: global.revision,
          selectedSource: 'repository',
          activeSource: null,
          status: 'stale',
          recommendation: { ...recommendation, state: 'stale' },
          acceptedFingerprint: selection.fingerprint,
        })
      }

      return this.makeSnapshot({
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        revision: global.revision,
        selectedSource: 'repository',
        activeSource: null,
        status: recommendation.state === 'invalid' ? 'corrupt' : 'unavailable',
        recommendation,
        acceptedFingerprint: selection.fingerprint,
      })
    }

    if (selection?.source === 'default') {
      return this.makeSnapshot({
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: global.revision,
        selectedSource: 'default',
        activeSource: 'default',
        status: 'active',
        recommendation,
        acceptedFingerprint: null,
      })
    }

    if (selection?.source === 'user') {
      if (global.state === 'user') {
        return this.makeSnapshot({
          policy: global.policy,
          revision: global.revision,
          selectedSource: 'user',
          activeSource: 'user',
          status: 'active',
          recommendation,
          acceptedFingerprint: null,
        })
      }
      return this.makeSnapshot({
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        revision: global.revision,
        selectedSource: 'user',
        activeSource: null,
        status: 'unavailable',
        recommendation,
        acceptedFingerprint: null,
      })
    }

    if (global.state === 'user') {
      return this.makeSnapshot({
        policy: global.policy,
        revision: global.revision,
        selectedSource: null,
        activeSource: 'user',
        status: 'active',
        recommendation,
        acceptedFingerprint: null,
      })
    }

    return this.makeSnapshot({
      policy: HOST_DEFAULT_EXECUTION_POLICY,
      revision: global.revision,
      selectedSource: null,
      activeSource: 'default',
      status: 'active',
      recommendation,
      acceptedFingerprint: null,
    })
  }

  selectSource(
    workspacePath: string,
    request: SourceSelectionRequest,
    options: { highRiskConfirmed?: boolean } = {},
  ): SelectSourceResult {
    const context = this.readSelectionContext(workspacePath)
    const { global, sourceState, workspace, recommendation, snapshot: currentSnapshot } = context

    if (workspace === null) return this.failedSelection('workspace-unavailable', currentSnapshot)

    const source = isRecord(request) ? request.source : undefined
    if (source !== 'default' && source !== 'user' && source !== 'repository') {
      return this.failedSelection('invalid-source', currentSnapshot)
    }

    if (sourceState.kind === 'corrupt') {
      return this.failedSelection(
        sourceState.reason === 'too-large' ? 'source-state-too-large' : 'source-state-corrupt',
        currentSnapshot,
      )
    }
    if (sourceState.kind === 'unavailable') {
      return this.failedSelection('source-state-unavailable', currentSnapshot)
    }

    const isDefaultRecovery = global.state === 'corrupt' && source === 'default'
    if (global.state === 'corrupt' && !isDefaultRecovery) {
      return this.failedSelection('global-policy-corrupt', currentSnapshot)
    }

    const fingerprint = source === 'repository'
      ? this.selectableFingerprint(recommendation)
      : undefined
    if (source === 'repository' && fingerprint === null) {
      return this.failedSelection(this.recommendationError(recommendation), currentSnapshot)
    }
    if (source === 'repository') {
      const expectedFingerprint = isRecord(request) && request.source === 'repository' &&
        typeof request.expectedFingerprint === 'string'
        ? request.expectedFingerprint
        : null
      if (expectedFingerprint !== fingerprint) {
        return this.failedSelection('recommendation-stale', currentSnapshot)
      }
      const recommendedPolicy = recommendation.policy
      if (
        recommendedPolicy &&
        isHighRiskExecutionPolicy(recommendedPolicy) &&
        options.highRiskConfirmed !== true
      ) {
        return this.failedSelection('high-risk-confirmation-required', currentSnapshot)
      }
    }
    if (source === 'user' && global.state !== 'user') {
      return this.failedSelection('user-policy-unavailable', currentSnapshot)
    }

    const current = sourceState.kind === 'valid'
      ? sourceState.selections[workspace]
      : undefined
    const isNoOp = source === 'repository'
      ? current?.source === 'repository' && current.fingerprint === fingerprint
      : current?.source === source
    if (isNoOp) {
      if (currentSnapshot.status === 'active') {
        return { ok: true, changed: false, snapshot: currentSnapshot }
      }
      return this.failedSelection(
        currentSnapshot.status === 'stale' ? 'recommendation-stale' : 'source-state-corrupt',
        currentSnapshot,
      )
    }

    const selections = sourceState.kind === 'valid'
      ? { ...sourceState.selections }
      : {}
    if (source === 'repository') {
      if (typeof fingerprint !== 'string') {
        return this.failedSelection('recommendation-invalid', currentSnapshot)
      }
      selections[workspace] = { source, fingerprint }
    } else {
      selections[workspace] = { source }
    }

    try {
      this.assertSourceStateSize(selections, Number.MAX_SAFE_INTEGER)
    } catch (error) {
      if (error instanceof SourceStateTooLargeError) {
        return this.failedSelection('source-state-too-large', currentSnapshot)
      }
      throw error
    }

    const floor = Math.max(this.sourceRevisionFloor, sourceState.revision)
    let advanced
    try {
      advanced = isDefaultRecovery
        ? this.policyStore.advanceRevisionForSourceRecovery(floor)
        : this.policyStore.advanceRevision(floor)
    } catch (error) {
      if (error instanceof ExecutionPolicyManualRepairError) {
        return this.failedSelection('manual-repair-required', currentSnapshot)
      }
      throw new ExecutionPolicySourceCommitError()
    }

    try {
      this.writeSourceState({ schemaVersion: 1, revision: advanced.revision, selections })
    } catch {
      throw new ExecutionPolicySourceCommitError()
    }

    return {
      ok: true,
      changed: true,
      snapshot: this.getEffectivePolicy(workspace),
    }
  }

  resetSourceState(): ResetSourceStateResult {
    const currentState = this.readSourceState()
    if (currentState.kind === 'missing') {
      return { ok: true, changed: false, snapshot: null }
    }
    if (currentState.kind === 'unavailable') {
      return {
        ok: false,
        error: sourceError('source-state-unavailable'),
        snapshot: null,
      }
    }
    if (currentState.kind === 'corrupt' &&
      (!currentState.highWaterTrusted || currentState.reason === 'unsafe')) {
      return {
        ok: false,
        error: sourceError('source-state-corrupt'),
        snapshot: null,
      }
    }
    if (currentState.kind === 'valid' && Object.keys(currentState.selections).length === 0) {
      return { ok: true, changed: false, snapshot: null }
    }

    const global = this.policyStore.getEffectivePolicy()
    if (global.state === 'corrupt') {
      return {
        ok: false,
        error: sourceError('recovery-blocked-by-global-policy'),
        snapshot: null,
      }
    }

    const selections: Record<string, PersistedSourceSelection> = {}
    try {
      this.assertSourceStateSize(selections, Number.MAX_SAFE_INTEGER)
    } catch (error) {
      if (error instanceof SourceStateTooLargeError) {
        return {
          ok: false,
          error: sourceError('source-state-too-large'),
          snapshot: null,
        }
      }
      throw error
    }

    const floor = Math.max(this.sourceRevisionFloor, currentState.revision)
    let advanced
    try {
      advanced = this.policyStore.advanceRevision(floor)
    } catch {
      throw new ExecutionPolicySourceCommitError()
    }

    try {
      this.writeSourceState({ schemaVersion: 1, revision: advanced.revision, selections })
    } catch {
      throw new ExecutionPolicySourceCommitError()
    }

    return { ok: true, changed: true, snapshot: null }
  }

  private selectableFingerprint(recommendation: RepositoryPolicyRecommendation): string | null {
    if (recommendation.state !== 'valid' || recommendation.fingerprint === null) return null
    return recommendation.fingerprint
  }

  private recommendationError(
    recommendation: RepositoryPolicyRecommendation,
  ): ExecutionPolicySourceErrorCode {
    if (recommendation.state === 'invalid') return 'recommendation-invalid'
    if (recommendation.state === 'stale') return 'recommendation-stale'
    return 'recommendation-unavailable'
  }

  private failedSelection(
    code: ExecutionPolicySourceErrorCode,
    snapshot: ExecutionPolicySourceSnapshot,
  ): SelectSourceResult {
    return { ok: false, error: sourceError(code), snapshot }
  }

  private makeSnapshot(input: {
    policy: ExecutionPolicy
    revision: number
    selectedSource: ExecutionPolicySource | null
    activeSource: ExecutionPolicySource | null
    status: ExecutionPolicySourceSnapshotStatus
    recommendation: RepositoryPolicyRecommendation
    acceptedFingerprint: string | null
  }): ExecutionPolicySourceSnapshot {
    const policy = cloneExecutionPolicy(input.policy)
    const recommendation = {
      ...input.recommendation,
      policy: input.recommendation.policy === null
        ? null
        : cloneExecutionPolicy(input.recommendation.policy),
    }
    const effectivePolicyHash = policyHash(policy)
    return {
      policy,
      revision: input.revision,
      selectedSource: input.selectedSource,
      activeSource: input.activeSource,
      status: input.status,
      recommendation,
      effectivePolicyKey: effectiveKey({
        revision: input.revision,
        selectedSource: input.selectedSource,
        activeSource: input.activeSource,
        status: input.status,
        acceptedFingerprint: input.acceptedFingerprint,
        recommendation,
        effectivePolicyHash,
      }),
      effectivePolicyHash,
    }
  }

  private assertSourceStateSize(
    selections: Record<string, PersistedSourceSelection>,
    revision: number,
  ): void {
    const orderedSelections = Object.fromEntries(
      Object.entries(selections).sort(([left], [right]) => compareStableStrings(left, right)),
    )
    const serialized = `${JSON.stringify({
      schemaVersion: 1,
      revision,
      selections: orderedSelections,
    } satisfies PersistedSourceState)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SOURCE_STATE_BYTES) {
      throw new SourceStateTooLargeError('execution policy source state is too large')
    }
  }

  private readSourceState(): SourceStateRead {
    const directoryStatus = this.persistence.ensureDirectory(false)
    if (directoryStatus === 'missing') {
      return this.sourceRevisionFloor === 0
        ? { kind: 'missing', revision: 0, unsafePaths: [] }
        : {
            kind: 'corrupt',
            revision: this.sourceRevisionFloor,
            highWaterTrusted: false,
            reason: 'invalid',
            unsafePaths: [],
          }
    }
    if (directoryStatus === 'unsafe') {
      return {
        kind: 'corrupt',
        revision: this.sourceRevisionFloor,
        highWaterTrusted: false,
        reason: 'unsafe',
        unsafePaths: [this.sourceDirectory],
      }
    }
    if (directoryStatus === 'unavailable') {
      return {
        kind: 'unavailable',
        revision: this.sourceRevisionFloor,
        highWaterTrusted: false,
        unsafePaths: [],
      }
    }

    const revisionResult = this.readJsonFile(this.sourceRevisionFile, 'execution policy source revision JSON')
    if (revisionResult.kind === 'corrupt') {
      return {
        kind: 'corrupt',
        revision: this.sourceRevisionFloor,
        highWaterTrusted: false,
        reason: revisionResult.reason,
        unsafePaths: revisionResult.reason === 'unsafe' ? [this.sourceRevisionFile] : [],
      }
    }
    if (revisionResult.kind === 'too-large') {
      return {
        kind: 'corrupt',
        revision: this.sourceRevisionFloor,
        highWaterTrusted: false,
        reason: 'too-large',
        unsafePaths: [],
      }
    }
    if (revisionResult.kind === 'unavailable') {
      return {
        kind: 'unavailable',
        revision: this.sourceRevisionFloor,
        highWaterTrusted: false,
        unsafePaths: [],
      }
    }
    if (revisionResult.kind === 'missing') {
      const sourceResult = this.readJsonFile(this.sourceFile, 'execution policy source state JSON')
      if (sourceResult.kind === 'missing' && this.sourceRevisionFloor === 0) {
        return { kind: 'missing', revision: 0, unsafePaths: [] }
      }
      if (sourceResult.kind === 'unavailable') {
        return {
          kind: 'unavailable',
          revision: this.sourceRevisionFloor,
          highWaterTrusted: false,
          unsafePaths: [],
        }
      }
      return {
        kind: 'corrupt',
        revision: this.sourceRevisionFloor,
        highWaterTrusted: false,
        reason: sourceResult.kind === 'too-large'
          ? 'too-large'
          : sourceResult.kind === 'corrupt'
            ? sourceResult.reason
            : 'invalid',
        unsafePaths: sourceResult.kind === 'corrupt' && sourceResult.reason === 'unsafe'
          ? [this.sourceFile]
          : [],
      }
    }

    let revision: PersistedSourceRevision
    try {
      revision = parsePersistedSourceRevision(revisionResult.value)
    } catch {
      return {
        kind: 'corrupt',
        revision: this.sourceRevisionFloor,
        highWaterTrusted: false,
        reason: 'invalid',
        unsafePaths: [],
      }
    }
    const previousFloor = this.sourceRevisionFloor
    this.sourceRevisionFloor = Math.max(this.sourceRevisionFloor, revision.highWater)

    const sourceResult = this.readJsonFile(this.sourceFile, 'execution policy source state JSON')
    if (sourceResult.kind === 'unavailable') {
      return {
        kind: 'unavailable',
        revision: this.sourceRevisionFloor,
        highWaterTrusted: true,
        unsafePaths: [],
      }
    }
    if (sourceResult.kind !== 'present') {
      return {
        kind: 'corrupt',
        revision: this.sourceRevisionFloor,
        highWaterTrusted: true,
        reason: sourceResult.kind === 'too-large'
          ? 'too-large'
          : sourceResult.kind === 'corrupt'
            ? sourceResult.reason
            : 'invalid',
        unsafePaths: sourceResult.kind === 'corrupt' && sourceResult.reason === 'unsafe'
          ? [this.sourceFile]
          : [],
      }
    }

    try {
      const state = parsePersistedSourceState(sourceResult.value)
      if (previousFloor > revision.highWater || state.revision !== revision.highWater) {
        return {
          kind: 'corrupt',
          revision: this.sourceRevisionFloor,
          highWaterTrusted: true,
          reason: 'invalid',
          unsafePaths: [],
        }
      }
      return {
        kind: 'valid',
        revision: state.revision,
        selections: state.selections,
        highWaterTrusted: true,
        unsafePaths: [],
      }
    } catch {
      return {
        kind: 'corrupt',
        revision: this.sourceRevisionFloor,
        highWaterTrusted: true,
        reason: 'invalid',
        unsafePaths: [],
      }
    }
  }

  private writeSourceState(state: PersistedSourceState): void {
    const revision = Math.max(this.sourceRevisionFloor, state.revision)
    const selections = Object.fromEntries(
      Object.entries(state.selections).sort(([left], [right]) => compareStableStrings(left, right))
    )
    this.assertSourceStateSize(selections, revision)
    this.persistence.write(this.sourceRevisionFile, {
      schemaVersion: 1,
      highWater: revision,
    } satisfies PersistedSourceRevision)
    this.persistence.write(this.sourceFile, {
      schemaVersion: 1,
      revision,
      selections,
    } satisfies PersistedSourceState)
    this.sourceRevisionFloor = revision
  }

  private readJsonFile(file: string, label: string): JsonReadResult {
    const result = this.persistence.read(file, label)
    if (result.kind === 'missing') return { kind: 'missing' }
    if (result.kind === 'present') return { kind: 'present', value: result.value }
    if (result.kind === 'too-large') return { kind: 'too-large' }
    if (result.kind === 'unavailable') return { kind: 'unavailable' }
    return { kind: 'corrupt', reason: result.reason }
  }

  private readRepositoryRecommendation(workspace: string): RepositoryPolicyRecommendation {
    const directory = join(workspace, REPOSITORY_POLICY_DIRECTORY)
    let directoryEntry
    try {
      directoryEntry = lstatSync(directory)
    } catch (error) {
      if (isMissingError(error)) return missingRecommendation()
      return isUnavailableError(error) ? unavailableRecommendation() : invalidRecommendation()
    }
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
      return invalidRecommendation()
    }

    const file = join(directory, REPOSITORY_POLICY_FILE)
    let fileEntry
    try {
      fileEntry = lstatSync(file)
    } catch (error) {
      if (isMissingError(error)) return missingRecommendation()
      return isUnavailableError(error) ? unavailableRecommendation() : invalidRecommendation()
    }
    if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) return invalidRecommendation()

    const canonicalFile = resolveWorkspaceRelativePath(workspace, REPOSITORY_EXECUTION_POLICY_PATH)
    if (!canonicalFile) return invalidRecommendation()

    const result = this.readRepositoryFile(file, canonicalFile)
    if (result.kind === 'missing') return missingRecommendation()
    if (result.kind === 'unavailable') return unavailableRecommendation()
    if (result.kind === 'invalid') return invalidRecommendation()

    try {
      const policy = parseExecutionPolicyJson(result.value)
      return {
        state: 'valid',
        policy: cloneExecutionPolicy(policy),
        fingerprint: canonicalPolicyFingerprint(policy),
      }
    } catch {
      return invalidRecommendation()
    }
  }

  private readRepositoryFile(file: string, canonicalFile: string): FileReadResult {
    let fileEntry
    try {
      fileEntry = lstatSync(file)
    } catch (error) {
      if (isMissingError(error)) return { kind: 'missing' }
      return isUnavailableError(error) ? { kind: 'unavailable' } : { kind: 'invalid' }
    }
    if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) return { kind: 'invalid' }

    let fd: number | undefined
    let result: FileReadResult = { kind: 'invalid' }
    try {
      fd = openSync(canonicalFile, constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW_FLAG)
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.isSymbolicLink() || !sameFileSnapshot(fileEntry, opened)) {
        throw new Error('repository execution policy changed while opening')
      }
      const value = readBoundedUtf8(fd, opened.size, MAX_REPOSITORY_POLICY_BYTES)
      const closed = fstatSync(fd)
      if (!sameFileSnapshot(opened, closed)) {
        throw new Error('repository execution policy changed while reading')
      }
      result = { kind: 'text', value }
    } catch (error) {
      result = isUnavailableError(error) ? { kind: 'unavailable' } : { kind: 'invalid' }
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          result = { kind: 'unavailable' }
        }
      }
    }
    return result
  }
}
