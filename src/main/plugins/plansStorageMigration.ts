import type {
  HostStorageSnapshotIdentity,
  PluginStorageStore,
  StorageExecution,
} from './pluginStorage'
import type { StoragePartition, StorageSnapshotRef } from './pluginCapabilityBroker'
import { PLANS_PLUGIN_ID, PlansStorageLifecycleSelector } from './plansStorageLifecycle'
import { STORAGE_LIMITS } from './pluginCapabilityCatalog'
import { utf8ByteLength } from './pluginStorageJson'
import {
  PLANS_STORAGE_KEYS,
  type LegacyPlansPreferenceProjection,
  type PlansStorageKey,
} from '../../shared/plansPreferences'

export { PLANS_STORAGE_KEYS }

const MIGRATION_MARKER = '__navide_plans_storage_migration_v2'

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

function execution(
  address: StorageExecution['address'],
  key: string,
  packageVersion: string,
  tier: 'candidate' | 'active',
  scope: 'plugin' | 'workspace' = 'plugin',
  workspaceId: string | null = null,
  value: unknown = true,
): StorageExecution {
  const partition: StoragePartition = {
    pluginId: PLANS_PLUGIN_ID,
    workspaceId: scope === 'workspace' ? workspaceId : null,
    key,
  }
  const snapshot: StorageSnapshotRef = {
    pluginId: PLANS_PLUGIN_ID,
    packageVersion,
    tier,
  }
  return {
    address,
    args: { scope, key, ...(address === 'storage.set' ? { value } : {}) },
    partition,
    snapshot,
  }
}

async function marker(
  store: PluginStorageStore,
  packageVersion: string,
  tier: 'candidate' | 'active',
): Promise<boolean> {
  const result = await store.execute(execution('storage.get', MIGRATION_MARKER, packageVersion, tier)) as {
    found: boolean
    value: unknown
  }
  return result.found && result.value === true
}

async function writeMarker(
  store: PluginStorageStore,
  packageVersion: string,
  tier: 'candidate' | 'active',
): Promise<void> {
  await store.execute(execution('storage.set', MIGRATION_MARKER, packageVersion, tier))
}

/** Clone only the lifecycle-selected previous active snapshot into the new
 * candidate. A missing selector means first install; no retained snapshot is
 * searched as an implicit upgrade source. */
export async function preparePlansStorageSnapshot(
  store: PluginStorageStore,
  packageVersion: string,
  sourceSnapshot: HostStorageSnapshotIdentity | null,
): Promise<{ sourcePackageVersion: string | null }> {
  if (
    !sourceSnapshot ||
    sourceSnapshot.pluginId !== PLANS_PLUGIN_ID ||
    sourceSnapshot.tier !== 'active' ||
    sourceSnapshot.packageVersion === packageVersion
  ) return { sourcePackageVersion: null }
  try {
    await store.cloneSnapshot(
      sourceSnapshot,
      { pluginId: PLANS_PLUGIN_ID, packageVersion, tier: 'candidate' },
    )
  } catch (error) {
    if (!(error instanceof Error && /already exists/i.test(error.message))) throw error
  }
  return { sourcePackageVersion: sourceSnapshot.packageVersion }
}

/** Promote a prepared candidate exactly once. Renderer preferences are already
 * stored in the active snapshot by the normal storage broker; this lifecycle
 * step only establishes the durable candidate/active boundary and marker. */
export async function migratePlansStorage(
  store: PluginStorageStore,
  options: {
    packageVersion: string
    sourceSnapshot: HostStorageSnapshotIdentity | null
  },
): Promise<{ migrated: boolean; completed: boolean; sourcePackageVersion: string | null }> {
  if (!options.packageVersion) {
    return { migrated: false, completed: false, sourcePackageVersion: null }
  }
  return withMigrationLock(
    store,
    `${PLANS_PLUGIN_ID}:${options.packageVersion}`,
    async () => {
      try {
        const prepared = await preparePlansStorageSnapshot(
          store,
          options.packageVersion,
          options.sourceSnapshot,
        )
        if (await marker(store, options.packageVersion, 'active')) {
          return { migrated: false, completed: true, sourcePackageVersion: prepared.sourcePackageVersion }
        }

        if (!(await marker(store, options.packageVersion, 'candidate'))) {
          await writeMarker(store, options.packageVersion, 'candidate')
        }

        let promoted = false
        try {
          await store.cloneSnapshot(
            { pluginId: PLANS_PLUGIN_ID, packageVersion: options.packageVersion, tier: 'candidate' },
            { pluginId: PLANS_PLUGIN_ID, packageVersion: options.packageVersion, tier: 'active' },
          )
          promoted = true
        } catch (error) {
          if (!(error instanceof Error && /already exists/i.test(error.message))) throw error
        }
        if (!(await marker(store, options.packageVersion, 'active'))) {
          await writeMarker(store, options.packageVersion, 'active')
        }
        return {
          migrated: promoted || prepared.sourcePackageVersion !== null,
          completed: true,
          sourcePackageVersion: prepared.sourcePackageVersion,
        }
      } catch (error) {
        console.warn(
          '[plans] v2 storage migration skipped:',
          error instanceof Error ? error.message : String(error),
        )
        return { migrated: false, completed: false, sourcePackageVersion: null }
      }
    },
  )
}

/**
 * Project the exact legacy Plans preference allowlist into one Host-selected
 * workspace partition. This is intentionally separate from the public storage
 * broker: the legacy renderer is the only place that can read its old origin,
 * while the Host owns validation, identity and the create-only write policy.
 */
