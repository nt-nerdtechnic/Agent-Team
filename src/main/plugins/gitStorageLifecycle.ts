import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { HostStorageSnapshotIdentity } from './pluginStorage'

const GIT_PLUGIN_ID = 'navide.git'

interface LifecycleRecord {
  pluginId: typeof GIT_PLUGIN_ID
  packageVersion: string
  tier: 'active'
}

/** Narrow file-operation seam used to prove torn-write behavior without
 * replacing the application's persistence stack. This is not a plugin wire
 * contract. */
export interface GitStorageLifecycleFileOps {
  mkdirSync(path: string, options: { recursive: true }): void
  openSync(path: string, flags: number, mode?: number): number
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
  readFileSync(path: string, encoding: 'utf8'): string
}

const defaultFileOps: GitStorageLifecycleFileOps = {
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  readFileSync,
}

let temporaryFileSequence = 0

/**
 * Host lifecycle seam for Git storage promotion. Installation/update/rollback
 * records the exact active package identity; migration consumes that identity
 * and never searches retained snapshot directories or compares versions.
 */
export class GitStorageLifecycleSelector {
  constructor(
    private readonly recordPath: string,
    private readonly fileOps: GitStorageLifecycleFileOps = defaultFileOps,
  ) {}

  sourceFor(packageVersion: string): HostStorageSnapshotIdentity | null {
    if (!packageVersion) return null
    try {
      const record = JSON.parse(readFileSync(this.recordPath, 'utf8')) as Partial<LifecycleRecord>
      if (
        record.pluginId !== GIT_PLUGIN_ID ||
        record.tier !== 'active' ||
        typeof record.packageVersion !== 'string' ||
        !record.packageVersion ||
        record.packageVersion === packageVersion
      ) return null
      return {
        pluginId: GIT_PLUGIN_ID,
        packageVersion: record.packageVersion,
        tier: 'active',
      }
    } catch {
      return null
    }
  }

  rememberActive(packageVersion: string): boolean {
    if (!packageVersion) return false

    const parentPath = dirname(this.recordPath)
    const record = `${JSON.stringify({
      pluginId: GIT_PLUGIN_ID,
      packageVersion,
      tier: 'active',
    } satisfies LifecycleRecord)}\n`
    let tempPath = ''
    let fileDescriptor: number | null = null

    try {
      this.fileOps.mkdirSync(parentPath, { recursive: true })
      for (let attempt = 0; attempt < 8; attempt += 1) {
        tempPath = join(
          parentPath,
          `.${basename(this.recordPath)}.tmp-${process.pid}-${Date.now()}-${temporaryFileSequence++}`,
        )
        try {
          fileDescriptor = this.fileOps.openSync(
            tempPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
          )
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 7) throw error
        }
      }
      if (fileDescriptor === null) throw new Error('could not create lifecycle selector temporary file')

      const bytes = Buffer.from(record, 'utf8')
      let offset = 0
      while (offset < bytes.length) {
        const written = this.fileOps.writeSync(fileDescriptor, bytes, offset, bytes.length - offset, null)
        if (written <= 0) throw new Error('lifecycle selector write made no progress')
        offset += written
      }
      this.fileOps.fsyncSync(fileDescriptor)
      this.fileOps.closeSync(fileDescriptor)
      fileDescriptor = null

      // The rename is the commit point. Until it succeeds, the previous
      // selector remains untouched and a crash can only leave an ignored temp.
      this.fileOps.renameSync(tempPath, this.recordPath)
      tempPath = ''

      // Persist the directory entry as well; this closes the durability gap
      // between an atomic rename and a power loss before the directory flush.
      const parentDescriptor = this.fileOps.openSync(parentPath, constants.O_RDONLY)
      try {
        this.fileOps.fsyncSync(parentDescriptor)
      } finally {
        this.fileOps.closeSync(parentDescriptor)
      }
      return true
    } catch (error) {
      if (fileDescriptor !== null) {
        try { this.fileOps.closeSync(fileDescriptor) } catch { /* preserve original failure */ }
      }
      if (tempPath) {
        try { this.fileOps.unlinkSync(tempPath) } catch { /* temp cleanup is best effort */ }
      }
      console.warn('[git-storage] lifecycle selector write failed', error)
      return false
    }
  }
}
