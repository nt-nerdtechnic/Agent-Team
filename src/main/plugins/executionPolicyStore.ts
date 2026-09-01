import { join } from 'node:path'
import {
  parseExecutionPolicy,
  type ExecutionPolicy,
} from '../../../packages/plugin-contracts/src/index'
import {
  cloneExecutionPolicy,
  FAIL_CLOSED_EXECUTION_POLICY,
  HOST_DEFAULT_EXECUTION_POLICY,
  type ExecutionPolicySnapshot,
} from './executionPolicy'
import { OwnerOnlyJsonPersistence } from './ownerOnlyJsonPersistence'

export const EXECUTION_POLICY_DIRECTORY = 'execution-policy'
export const EXECUTION_POLICY_FILE = 'policy.json'
export const EXECUTION_POLICY_REVISION_FILE = 'revision.json'
const MAX_EXECUTION_POLICY_STATE_BYTES = 256 * 1024

type PersistedExecutionPolicyState = {
  schemaVersion: 1
  revision: number
  userPolicy: ExecutionPolicy | null
}

type PersistedRevisionState = {
  schemaVersion: 1
  highWater: number
}

type RevisionFileState = 'missing' | 'valid' | 'corrupt' | 'unsafe'

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

export interface ExecutionPolicyStoreSettingsState {
  defaultPolicy: ExecutionPolicy
  userPolicy: ExecutionPolicy | null
  global: ExecutionPolicySnapshot
  recovery: ExecutionPolicyRecoveryStatus
}

type ReadState =
  | { kind: 'missing'; revision: number; revisionFile: 'missing' }
  | {
      kind: 'valid'
      revision: number
      userPolicy: ExecutionPolicy | null
      revisionFile: 'valid'
    }
  | {
      kind: 'corrupt'
      revision: number
      revisionFile: RevisionFileState
      unsafePaths: string[]
    }
  | {
      kind: 'unavailable'
      revision: number
      revisionFile: 'unavailable'
      directoryStatus: 'unsafe' | 'unavailable'
      unsafePaths: string[]
    }

type ReadFileResult =
  | { kind: 'missing' }
  | { kind: 'present'; value: unknown }
  | { kind: 'corrupt'; reason: 'invalid' | 'unsafe' }
  | { kind: 'too-large' }
  | { kind: 'unavailable' }

type RevisionReadResult =
  | { kind: 'missing' }
  | { kind: 'valid'; revision: PersistedRevisionState }
  | { kind: 'corrupt'; reason: 'invalid' | 'unsafe' }
  | { kind: 'unavailable' }

export class ExecutionPolicyRevisionConflictError extends Error {
  constructor() {
    super('execution policy revision changed while it was being edited')
    this.name = 'ExecutionPolicyRevisionConflictError'
  }
}

export class ExecutionPolicyManualRepairError extends Error {
  constructor() {
    super('execution policy state contains an unsafe filesystem entry and requires manual repair')
    this.name = 'ExecutionPolicyManualRepairError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePersistedState(value: unknown): PersistedExecutionPolicyState {
  if (!isRecord(value)) throw new Error('execution policy state must be an object')
  if (Object.keys(value).some((key) => !['schemaVersion', 'revision', 'userPolicy'].includes(key))) {
    throw new Error('execution policy state has an unknown field')
  }
  if (value.schemaVersion !== 1) throw new Error('execution policy state has an unknown schema version')
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error('execution policy state revision must be a non-negative integer')
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'userPolicy')) {
    throw new Error('execution policy state is missing userPolicy')
  }
  const userPolicy = value.userPolicy === null ? null : parseExecutionPolicy(value.userPolicy)
  return {
    schemaVersion: 1,
    revision: value.revision as number,
    userPolicy,
  }
}

