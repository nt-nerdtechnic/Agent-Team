import type { PlansStorageLifecycleSelector } from './plansStorageLifecycle'
import type { PlansStorageAvailability } from './plansStorageMigrationGate'

export interface PlansStorageRepairResult {
  /** Whether the repair request itself completed. */
  ok: boolean
  /** True only when an unreadable record was actually discarded. */
  repaired: boolean
  reason?: string
}

/**
 * Operator-initiated repair for a Plans lifecycle record the Host refuses to
 * read. `sourceFor` fails closed on such a record — a corrupt record must never
 * be mistaken for a clean first install — which wedges the migration gate in
 * recovery on every launch with nothing left to rewrite the file. Clearing it
 * automatically is not the fix: that would only move the silent "treated as a
 * first install" one launch later and drop the upgrade source, so the discard
 * stays an explicit request. A readable record is left untouched.
 *
 * Running the gate again afterwards rewrites a valid record now, instead of
 * leaving the repair unproven until the next launch.
 */
export async function repairPlansStorageRecord(options: {
  lifecycle: Pick<PlansStorageLifecycleSelector, 'resetUnreadableRecord'>
  packageVersion: string | null
  ensureStorage: (packageVersion: string) => Promise<PlansStorageAvailability>
}): Promise<PlansStorageRepairResult> {
  let repaired: boolean
  try {
    repaired = options.lifecycle.resetUnreadableRecord()
  } catch (error) {
    return {
      ok: false,
      repaired: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  if (!repaired || !options.packageVersion) return { ok: true, repaired }
  const availability = await options.ensureStorage(options.packageVersion)
  return availability.status === 'ready'
    ? { ok: true, repaired: true }
    : { ok: false, repaired: true, reason: `Plans storage is ${availability.status}` }
}