export async function projectLegacyPlansPreferences(
  store: PluginStorageStore,
  options: {
    packageVersion: string
    workspaceId: string
    values: LegacyPlansPreferenceProjection
  },
): Promise<{ completed: boolean; written: PlansStorageKey[]; preserved: PlansStorageKey[] }> {
  const empty: {
    completed: boolean
    written: PlansStorageKey[]
    preserved: PlansStorageKey[]
  } = { completed: false, written: [], preserved: [] }
  if (!options.packageVersion || !options.workspaceId) return empty

  return withMigrationLock(
    store,
    `${PLANS_PLUGIN_ID}:${options.packageVersion}:${options.workspaceId}`,
    async () => {
      const written: PlansStorageKey[] = []
      const preserved: PlansStorageKey[] = []
      try {
        for (const key of PLANS_STORAGE_KEYS) {
          const value = options.values[key]
          if (
            typeof value !== 'string' ||
            utf8ByteLength(value) > STORAGE_LIMITS.maxValueBytes
          ) continue
          const created = await store.setIfAbsent(execution(
            'storage.set',
            key,
            options.packageVersion,
            'active',
            'workspace',
            options.workspaceId,
            value,
          ))
          if (!created) {
            preserved.push(key)
            continue
          }
          written.push(key)
        }
        return { completed: true, written, preserved }
      } catch (error) {
        console.warn(
          '[plans] legacy preference projection skipped:',
          error instanceof Error ? error.message : String(error),
        )
        return { completed: false, written, preserved }
      }
    },
  )
}

/** Host-only recovery seam for the lifecycle-selected previous active
 * snapshot. Runtime Plans always binds to `active`; this helper exists for an
 * operator recovery path and tests, and never lets a plugin select a previous
 * tier or package identity. */
export async function readPreviousPlansWorkspacePreference(
  store: PluginStorageStore,
  selector: PlansStorageLifecycleSelector,
  options: {
    currentPackageVersion: string
    workspaceId: string
    key: PlansStorageKey
  },
): Promise<{ sourcePackageVersion: string | null; found: boolean; value?: unknown }> {
  if (
    !options.currentPackageVersion ||
    !options.workspaceId ||
    !PLANS_STORAGE_KEYS.includes(options.key)
  ) return { sourcePackageVersion: null, found: false }
  const source = selector.sourceFor(options.currentPackageVersion)
  if (!source) return { sourcePackageVersion: null, found: false }
  try {
    const result = await store.execute(execution(
      'storage.get',
      options.key,
      source.packageVersion,
      'active',
      'workspace',
      options.workspaceId,
    )) as { found: boolean; value?: unknown }
    return {
      sourcePackageVersion: source.packageVersion,
      found: result.found === true,
      ...(result.found === true ? { value: result.value } : {}),
    }
  } catch (error) {
    console.warn(
      '[plans] previous snapshot recovery read skipped:',
      error instanceof Error ? error.message : String(error),
    )
    return { sourcePackageVersion: source.packageVersion, found: false }
  }
}

/**
 * Host-only context for running the retained legacy Plans adapter against the
 * lifecycle-selected previous snapshot. The adapter receives a read-only
 * preference port; it cannot choose a package, tier, workspace, or storage
 * mutation operation.
 */
export interface PlansLegacyRecoveryContext {
  readonly workspaceId: string
  readonly snapshot: HostStorageSnapshotIdentity
  readPreference(key: PlansStorageKey): Promise<{ found: boolean; value?: unknown }>
}

/** Production adapter contract for the retained legacy Plans route. The
 * adapter binds only to the Host-selected recovery context; it cannot choose
 * a workspace, package version, storage tier, or mutation operation. */
export interface PlansLegacyRecoveryAdapter<T> {
  bind(context: PlansLegacyRecoveryContext): Promise<T> | T
}

export interface PlansLegacyRecoveryResult<T> {
  readonly sourcePackageVersion: string
  readonly snapshot: HostStorageSnapshotIdentity
  readonly result: T
}

/**
 * Select the recorded previous active identity, construct a read-only
 * recovery context, and run a Host-owned legacy adapter. This seam is
 * deliberately not wired into normal v2 runtime selection: it exists for
 * recovery tooling and the retained legacy route to inspect the old snapshot
 * without promoting, converting, or overwriting current state.
 */
export async function runPlansLegacyRecovery<T>(
  store: PluginStorageStore,
  selector: PlansStorageLifecycleSelector,
  options: {
    currentPackageVersion: string
    workspaceId: string
    adapter: PlansLegacyRecoveryAdapter<T>
  },
): Promise<PlansLegacyRecoveryResult<T> | null> {
  if (!options.currentPackageVersion || !options.workspaceId) return null
  const selected = selector.sourceFor(options.currentPackageVersion)
  if (
    !selected ||
    selected.pluginId !== PLANS_PLUGIN_ID ||
    selected.tier !== 'active' ||
    selected.packageVersion === options.currentPackageVersion
  ) return null

  const snapshot: HostStorageSnapshotIdentity = {
    pluginId: PLANS_PLUGIN_ID,
    packageVersion: selected.packageVersion,
    tier: 'active',
  }
  const context: PlansLegacyRecoveryContext = Object.freeze({
    workspaceId: options.workspaceId,
    snapshot,
    readPreference: async (key: PlansStorageKey) => {
      if (!PLANS_STORAGE_KEYS.includes(key)) return { found: false }
      return store.execute(execution(
        'storage.get',
        key,
        snapshot.packageVersion,
        'active',
        'workspace',
        options.workspaceId,
      )) as Promise<{ found: boolean; value?: unknown }>
    },
  })
  return {
    sourcePackageVersion: snapshot.packageVersion,
    snapshot,
    result: await options.adapter.bind(context),
  }
}
