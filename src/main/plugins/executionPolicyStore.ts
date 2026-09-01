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

type RevisionFileState = 'missing' | 'valid' | 'corrupt'

type ReadState =
  | { kind: 'missing'; revision: number; revisionFile: 'missing' }
  | {
      kind: 'valid'
      revision: number
      userPolicy: ExecutionPolicy | null
      revisionFile: 'valid'
    }
  | { kind: 'corrupt'; revision: number; revisionFile: RevisionFileState }
  | { kind: 'unavailable'; revision: number; revisionFile: 'unavailable' }

type ReadFileResult =
  | { kind: 'missing' }
  | { kind: 'present'; value: unknown }
  | { kind: 'corrupt' }

type RevisionReadResult =
  | { kind: 'missing' }
  | { kind: 'valid'; revision: PersistedRevisionState }
  | { kind: 'corrupt' }

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
  private readonly file: string
  private readonly revisionFile: string
  private readonly persistence: OwnerOnlyJsonPersistence
  private revisionFloor = 0

  constructor(userData: string) {
    const directory = join(userData, EXECUTION_POLICY_DIRECTORY)
    this.file = join(directory, EXECUTION_POLICY_FILE)
    this.revisionFile = join(directory, EXECUTION_POLICY_REVISION_FILE)
    this.persistence = new OwnerOnlyJsonPersistence(directory, MAX_EXECUTION_POLICY_STATE_BYTES)
  }

  getDefaultPolicy(): ExecutionPolicy {
    return cloneExecutionPolicy(HOST_DEFAULT_EXECUTION_POLICY)
  }

  getUserPolicy(): ExecutionPolicy | null {
    const state = this.readState()
    if (state.kind !== 'valid' || state.userPolicy === null) return null
    return cloneExecutionPolicy(state.userPolicy)
  }

  getEffectivePolicy(): ExecutionPolicySnapshot {
    const state = this.readState()
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

  setUserPolicy(raw: unknown): ExecutionPolicySnapshot {
    const policy = parseExecutionPolicy(raw)
    const current = this.readState()
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

  resetUserPolicy(): ExecutionPolicySnapshot {
    const current = this.readState()
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
    if (state.revisionFile === 'corrupt') {
      throw new Error('execution policy revision sidecar is corrupt or unsafe')
    }
  }

  private readState(): ReadState {
    const directoryStatus = this.persistence.ensureDirectory(false)
    if (directoryStatus !== 'ready') {
      return directoryStatus === 'missing' ? this.missingState() : this.unavailableState()
    }

    const revisionResult = this.readRevision()
    if (revisionResult.kind === 'corrupt') return this.corruptState('corrupt')

    if (revisionResult.kind === 'missing') {
      return this.readLegacyPolicyWithoutRevision()
    }

    const previousFloor = this.revisionFloor
    this.revisionFloor = Math.max(this.revisionFloor, revisionResult.revision.highWater)

    const policyResult = this.readJsonFile(this.file, 'execution policy state JSON')
    if (policyResult.kind !== 'present') return this.corruptState('valid')

    try {
      const policy = parsePersistedState(policyResult.value)
      if (previousFloor > revisionResult.revision.highWater ||
        policy.revision !== revisionResult.revision.highWater) {
        return this.corruptState('valid')
      }
      return {
        kind: 'valid',
        revision: policy.revision,
        userPolicy: policy.userPolicy,
        revisionFile: 'valid',
      }
    } catch {
      return this.corruptState('valid')
    }
  }

  // getEffectivePolicy's only read-path migration seam is a missing sidecar:
  // a strict-valid legacy policy may create it once, without changing revision.
  private readLegacyPolicyWithoutRevision(): ReadState {
    const policyResult = this.readJsonFile(this.file, 'execution policy state JSON')
    if (policyResult.kind === 'corrupt') return this.corruptState('missing')
    if (policyResult.kind === 'missing') return this.missingState()

    let policy: PersistedExecutionPolicyState
    try {
      policy = parsePersistedState(policyResult.value)
    } catch {
      return this.corruptState('missing')
    }
    if (policy.revision < this.revisionFloor) return this.corruptState('missing')

    let bootstrapResult: 'created' | 'exists'
    try {
      bootstrapResult = this.persistence.createIfMissing(this.revisionFile, {
        schemaVersion: 1,
        highWater: policy.revision,
      } satisfies PersistedRevisionState)
    } catch {
      return this.corruptState('missing')
    }

    if (bootstrapResult === 'exists') {
      const revisionResult = this.readRevision()
      if (revisionResult.kind === 'corrupt') return this.corruptState('corrupt')
      if (revisionResult.kind === 'missing') return this.corruptState('missing')

      const previousFloor = this.revisionFloor
      this.revisionFloor = Math.max(this.revisionFloor, revisionResult.revision.highWater)
      if (previousFloor > revisionResult.revision.highWater ||
        revisionResult.revision.highWater !== policy.revision) {
        return this.corruptState('valid')
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
    if (result.kind !== 'present') return result
    try {
      return { kind: 'valid', revision: parsePersistedRevision(result.value) }
    } catch {
      return { kind: 'corrupt' }
    }
  }

  private readJsonFile(file: string, label: string): ReadFileResult {
    const result = this.persistence.read(file, label)
    return result.kind === 'missing'
      ? { kind: 'missing' }
      : result.kind === 'present'
        ? { kind: 'present', value: result.value }
        : { kind: 'corrupt' }
  }

  private missingState(): ReadState {
    return this.revisionFloor === 0
      ? { kind: 'missing', revision: 0, revisionFile: 'missing' }
      : { kind: 'corrupt', revision: this.revisionFloor, revisionFile: 'missing' }
  }

  private corruptState(revisionFile: RevisionFileState): ReadState {
    return {
      kind: 'corrupt',
      revision: this.revisionFloor,
      revisionFile,
    }
  }

  private unavailableState(): ReadState {
    return {
      kind: 'unavailable',
      revision: this.revisionFloor,
      revisionFile: 'unavailable',
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
