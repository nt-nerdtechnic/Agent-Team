import type { JsonValue } from '../../../packages/plugin-contracts/src/index'
import type { StoragePartition, StorageSnapshotRef } from './pluginCapabilityBroker'
import type {
  HostStorageSnapshotIdentity,
  PluginStorageStore,
  StorageExecution,
} from './pluginStorage'

export const GIT_STORAGE_KEYS = [
  'agent-team:theme',
  'agent-team:theme-custom',
  'agentTeam.git.autoCommit',
  'agentTeam.gitTopRatio',
  'agentTeam.git.logOrder',
  'agentTeam.analyzerModel',
  'agentTeam.git.logScope',
  'agentTeam.yolo',
  'agentTeam.terminal.optionSelectHintSeen',
  'git-ai-panel-width',
  'git-ai-panel-width.agent',
] as const

const MIGRATION_MARKER = '__navide_git_storage_migration_v2'
const GIT_PLUGIN_ID = 'navide.git'

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
    workspaceId: string | null
    workspacePath: string
    legacySettings: Record<string, unknown>
  },
): Promise<{ migrated: boolean; completed: boolean }> {
  const { packageVersion, sourceSnapshot, workspaceId, workspacePath, legacySettings } = options
  if (!packageVersion) return { migrated: false, completed: false }

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

      // The old renderer used a workspace-suffixed key for the selected Git tab.
      // It is copied only when the caller has a matching legacy value; the Host
      // still derives the destination workspace partition from its opaque id.
      if (workspaceId && workspacePath) {
        const legacyKey = `agentTeam.gitTabRepo.${workspacePath}`
        const candidate = await read(store, 'workspace', 'agentTeam.gitTabRepo', packageVersion, 'candidate', workspaceId)
        const legacyValue = legacySettings[legacyKey]
        if (!candidate.found && legacyValue !== undefined) {
          await write(store, 'workspace', 'agentTeam.gitTabRepo', legacyValue as JsonValue, packageVersion, 'candidate', workspaceId)
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

    // The active snapshot is shared by all live workspaces. A workspace opened
    // after the initial promotion cannot replace that snapshot, so add only a
    // missing workspace key directly to active. This remains create-only and
    // never overwrites a user's existing selection.
    let workspaceMigrated = false
    if (workspaceId && workspacePath) {
      const legacyKey = `agentTeam.gitTabRepo.${workspacePath}`
      const legacyValue = legacySettings[legacyKey]
      if (legacyValue !== undefined) {
        const activeWorkspace = await read(store, 'workspace', 'agentTeam.gitTabRepo', packageVersion, 'active', workspaceId)
        if (!activeWorkspace.found) {
          await write(store, 'workspace', 'agentTeam.gitTabRepo', legacyValue as JsonValue, packageVersion, 'active', workspaceId)
          workspaceMigrated = true
        }
      }
    }

    return { migrated: !pluginMigrationComplete || workspaceMigrated, completed: true }
  } catch (error) {
    console.warn('[git] v2 storage migration skipped:', error instanceof Error ? error.message : String(error))
    return { migrated: false, completed: false }
  }
}