function parsePersistedRevision(value: unknown): PersistedRevisionState {
  if (!isRecord(value)) throw new Error('execution policy revision must be an object')
  if (Object.keys(value).some((key) => !['schemaVersion', 'highWater'].includes(key))) {
    throw new Error('execution policy revision has an unknown field')
  }
  if (value.schemaVersion !== 1) throw new Error('execution policy revision has an unknown schema version')
  if (!Object.prototype.hasOwnProperty.call(value, 'highWater')) {
    throw new Error('execution policy revision is missing highWater')
  }
  if (!Number.isSafeInteger(value.highWater) || (value.highWater as number) < 0) {
    throw new Error('execution policy revision highWater must be a non-negative integer')
  }
  return {
    schemaVersion: 1,
    highWater: value.highWater as number,
  }
}

export class ExecutionPolicyStore {
  private readonly directory: string
  private readonly file: string
  private readonly revisionFile: string
  private readonly persistence: OwnerOnlyJsonPersistence
  private revisionFloor = 0

  constructor(userData: string) {
    this.directory = join(userData, EXECUTION_POLICY_DIRECTORY)
    this.file = join(this.directory, EXECUTION_POLICY_FILE)
    this.revisionFile = join(this.directory, EXECUTION_POLICY_REVISION_FILE)
    this.persistence = new OwnerOnlyJsonPersistence(this.directory, MAX_EXECUTION_POLICY_STATE_BYTES)
  }

  getDefaultPolicy(): ExecutionPolicy {
    return cloneExecutionPolicy(HOST_DEFAULT_EXECUTION_POLICY)
  }

  getUserPolicy(): ExecutionPolicy | null {
    const state = this.readState()
    if (state.kind !== 'valid' || state.userPolicy === null) return null
    return cloneExecutionPolicy(state.userPolicy)
  }

  getRecoveryStatus(): ExecutionPolicyRecoveryStatus {
    return this.recoveryStatusForState(this.readState())
  }

  getSettingsState(): ExecutionPolicyStoreSettingsState {
    const state = this.readState()
    return {
      defaultPolicy: this.getDefaultPolicy(),
      userPolicy: state.kind === 'valid' && state.userPolicy !== null
        ? cloneExecutionPolicy(state.userPolicy)
        : null,
      global: this.effectivePolicyForState(state),
      recovery: this.recoveryStatusForState(state),
    }
  }

  getEffectivePolicy(): ExecutionPolicySnapshot {
    return this.effectivePolicyForState(this.readState())
  }

  private recoveryStatusForState(state: ReadState): ExecutionPolicyRecoveryStatus {
    if (state.kind === 'unavailable') {
      return state.directoryStatus === 'unsafe'
        ? { state: 'directory-unsafe', canRebuild: false, unsafePaths: state.unsafePaths }
        : { state: 'directory-unavailable', canRebuild: false, unsafePaths: state.unsafePaths }
    }
    if (state.kind === 'corrupt') {
      return state.unsafePaths.length > 0 || state.revisionFile === 'unsafe'
        ? { state: 'unsafe-entry', canRebuild: false, unsafePaths: state.unsafePaths }
        : { state: 'corrupt', canRebuild: true, unsafePaths: [] }
    }
    if (state.kind === 'missing') return { state: 'missing', canRebuild: false, unsafePaths: [] }
    return { state: 'healthy', canRebuild: false, unsafePaths: [] }
  }

  private effectivePolicyForState(state: ReadState): ExecutionPolicySnapshot {
    if (state.kind === 'corrupt' || state.kind === 'unavailable') {
      return {
        policy: cloneExecutionPolicy(FAIL_CLOSED_EXECUTION_POLICY),
        revision: state.revision,
        state: 'corrupt',
      }
    }
    if (state.kind === 'missing') {
      return {
        policy: this.getDefaultPolicy(),
        revision: state.revision,
        state: 'default',
      }
    }
    if (state.userPolicy === null) {
      return {
        policy: this.getDefaultPolicy(),
        revision: state.revision,
        state: 'default',
      }
    }
    return {
      policy: cloneExecutionPolicy(state.userPolicy),
      revision: state.revision,
      state: 'user',
    }
  }

