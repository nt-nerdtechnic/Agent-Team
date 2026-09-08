import type { PluginStorageStore } from './pluginStorage'
import { PLANS_PLUGIN_ID, type PlansStorageLifecycleSelector } from './plansStorageLifecycle'
import { migratePlansStorage } from './plansStorageMigration'

export interface PlansStorageAvailability {
  status: 'ready' | 'recovery' | 'unavailable'
}

/** One in-flight Host-owned migration per selected package, shared by startup and all
 * entrypoints. Failed persistence can never publish a runtime snapshot. */
export function createPlansStorageMigrationGate(options: {
  store: PluginStorageStore
  lifecycle: PlansStorageLifecycleSelector
  onReady: (packageVersion: string, previousPackageVersion: string | null) => void
  onFailure: (packageVersion: string, reason: string, availability: PlansStorageAvailability) => void
}): (packageVersion: string) => Promise<PlansStorageAvailability> {
  const migrations = new Map<string, Promise<PlansStorageAvailability>>()
  return (packageVersion) => {
    const existing = migrations.get(packageVersion)
    if (existing) return existing
    // Start after publishing the promise, including synchronous selection errors.
    const promise = Promise.resolve().then(async (): Promise<PlansStorageAvailability> => {
      try {
        const sourceSnapshot = options.lifecycle.sourceFor(packageVersion)
        const migration = await migratePlansStorage(options.store, { packageVersion, sourceSnapshot })
        if (!migration.completed) throw new Error('Plans storage migration did not complete')
        await options.store.assertSnapshotReadable({ pluginId: PLANS_PLUGIN_ID, packageVersion, tier: 'active' })
        if (!options.lifecycle.rememberActive(packageVersion, migration.sourcePackageVersion)) {
          throw new Error('Plans storage lifecycle could not be persisted')
        }
        options.onReady(packageVersion, migration.sourcePackageVersion)
        return { status: 'ready' }
      } catch (error) {
        let status: 'recovery' | 'unavailable' = 'unavailable'
        try {
          // Re-read durable state: rememberActive may have failed after rename.
          const source = options.lifecycle.sourceFor(packageVersion)
          if (source) {
            await options.store.assertSnapshotReadable(source)
            status = 'recovery'
          }
        } catch { /* No trusted, readable previous snapshot: fail closed. */ }
        options.onFailure(packageVersion, error instanceof Error ? error.message : String(error), { status })
        return { status }
      }
    }).finally(() => {
      if (migrations.get(packageVersion) === promise) migrations.delete(packageVersion)
    })
    migrations.set(packageVersion, promise)
    return promise
  }
}
