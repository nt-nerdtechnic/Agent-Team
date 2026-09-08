import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StorageExecution } from './pluginStorage'
import { PluginStorageStore, StorageSnapshotExistsError } from './pluginStorage'
import { PlansStorageLifecycleSelector } from './plansStorageLifecycle'
import {
  migratePlansStorage,
  projectLegacyPlansPreferences,
  readPreviousPlansWorkspacePreference,
  runPlansLegacyRecovery,
} from './plansStorageMigration'
import { retainedPlansLegacyAdapter } from './plansLegacyAdapter'

const pluginId = 'navide.plans'
const previousVersion = '0.1.93'
const currentVersion = '0.1.94'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function readExecution(tier: 'candidate' | 'active', key: string, packageVersion = currentVersion): StorageExecution {
  return {
    address: 'storage.get',
    args: { scope: 'plugin', key },
    partition: { pluginId, workspaceId: null, key },
    snapshot: { pluginId, packageVersion, tier },
  }
}

describe('Plans storage migration', () => {
  it('initializes empty preferences when the selected source snapshot is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-storage-'))
    roots.push(root)
    const store = new PluginStorageStore(root)
    await expect(migratePlansStorage(store, {
      packageVersion: currentVersion,
      sourceSnapshot: { pluginId, packageVersion: previousVersion, tier: 'active' },
    })).resolves.toMatchObject({ completed: true, sourcePackageVersion: null })
    await expect(store.execute(readExecution('active', 'plans.sort')))
      .resolves.toEqual({ found: false, value: null })
  })

  it('does not initialize preferences when reading the selected source fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-storage-'))
    roots.push(root)
    const store = new PluginStorageStore(root)
    vi.spyOn(store, 'cloneSnapshot').mockRejectedValue(new Error('permission denied'))
    const execute = vi.spyOn(store, 'execute')
    await expect(migratePlansStorage(store, {
      packageVersion: currentVersion,
      sourceSnapshot: { pluginId, packageVersion: previousVersion, tier: 'active' },
    })).resolves.toMatchObject({ completed: false })
    expect(execute).not.toHaveBeenCalled()
  })

  it('promotes a fresh candidate and clones the lifecycle-selected previous snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-storage-'))
    roots.push(root)
    const store = new PluginStorageStore(root)

    await expect(migratePlansStorage(store, {
      packageVersion: previousVersion,
      sourceSnapshot: null,
    })).resolves.toMatchObject({ completed: true, sourcePackageVersion: null })
    await store.execute({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'plans.sort', value: 'title' },
      partition: { pluginId, workspaceId: null, key: 'plans.sort' },
      snapshot: { pluginId, packageVersion: previousVersion, tier: 'active' },
    })

    await expect(migratePlansStorage(store, {
      packageVersion: currentVersion,
      sourceSnapshot: { pluginId, packageVersion: previousVersion, tier: 'active' },
    })).resolves.toMatchObject({ completed: true, sourcePackageVersion: previousVersion })
    await expect(store.execute(readExecution('active', 'plans.sort'))).resolves.toEqual({
      found: true,
      value: 'title',
    })
    await expect(migratePlansStorage(store, {
      packageVersion: currentVersion,
      sourceSnapshot: null,
    })).resolves.toMatchObject({ completed: true, migrated: false })
  })

  it('completes an idempotent rerun when the clone target already exists, whatever the message says', async () => {
    // Every normal relaunch takes this path. It must branch on the typed Host
    // signal, so renaming the message can never turn a benign rerun into a
    // failed migration and permanent recovery mode.
    class RenamedTargetExistsError extends StorageSnapshotExistsError {
      override message = 'storage clone target snapshot is present'
    }
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-storage-'))
    roots.push(root)
    const store = new PluginStorageStore(root)
    vi.spyOn(store, 'cloneSnapshot').mockRejectedValue(new RenamedTargetExistsError())

    await expect(migratePlansStorage(store, {
      packageVersion: currentVersion,
      sourceSnapshot: { pluginId, packageVersion: previousVersion, tier: 'active' },
    })).resolves.toEqual({ migrated: true, completed: true, sourcePackageVersion: previousVersion })
  })

  it('projects only the legacy preference allowlist and preserves current values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-storage-'))
    roots.push(root)
    const store = new PluginStorageStore(root)
    const workspaceId = 'workspace-hash'

    await migratePlansStorage(store, { packageVersion: currentVersion, sourceSnapshot: null })
    await store.execute({
      address: 'storage.set',
      args: { scope: 'workspace', key: 'plans.sort', value: 'progress' },
      partition: { pluginId, workspaceId, key: 'plans.sort' },
      snapshot: { pluginId, packageVersion: currentVersion, tier: 'active' },
    })

    await expect(projectLegacyPlansPreferences(store, {
      packageVersion: currentVersion,
      workspaceId,
      values: {
        'plans.filter': 'approved',
        'plans.sort': 'title',
        'plans.pinned': '["old"]',
        'unknown.key': 'must not be stored',
      } as never,
    })).resolves.toEqual({
      completed: true,
      written: ['plans.filter', 'plans.pinned'],
      preserved: ['plans.sort'],
    })
    await expect(store.execute({
      address: 'storage.get',
      args: { scope: 'workspace', key: 'plans.filter' },
      partition: { pluginId, workspaceId, key: 'plans.filter' },
      snapshot: { pluginId, packageVersion: currentVersion, tier: 'active' },
    })).resolves.toEqual({ found: true, value: 'approved' })
    await expect(store.execute({
      address: 'storage.get',
      args: { scope: 'workspace', key: 'plans.sort' },
      partition: { pluginId, workspaceId, key: 'plans.sort' },
      snapshot: { pluginId, packageVersion: currentVersion, tier: 'active' },
    })).resolves.toEqual({ found: true, value: 'progress' })
  })

  it('recovers a preference from the lifecycle-selected previous active snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-storage-'))
    roots.push(root)
    const store = new PluginStorageStore(join(root, 'storage'))
    const selector = new PlansStorageLifecycleSelector(join(root, 'plans-lifecycle.json'))
    const workspaceId = 'workspace-hash'

    await migratePlansStorage(store, { packageVersion: previousVersion, sourceSnapshot: null })
    await store.execute({
      address: 'storage.set',
      args: { scope: 'workspace', key: 'plans.group', value: 'stage' },
      partition: { pluginId, workspaceId, key: 'plans.group' },
      snapshot: { pluginId, packageVersion: previousVersion, tier: 'active' },
    })
    expect(selector.rememberActive(previousVersion)).toBe(true)
    const previousSnapshot = selector.sourceFor(currentVersion)
    expect(previousSnapshot).toEqual({
      pluginId,
      packageVersion: previousVersion,
      tier: 'active',
    })
    await migratePlansStorage(store, {
      packageVersion: currentVersion,
      sourceSnapshot: previousSnapshot,
    })

    await expect(readPreviousPlansWorkspacePreference(store, selector, {
      currentPackageVersion: currentVersion,
      workspaceId,
      key: 'plans.group',
    })).resolves.toEqual({
      sourcePackageVersion: previousVersion,
      found: true,
      value: 'stage',
    })
  })

  it('runs the production legacy adapter against the previous snapshot without changing current state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-recovery-'))
    roots.push(root)
    const storageRoot = join(root, 'storage')
    const store = new PluginStorageStore(storageRoot)
    const selector = new PlansStorageLifecycleSelector(join(root, 'plans-lifecycle.json'))
    const workspaceId = 'workspace-hash'

    await migratePlansStorage(store, { packageVersion: previousVersion, sourceSnapshot: null })
    await store.execute({
      address: 'storage.set',
      args: { scope: 'workspace', key: 'plans.group', value: 'stage' },
      partition: { pluginId, workspaceId, key: 'plans.group' },
      snapshot: { pluginId, packageVersion: previousVersion, tier: 'active' },
    })
    expect(selector.rememberActive(previousVersion)).toBe(true)
    const previousSnapshot = selector.sourceFor(currentVersion)
    expect(previousSnapshot).toEqual({
      pluginId,
      packageVersion: previousVersion,
      tier: 'active',
    })
    await migratePlansStorage(store, {
      packageVersion: currentVersion,
      sourceSnapshot: previousSnapshot,
    })
    // Production records the current identity after promotion. Recovery must
    // still resolve the displaced active snapshot after a later child failure.
    expect(selector.rememberActive(currentVersion)).toBe(true)
    await store.execute({
      address: 'storage.set',
      args: { scope: 'workspace', key: 'plans.group', value: 'flat' },
      partition: { pluginId, workspaceId, key: 'plans.group' },
      snapshot: { pluginId, packageVersion: currentVersion, tier: 'active' },
    })

    const execute = vi.spyOn(store, 'execute')
    const recovered = await runPlansLegacyRecovery(store, selector, {
      currentPackageVersion: currentVersion,
      workspaceId,
      adapter: retainedPlansLegacyAdapter,
    })

    expect(recovered).toEqual({
      sourcePackageVersion: previousVersion,
      snapshot: { pluginId, packageVersion: previousVersion, tier: 'active' },
      result: {
        preferences: { 'plans.group': 'stage' },
      },
    })
    expect(execute.mock.calls.every(([operation]) => operation.address === 'storage.get')).toBe(true)
    execute.mockRestore()
    await expect(store.execute({
      address: 'storage.get',
      args: { scope: 'workspace', key: 'plans.group' },
      partition: { pluginId, workspaceId, key: 'plans.group' },
      snapshot: { pluginId, packageVersion: currentVersion, tier: 'active' },
    })).resolves.toEqual({ found: true, value: 'flat' })
  })
})