  setUserPolicy(raw: unknown, expectedRevision?: number): ExecutionPolicySnapshot {
    const policy = parseExecutionPolicy(raw)
    const current = this.readState()
    this.assertExpectedRevision(current, expectedRevision)
    this.assertRevisionWritable(current)
    const revision = nextRevision(Math.max(this.revisionFloor, current.revision))
    this.writeState({ schemaVersion: 1, revision, userPolicy: policy })
    this.revisionFloor = revision
    return {
      policy: cloneExecutionPolicy(policy),
      revision,
      state: 'user',
    }
  }

  resetUserPolicy(expectedRevision?: number): ExecutionPolicySnapshot {
    const current = this.readState()
    this.assertExpectedRevision(current, expectedRevision)
    if (current.kind === 'missing' ||
      (current.kind === 'valid' && current.userPolicy === null)) {
      return {
        policy: this.getDefaultPolicy(),
        revision: current.revision,
        state: 'default',
      }
    }
    this.assertRevisionWritable(current)
    const revision = nextRevision(Math.max(this.revisionFloor, current.revision))
    this.writeState({ schemaVersion: 1, revision, userPolicy: null })
    this.revisionFloor = revision
    return {
      policy: this.getDefaultPolicy(),
      revision,
      state: 'default',
    }
  }

  /** Advance only the trusted revision sidecar while preserving corrupt policy data. */
  advanceRevisionForSourceRecovery(minimumRevision = 0): ExecutionPolicySnapshot {
    const current = this.readState()
    if (current.kind !== 'corrupt' || current.revisionFile !== 'valid') {
      throw new ExecutionPolicyManualRepairError()
    }

    const revision = nextRevision(Math.max(this.revisionFloor, current.revision, minimumRevision))
    this.persistence.write(this.revisionFile, {
      schemaVersion: 1,
      highWater: revision,
    } satisfies PersistedRevisionState)
    this.revisionFloor = revision
    return {
      policy: cloneExecutionPolicy(FAIL_CLOSED_EXECUTION_POLICY),
      revision,
      state: 'corrupt',
    }
  }

  /** Recreate a corrupt durable pair as a fresh Host-default user state. */
  rebuild(minimumRevision = 0): ExecutionPolicySnapshot {
    const directoryStatus = this.persistence.ensureDirectory(false)
    if (directoryStatus === 'unsafe') throw new Error('execution policy directory is unsafe')
    if (directoryStatus === 'unavailable') throw new Error('execution policy directory is unavailable')
    if (directoryStatus === 'missing') {
      throw new Error('execution policy rebuild requires a corrupt durable state')
    }

    const current = this.readState()
    if (current.kind !== 'corrupt') {
      throw new Error('execution policy rebuild requires a corrupt durable state')
    }
    if (current.unsafePaths.length > 0 || current.revisionFile === 'unsafe') {
      throw new ExecutionPolicyManualRepairError()
    }

    const revision = nextRevision(Math.max(this.revisionFloor, current.revision, minimumRevision))
    const state: PersistedExecutionPolicyState = {
      schemaVersion: 1,
      revision,
      userPolicy: null,
    }

    // Retire the policy first. If the second write cannot complete, the
    // remaining revision/policy mismatch still fails closed on every read.
    this.persistence.removeIfPresent(this.file)
    this.persistence.write(this.file, state)
    this.persistence.removeIfPresent(this.revisionFile)
    this.persistence.write(this.revisionFile, {
      schemaVersion: 1,
      highWater: revision,
    } satisfies PersistedRevisionState)
    this.revisionFloor = revision
    return {
      policy: this.getDefaultPolicy(),
      revision,
      state: 'default',
    }
  }

