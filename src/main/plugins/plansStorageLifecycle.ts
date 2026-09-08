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
 * A record that exists but cannot be read or validated. This is deliberately
 * distinct from an absent record: only an absent record may be treated as a
 * first install, so `sourceFor` fails closed on this one instead of silently
 * dropping the recovery source. Resetting it is an explicit operator repair.
 */
export class UnreadablePlansLifecycleRecordError extends Error {
  constructor(readonly reason: unknown) {
    super(
      'Plans storage lifecycle record is unreadable; reset the record to recover without reinstalling Plans',
    )
    this.name = 'UnreadablePlansLifecycleRecordError'
  }
}

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

  /** Read the durable record. `null` means the record is absent; an existing
   * record that cannot be read or validated raises the typed fault so it can
   * never be confused with a first install. */
  private readRecord(): LifecycleRecord | null {
    let raw: string
    try {
      raw = this.fileOps.readFileSync(this.recordPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new UnreadablePlansLifecycleRecordError(error)
    }
    try {
      const record = JSON.parse(raw) as Partial<LifecycleRecord>
      if (
        record.pluginId !== PLANS_PLUGIN_ID ||
        record.tier !== 'active' ||
        typeof record.packageVersion !== 'string' ||
        !record.packageVersion ||
        (record.previousPackageVersion !== undefined && (
          typeof record.previousPackageVersion !== 'string' || !record.previousPackageVersion
        ))
      ) throw new Error('invalid Plans storage lifecycle record')
      return record as LifecycleRecord
    } catch (error) {
      throw new UnreadablePlansLifecycleRecordError(error)
    }
  }

  sourceFor(packageVersion: string): HostStorageSnapshotIdentity | null {
    if (!packageVersion) return null
    const record = this.readRecord()
    if (!record) return null
    const sourcePackageVersion = record.packageVersion === packageVersion
      ? record.previousPackageVersion
      : record.packageVersion
    if (
      typeof sourcePackageVersion !== 'string' ||
      !sourcePackageVersion ||
      sourcePackageVersion === packageVersion
    ) return null
    return { pluginId: PLANS_PLUGIN_ID, packageVersion: sourcePackageVersion, tier: 'active' }
  }

  /** Explicit operator repair for a record this selector refuses to read.
   * Discarding it gives up the recovery pointer, so it is never automatic:
   * `sourceFor` still fails closed, and a readable record is left untouched
   * (returns false), which keeps a valid recovery pointer out of reach of this
   * operation. Unlike plugin removal it leaves Plans and its storage in place. */
  resetUnreadableRecord(): boolean {
    try {
      this.readRecord()
      return false
    } catch (error) {
      if (!(error instanceof UnreadablePlansLifecycleRecordError)) throw error
    }
    this.clear()
    return true
  }

  clear(): void {
    try {
      this.fileOps.unlinkSync(this.recordPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  rememberActive(packageVersion: string, sourcePackageVersion?: string | null): boolean {
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
    if (sourcePackageVersion !== undefined) previousPackageVersion = sourcePackageVersion ?? undefined
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
