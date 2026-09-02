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

export const PLANS_PLUGIN_ID = 'navide.plans'

interface LifecycleRecord {
  pluginId: typeof PLANS_PLUGIN_ID
  packageVersion: string
  tier: 'active'
  /** The active identity displaced by packageVersion, retained for recovery
   * after the current package has already been promoted. */
  previousPackageVersion?: string
}

export interface PlansStorageLifecycleFileOps {
  mkdirSync(path: string, options: { recursive: true }): void
  openSync(path: string, flags: number, mode?: number): number
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
  readFileSync(path: string, encoding: 'utf8'): string
}

const defaultFileOps: PlansStorageLifecycleFileOps = {
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
 * Records the exact active Plans package identity. Upgrade recovery consumes
 * this record only; it never guesses a previous version by scanning storage
 * directories or comparing semver values.
 */
export class PlansStorageLifecycleSelector {
  constructor(
    private readonly recordPath: string,
    private readonly fileOps: PlansStorageLifecycleFileOps = defaultFileOps,
  ) {}

  sourceFor(packageVersion: string): HostStorageSnapshotIdentity | null {
    if (!packageVersion) return null
    try {
      const record = JSON.parse(this.fileOps.readFileSync(this.recordPath, 'utf8')) as Partial<LifecycleRecord>
      if (
        record.pluginId !== PLANS_PLUGIN_ID ||
        record.tier !== 'active' ||
        typeof record.packageVersion !== 'string' ||
        !record.packageVersion
      ) return null
      const sourcePackageVersion = record.packageVersion === packageVersion
        ? record.previousPackageVersion
        : record.packageVersion
      if (
        typeof sourcePackageVersion !== 'string' ||
        !sourcePackageVersion ||
        sourcePackageVersion === packageVersion
      ) return null
      return { pluginId: PLANS_PLUGIN_ID, packageVersion: sourcePackageVersion, tier: 'active' }
    } catch {
      return null
    }
  }

  rememberActive(packageVersion: string): boolean {
    if (!packageVersion) return false
    const parentPath = dirname(this.recordPath)
    let previousPackageVersion: string | undefined
    try {
      const previous = JSON.parse(this.fileOps.readFileSync(this.recordPath, 'utf8')) as Partial<LifecycleRecord>
      if (
        previous.pluginId === PLANS_PLUGIN_ID &&
        previous.tier === 'active' &&
        typeof previous.packageVersion === 'string' &&
        previous.packageVersion
      ) {
        previousPackageVersion = previous.packageVersion === packageVersion
          ? previous.previousPackageVersion
          : previous.packageVersion
      }
    } catch {
      // First install or an unreadable old record has no trusted recovery source.
    }
    if (previousPackageVersion === packageVersion) previousPackageVersion = undefined
    const record = `${JSON.stringify({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      tier: 'active',
      ...(previousPackageVersion ? { previousPackageVersion } : {}),
    } satisfies LifecycleRecord)}\n`
    let temporaryPath = ''
    let descriptor: number | null = null
    try {
      this.fileOps.mkdirSync(parentPath, { recursive: true })
      for (let attempt = 0; attempt < 8; attempt += 1) {
        temporaryPath = join(
          parentPath,
          `.${basename(this.recordPath)}.tmp-${process.pid}-${Date.now()}-${temporaryFileSequence++}`,
        )
        try {
          descriptor = this.fileOps.openSync(
            temporaryPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
          )
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 7) throw error
        }
      }
      if (descriptor === null) throw new Error('could not create Plans lifecycle temporary file')
      const bytes = Buffer.from(record, 'utf8')
      let offset = 0
      while (offset < bytes.length) {
        const written = this.fileOps.writeSync(descriptor, bytes, offset, bytes.length - offset, null)
        if (written <= 0) throw new Error('Plans lifecycle write made no progress')
        offset += written
      }
      this.fileOps.fsyncSync(descriptor)
      this.fileOps.closeSync(descriptor)
      descriptor = null
      this.fileOps.renameSync(temporaryPath, this.recordPath)
      temporaryPath = ''
      const parentDescriptor = this.fileOps.openSync(parentPath, constants.O_RDONLY)
      try {
        this.fileOps.fsyncSync(parentDescriptor)
      } finally {
        this.fileOps.closeSync(parentDescriptor)
      }
      return true
    } catch (error) {
      if (descriptor !== null) {
        try { this.fileOps.closeSync(descriptor) } catch { /* preserve original failure */ }
      }
      if (temporaryPath) {
        try { this.fileOps.unlinkSync(temporaryPath) } catch { /* best effort */ }
      }
      console.warn('[plans-storage] lifecycle selector write failed', error)
      return false
    }
  }
}
