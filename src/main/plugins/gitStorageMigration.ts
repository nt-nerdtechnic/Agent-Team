import type { JsonValue } from '../../../packages/plugin-contracts/src/index'
import { HOST_GIT_USER_PREFERENCE_KEYS } from '../../shared/gitCompatibility'
import type { StoragePartition, StorageSnapshotRef } from './pluginCapabilityBroker'
import type {
  HostStorageSnapshotIdentity,
  PluginStorageStore,
  StorageExecution,
} from './pluginStorage'

export const GIT_STORAGE_KEYS = HOST_GIT_USER_PREFERENCE_KEYS

const MIGRATION_MARKER = '__navide_git_storage_migration_v2'
const GIT_PLUGIN_ID = 'navide.git'

type MigrationLockMap = Map<string, Promise<void>>
const migrationLocks = new WeakMap<object, MigrationLockMap>()

async function withMigrationLock<T>(
  store: PluginStorageStore,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const locks = migrationLocks.get(store) ?? new Map<string, Promise<void>>()
  migrationLocks.set(store, locks)
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  locks.set(key, current)
  await previous
  try {
    return await operation()
  } finally {
    if (locks.get(key) === current) locks.delete(key)
    release()
  }
}

/** Prepare the current candidate from the Host-selected previous active
 * snapshot. Legacy settings are only needed for a first install with no
 * durable v2 source. There is intentionally no cross-version fallback read
 * after promotion. */
export async function prepareGitStorageSnapshot(
  store: PluginStorageStore,
  packageVersion: string,
  sourceSnapshot: HostStorageSnapshotIdentity | null,
): Promise<{ sourcePackageVersion: string | null }> {
  if (
    !sourceSnapshot ||
    sourceSnapshot.pluginId !== GIT_PLUGIN_ID ||
    sourceSnapshot.tier !== 'active' ||
    sourceSnapshot.packageVersion === packageVersion
  ) return { sourcePackageVersion: null }
  try {
    await store.cloneSnapshot(
      sourceSnapshot,
      { pluginId: GIT_PLUGIN_ID, packageVersion, tier: 'candidate' },
    )
  } catch (error) {
    if (!(error instanceof Error && /already exists/i.test(error.message))) throw error
  }
  return { sourcePackageVersion: sourceSnapshot.packageVersion }
}

function execution(
  address: StorageExecution['address'],
  scope: 'plugin' | 'workspace',
  key: string,
  packageVersion: string,
  tier: 'candidate' | 'active',
  workspaceId: string | null,
  value?: JsonValue,
): StorageExecution {
  const partition: StoragePartition = {
    pluginId: GIT_PLUGIN_ID,
    workspaceId: scope === 'workspace' ? workspaceId : null,
    key,
  }
  const snapshot: StorageSnapshotRef = { pluginId: GIT_PLUGIN_ID, packageVersion, tier }
  return {
    address,
    args: { scope, key, ...(address === 'storage.set' ? { value } : {}) },
    partition,
    snapshot,
  }
}

async function read(
  store: PluginStorageStore,
  scope: 'plugin' | 'workspace',
  key: string,
  packageVersion: string,
  tier: 'candidate' | 'active',
  workspaceId: string | null,
): Promise<{ found: boolean; value: JsonValue | null }> {
  return store.execute(execution('storage.get', scope, key, packageVersion, tier, workspaceId)) as Promise<{
    found: boolean
    value: JsonValue | null
  }>
}

async function write(
  store: PluginStorageStore,
  scope: 'plugin' | 'workspace',
  key: string,
  value: JsonValue,
  packageVersion: string,
  tier: 'candidate' | 'active',
  workspaceId: string | null,
): Promise<void> {
  await store.execute(execution('storage.set', scope, key, packageVersion, tier, workspaceId, value))
}

/**
 * Copy the small set of Git preferences that used to be carried by the shared
 * UI settings store into the v2 candidate snapshot. Existing v2 values always
 * win. Promotion is create-only, so rerunning this function cannot overwrite
 * an active snapshot or a user's later edits.
 */
export async function migrateBundledGitPreferences(
  store: PluginStorageStore,
  options: {
    packageVersion: string
    sourceSnapshot: HostStorageSnapshotIdentity | null
    legacySettings: Record<string, unknown>
  },
): Promise<{ migrated: boolean; completed: boolean }> {
  if (!options.packageVersion) return { migrated: false, completed: false }
  return withMigrationLock(
    store,
    `${GIT_PLUGIN_ID}:${options.packageVersion}`,
    () => migrateBundledGitPreferencesUnlocked(store, options),
  )
}

async function migrateBundledGitPreferencesUnlocked(
  store: PluginStorageStore,
  options: {
    packageVersion: string
    sourceSnapshot: HostStorageSnapshotIdentity | null
    legacySettings: Record<string, unknown>
  },
): Promise<{ migrated: boolean; completed: boolean }> {
  const { packageVersion, sourceSnapshot, legacySettings } = options

  try {
    await prepareGitStorageSnapshot(store, packageVersion, sourceSnapshot)
    const activeMarker = await read(store, 'plugin', MIGRATION_MARKER, packageVersion, 'active', null)
    const pluginMigrationComplete = activeMarker.found && activeMarker.value === true

    if (!pluginMigrationComplete) {
      for (const key of GIT_STORAGE_KEYS) {
        const candidate = await read(store, 'plugin', key, packageVersion, 'candidate', null)
        if (!candidate.found && Object.prototype.hasOwnProperty.call(legacySettings, key)) {
          const value = legacySettings[key]
          if (value !== undefined) await write(store, 'plugin', key, value as JsonValue, packageVersion, 'candidate', null)
        }
      }

      await write(store, 'plugin', MIGRATION_MARKER, true, packageVersion, 'candidate', null)
      try {
        await store.cloneSnapshot(
          { pluginId: GIT_PLUGIN_ID, packageVersion, tier: 'candidate' },
          { pluginId: GIT_PLUGIN_ID, packageVersion, tier: 'active' },
        )
      } catch (error) {
        // A pre-existing active snapshot is the user's authoritative state. Do
        // not replace it; mark it once so subsequent opens stay idempotent.
        if (!(error instanceof Error && /already exists/i.test(error.message))) throw error
      }
      const activeAfterPromotion = await read(store, 'plugin', MIGRATION_MARKER, packageVersion, 'active', null)
      if (!activeAfterPromotion.found) {
        await write(store, 'plugin', MIGRATION_MARKER, true, packageVersion, 'active', null)
      }
    }

    return { migrated: !pluginMigrationComplete, completed: true }
  } catch (error) {
    console.warn('[git] v2 storage migration skipped:', error instanceof Error ? error.message : String(error))
    return { migrated: false, completed: false }
  }
}
