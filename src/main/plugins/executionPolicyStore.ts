import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  parseExecutionPolicy,
  parseStrictJson,
  type ExecutionPolicy,
} from '../../../packages/plugin-contracts/src/index'
import {
  cloneExecutionPolicy,
  FAIL_CLOSED_EXECUTION_POLICY,
  HOST_DEFAULT_EXECUTION_POLICY,
  type ExecutionPolicySnapshot,
} from './executionPolicy'

export const EXECUTION_POLICY_DIRECTORY = 'execution-policy'
export const EXECUTION_POLICY_FILE = 'policy.json'
export const EXECUTION_POLICY_REVISION_FILE = 'revision.json'
const MAX_EXECUTION_POLICY_STATE_BYTES = 256 * 1024
const NO_FOLLOW_FLAG = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW

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

function isMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function isOwnerOnly(mode: number): boolean {
  return process.platform === 'win32' || (mode & 0o077) === 0
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
  private revisionFloor = 0

  constructor(userData: string) {
    this.directory = join(userData, EXECUTION_POLICY_DIRECTORY)
    this.file = join(this.directory, EXECUTION_POLICY_FILE)
    this.revisionFile = join(this.directory, EXECUTION_POLICY_REVISION_FILE)
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

  private assertRevisionWritable(state: ReadState): void {
    if (state.revisionFile === 'corrupt') {
      throw new Error('execution policy revision sidecar is corrupt or unsafe')
    }
  }

  private readState(): ReadState {
    try {
      this.ensureDirectory(false)
    } catch (error) {
      return isMissingError(error) ? this.missingState() : this.unavailableState()
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
      bootstrapResult = this.createRevisionIfMissing(policy.revision)
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
    let fileEntry
    try {
      fileEntry = lstatSync(file)
    } catch (error) {
      if (isMissingError(error)) return { kind: 'missing' }
      return { kind: 'corrupt' }
    }
    if (!fileEntry.isFile() || fileEntry.isSymbolicLink() || !isOwnerOnly(fileEntry.mode)) {
      return { kind: 'corrupt' }
    }

    let fd: number | undefined
    let value: unknown
    let failed = false
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW_FLAG)
      const opened = fstatSync(fd)
      if (!opened.isFile() || !sameFileSnapshot(fileEntry, opened) || !isOwnerOnly(opened.mode)) {
        throw new Error('execution policy state file changed while opening')
      }
      const raw = readBoundedUtf8(fd, opened.size)
      const closed = fstatSync(fd)
      if (!sameFileSnapshot(opened, closed)) {
        throw new Error('execution policy state file changed while reading')
      }
      value = parseStrictJson(raw, label)
    } catch {
      failed = true
    }
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        failed = true
      } finally {
        fd = undefined
      }
    }
    return failed || value === undefined ? { kind: 'corrupt' } : { kind: 'present', value }
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
    this.writeJsonAtomic(this.revisionFile, {
      schemaVersion: 1,
      highWater: state.revision,
    } satisfies PersistedRevisionState)
    this.writeJsonAtomic(this.file, state)
  }

  private createRevisionIfMissing(highWater: number): 'created' | 'exists' {
    this.ensureDirectory()
    const temporary = `${this.revisionFile}.${randomUUID()}.tmp`
    try {
      this.writeTemporaryJson(temporary, {
        schemaVersion: 1,
        highWater,
      } satisfies PersistedRevisionState)
      try {
        linkSync(temporary, this.revisionFile)
      } catch (error) {
        if (isAlreadyExistsError(error)) return 'exists'
        throw error
      }
      this.syncDirectory()
      return 'created'
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    this.ensureDirectory()
    this.assertReplaceableFile(file)

    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      this.writeTemporaryJson(temporary, value)
      this.assertReplaceableFile(file)
      renameSync(temporary, file)
      chmodSync(file, 0o600)
      this.syncDirectory()
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  private writeTemporaryJson(file: string, value: unknown): void {
    writeFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(file, 0o600)
    const fd = openSync(file, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  private syncDirectory(): void {
    if (process.platform === 'win32') return
    const directory = openSync(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW_FLAG
    )
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  }

  private ensureDirectory(createIfMissing = true): void {
    let entry
    try {
      entry = lstatSync(this.directory)
    } catch (error) {
      if (!isMissingError(error)) throw error
      if (!createIfMissing) throw error
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      entry = lstatSync(this.directory)
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('execution policy directory is unsafe')
    }
    if ((entry.mode & 0o077) !== 0) chmodSync(this.directory, 0o700)
  }

  private assertReplaceableFile(file: string): void {
    try {
      const entry = lstatSync(file)
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('execution policy file is unsafe')
      }
    } catch (error) {
      if (!isMissingError(error)) throw error
    }
  }
}

function readBoundedUtf8(fd: number, initialSize: number): string {
  if (!Number.isSafeInteger(initialSize) || initialSize < 0 || initialSize > MAX_EXECUTION_POLICY_STATE_BYTES) {
    throw new Error('execution policy state file is too large')
  }

  const chunks: Buffer[] = []
  const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_EXECUTION_POLICY_STATE_BYTES + 1))
  let total = 0
  while (true) {
    const count = readSync(fd, buffer, 0, buffer.length, null)
    if (count === 0) break
    total += count
    if (total > MAX_EXECUTION_POLICY_STATE_BYTES) {
      throw new Error('execution policy state file is too large')
    }
    chunks.push(Buffer.from(buffer.subarray(0, count)))
  }
  return Buffer.concat(chunks, total).toString('utf8')
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