  /** Advance the durable policy revision while preserving the user setting. */
  advanceRevision(minimumRevision = 0): ExecutionPolicySnapshot {
    const current = this.readState()
    if (current.kind !== 'missing' && current.kind !== 'valid') {
      throw new Error('execution policy state is corrupt or unavailable')
    }

    const revision = nextRevision(Math.max(this.revisionFloor, current.revision, minimumRevision))
    const userPolicy = current.kind === 'valid' ? current.userPolicy : null
    this.writeState({ schemaVersion: 1, revision, userPolicy })
    this.revisionFloor = revision

    return userPolicy === null
      ? {
        policy: this.getDefaultPolicy(),
        revision,
        state: 'default',
      }
      : {
        policy: cloneExecutionPolicy(userPolicy),
        revision,
        state: 'user',
      }
  }

  private assertRevisionWritable(state: ReadState): void {
    if (state.revisionFile !== 'valid' && state.revisionFile !== 'missing') {
      throw new Error('execution policy revision sidecar is corrupt or unsafe')
    }
  }

  private assertExpectedRevision(state: ReadState, expectedRevision?: number): void {
    if (expectedRevision !== undefined && expectedRevision !== state.revision) {
      throw new ExecutionPolicyRevisionConflictError()
    }
  }

  private readState(): ReadState {
    const directoryStatus = this.persistence.ensureDirectory(false)
    if (directoryStatus !== 'ready') {
      return directoryStatus === 'missing'
        ? this.missingState()
        : this.unavailableState(directoryStatus)
    }

    const revisionResult = this.readRevision()
    if (revisionResult.kind === 'unavailable') return this.unavailableState('unavailable')
    if (revisionResult.kind === 'corrupt') {
      return this.corruptState(
        revisionResult.reason === 'unsafe' ? 'unsafe' : 'corrupt',
        revisionResult.reason === 'unsafe' ? [this.revisionFile] : [],
        revisionResult.reason === 'unsafe' ? 'unsafe' : 'corrupt',
      )
    }

    if (revisionResult.kind === 'missing') {
      return this.readLegacyPolicyWithoutRevision()
    }

    const previousFloor = this.revisionFloor
    this.revisionFloor = Math.max(this.revisionFloor, revisionResult.revision.highWater)

    const policyResult = this.readJsonFile(this.file, 'execution policy state JSON')
    if (policyResult.kind === 'unavailable') return this.unavailableState('unavailable')
    if (policyResult.kind !== 'present') {
      return this.corruptState(
        policyResult.kind === 'corrupt' && policyResult.reason === 'unsafe' ? 'unsafe' : 'corrupt',
        policyResult.kind === 'corrupt' && policyResult.reason === 'unsafe' ? [this.file] : [],
      )
    }

    try {
      const policy = parsePersistedState(policyResult.value)
      if (previousFloor > revisionResult.revision.highWater ||
        policy.revision !== revisionResult.revision.highWater) {
        return this.corruptState('corrupt')
      }
      return {
        kind: 'valid',
        revision: policy.revision,
        userPolicy: policy.userPolicy,
        revisionFile: 'valid',
      }
    } catch {
      return this.corruptState('corrupt')
    }
  }

