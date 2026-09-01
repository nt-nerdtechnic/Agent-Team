import { randomUUID } from 'node:crypto'
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
import { parseStrictJson } from '../../../packages/plugin-contracts/src/index'

const NO_FOLLOW_FLAG = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW

export type OwnerOnlyDirectoryStatus = 'ready' | 'missing' | 'unsafe' | 'unavailable'

export type OwnerOnlyJsonReadResult =
  | { kind: 'missing' }
  | { kind: 'present'; value: unknown }
  | { kind: 'corrupt'; reason: 'invalid' | 'unsafe' }
  | { kind: 'too-large' }
  | { kind: 'unavailable' }

type FileSnapshot = {
  dev: number
  ino: number
  mode: number
  size: number
}

class BoundedFileTooLargeError extends Error {}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function isMissingError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === 'EEXIST'
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

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.size === right.size
}

function isOwnerOnly(mode: number): boolean {
  return process.platform === 'win32' || (mode & 0o077) === 0
}

function readBoundedUtf8(fd: number, initialSize: number, maximumBytes: number): string {
  if (!Number.isSafeInteger(initialSize) || initialSize < 0 || initialSize > maximumBytes) {
    throw new BoundedFileTooLargeError()
  }

  const chunks: Buffer[] = []
  const buffer = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1))
  let total = 0
  while (true) {
    const count = readSync(fd, buffer, 0, buffer.length, null)
    if (count === 0) break
    total += count
    if (total > maximumBytes) throw new BoundedFileTooLargeError()
    chunks.push(Buffer.from(buffer.subarray(0, count)))
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export class OwnerOnlyJsonPersistence {
  constructor(
    private readonly directory: string,
    private readonly maximumReadBytes: number,
    private readonly maximumWriteBytes?: number,
  ) {}

  ensureDirectory(createIfMissing = true): OwnerOnlyDirectoryStatus {
    let entry
    try {
      entry = lstatSync(this.directory)
    } catch (error) {
      if (!isMissingError(error)) return 'unavailable'
      if (!createIfMissing) return 'missing'
      try {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 })
        entry = lstatSync(this.directory)
      } catch {
        return 'unavailable'
      }
    }

    if (!entry.isDirectory() || entry.isSymbolicLink()) return 'unsafe'
    if ((entry.mode & 0o077) !== 0) {
      try {
        chmodSync(this.directory, 0o700)
      } catch {
        return 'unavailable'
      }
    }
    return 'ready'
  }

  read(file: string, label: string): OwnerOnlyJsonReadResult {
    let fileEntry
    try {
      fileEntry = lstatSync(file)
    } catch (error) {
      if (isMissingError(error)) return { kind: 'missing' }
      return { kind: 'unavailable' }
    }
    if (!fileEntry.isFile() || fileEntry.isSymbolicLink() || !isOwnerOnly(fileEntry.mode)) {
      return { kind: 'corrupt', reason: 'unsafe' }
    }

    let fd: number | undefined
    let value: unknown
    let failure: 'invalid' | 'too-large' | 'unavailable' = 'invalid'
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW_FLAG)
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.isSymbolicLink() ||
        !sameFileSnapshot(fileEntry, opened) || !isOwnerOnly(opened.mode)) {
        throw new Error(`${label} changed while opening`)
      }
      const raw = readBoundedUtf8(fd, opened.size, this.maximumReadBytes)
      const closed = fstatSync(fd)
      if (!sameFileSnapshot(opened, closed)) throw new Error(`${label} changed while reading`)
      value = parseStrictJson(raw, label)
    } catch (error) {
      if (error instanceof BoundedFileTooLargeError) failure = 'too-large'
      else if (isUnavailableError(error)) failure = 'unavailable'
    }
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        failure = 'unavailable'
      }
    }
    if (failure === 'unavailable') return { kind: 'unavailable' }
    if (failure === 'too-large') return { kind: 'too-large' }
    if (value !== undefined) return { kind: 'present', value }
    return { kind: 'corrupt', reason: 'invalid' }
  }

  write(file: string, value: unknown): void {
    const serialized = `${JSON.stringify(value)}\n`
    this.assertWriteSize(serialized)
    this.requireDirectory()
    this.assertReplaceableFile(file)

    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      this.writeTemporaryJson(temporary, serialized)
      this.assertReplaceableFile(file)
      renameSync(temporary, file)
      chmodSync(file, 0o600)
      this.syncDirectory()
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  createIfMissing(file: string, value: unknown): 'created' | 'exists' {
    const serialized = `${JSON.stringify(value)}\n`
    this.assertWriteSize(serialized)
    this.requireDirectory()

    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      this.writeTemporaryJson(temporary, serialized)
      try {
        linkSync(temporary, file)
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

  private assertWriteSize(serialized: string): void {
    if (this.maximumWriteBytes !== undefined &&
      Buffer.byteLength(serialized, 'utf8') > this.maximumWriteBytes) {
      throw new Error('owner-only JSON state is too large')
    }
  }

  private requireDirectory(): void {
    const status = this.ensureDirectory()
    if (status !== 'ready') throw new Error(`owner-only JSON directory is ${status}`)
  }

  private assertReplaceableFile(file: string): void {
    try {
      const entry = lstatSync(file)
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('owner-only JSON file is unsafe')
      }
    } catch (error) {
      if (!isMissingError(error)) throw error
    }
  }

  private writeTemporaryJson(file: string, serialized: string): void {
    writeFileSync(file, serialized, { encoding: 'utf8', mode: 0o600 })
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
      constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW_FLAG,
    )
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  }
}