  // getEffectivePolicy's only read-path migration seam is a missing sidecar:
  // a strict-valid legacy policy may create it once, without changing revision.
  private readLegacyPolicyWithoutRevision(): ReadState {
    const policyResult = this.readJsonFile(this.file, 'execution policy state JSON')
    if (policyResult.kind === 'unavailable') return this.unavailableState('unavailable')
    if (policyResult.kind === 'corrupt') {
      return this.corruptState(
        policyResult.reason === 'unsafe' ? 'unsafe' : 'corrupt',
        policyResult.reason === 'unsafe' ? [this.file] : [],
        'missing',
      )
    }
    if (policyResult.kind === 'too-large') return this.corruptState('corrupt', [], 'missing')
    if (policyResult.kind === 'missing') return this.missingState()

    let policy: PersistedExecutionPolicyState
    try {
      policy = parsePersistedState(policyResult.value)
    } catch {
      return this.corruptState('corrupt', [], 'missing')
    }
    if (policy.revision < this.revisionFloor) return this.corruptState('corrupt', [], 'missing')

    let bootstrapResult: 'created' | 'exists'
    try {
      bootstrapResult = this.persistence.createIfMissing(this.revisionFile, {
        schemaVersion: 1,
        highWater: policy.revision,
      } satisfies PersistedRevisionState)
    } catch {
      return this.corruptState('corrupt', [], 'missing')
    }

    if (bootstrapResult === 'exists') {
      const revisionResult = this.readRevision()
      if (revisionResult.kind === 'unavailable') return this.unavailableState('unavailable')
      if (revisionResult.kind === 'corrupt') {
        return this.corruptState(
          revisionResult.reason === 'unsafe' ? 'unsafe' : 'corrupt',
          revisionResult.reason === 'unsafe' ? [this.revisionFile] : [],
          revisionResult.reason === 'unsafe' ? 'unsafe' : 'corrupt',
        )
      }
      if (revisionResult.kind === 'missing') return this.corruptState('corrupt', [], 'missing')

      const previousFloor = this.revisionFloor
      this.revisionFloor = Math.max(this.revisionFloor, revisionResult.revision.highWater)
      if (previousFloor > revisionResult.revision.highWater ||
        revisionResult.revision.highWater !== policy.revision) {
        return this.corruptState('corrupt')
      }
    }

    this.revisionFloor = Math.max(this.revisionFloor, policy.revision)
    return {
      kind: 'valid',
      revision: policy.revision,
      userPolicy: policy.userPolicy,
      revisionFile: 'valid',
    }
  }

  private readRevision(): RevisionReadResult {
    const result = this.readJsonFile(this.revisionFile, 'execution policy revision JSON')
    if (result.kind === 'missing') return result
    if (result.kind === 'unavailable') return result
    if (result.kind === 'too-large') return { kind: 'corrupt', reason: 'invalid' }
    if (result.kind === 'corrupt') return { kind: 'corrupt', reason: result.reason }
    try {
      return { kind: 'valid', revision: parsePersistedRevision(result.value) }
    } catch {
      return { kind: 'corrupt', reason: 'invalid' }
    }
  }

  private readJsonFile(file: string, label: string): ReadFileResult {
    const result = this.persistence.read(file, label)
    return result.kind === 'missing'
      ? { kind: 'missing' }
      : result.kind === 'present'
        ? { kind: 'present', value: result.value }
        : result.kind === 'too-large'
          ? { kind: 'too-large' }
          : result.kind === 'unavailable'
            ? { kind: 'unavailable' }
            : { kind: 'corrupt', reason: result.reason }
  }

  private missingState(): ReadState {
    return this.revisionFloor === 0
      ? { kind: 'missing', revision: 0, revisionFile: 'missing' }
      : { kind: 'corrupt', revision: this.revisionFloor, revisionFile: 'missing', unsafePaths: [] }
  }

  private corruptState(
    reason: 'corrupt' | 'unsafe',
    unsafePaths: string[] = [],
    revisionFile: RevisionFileState = reason === 'unsafe' ? 'unsafe' : 'valid',
  ): ReadState {
    return {
      kind: 'corrupt',
      revision: this.revisionFloor,
      revisionFile: reason === 'unsafe' ? 'unsafe' : revisionFile,
      unsafePaths,
    }
  }

  private unavailableState(directoryStatus: 'unsafe' | 'unavailable'): ReadState {
    return {
      kind: 'unavailable',
      revision: this.revisionFloor,
      revisionFile: 'unavailable',
      directoryStatus,
      unsafePaths: directoryStatus === 'unsafe' ? [this.directory] : [],
    }
  }

  private writeState(state: PersistedExecutionPolicyState): void {
    this.persistence.write(this.revisionFile, {
      schemaVersion: 1,
      highWater: state.revision,
    } satisfies PersistedRevisionState)
    this.persistence.write(this.file, state)
  }
}

function nextRevision(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error('execution policy revision is exhausted')
  return current + 1
}

export {
  FAIL_CLOSED_EXECUTION_POLICY,
  HOST_DEFAULT_EXECUTION_POLICY,
  type ExecutionPolicySnapshot,
} from './executionPolicy'
