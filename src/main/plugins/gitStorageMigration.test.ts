import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StorageExecution } from './pluginStorage'
import { PluginStorageStore } from './pluginStorage'
import { migrateBundledGitPreferences } from './gitStorageMigration'

const version = '0.1.86'
const previousVersion = '0.1.85'
const pluginId = 'navide.git'
const roots: string[] = []

function readExecution(
  tier: 'candidate' | 'active',
  scope: 'plugin' | 'workspace',
  key: string,
  workspaceId: string | null,
  packageVersion = version,
): StorageExecution {
  return {
    address: 'storage.get',
    args: { scope, key },
    partition: { pluginId, workspaceId: scope === 'workspace' ? workspaceId : null, key },
    snapshot: { pluginId, packageVersion, tier },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Git v2 storage migration', () => {
  it('copies allowlisted user values, promotes a candidate, and preserves the target on retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-git-storage-'))
    roots.push(root)
    const store = new PluginStorageStore(root)
    const options = {
      packageVersion: version,
      sourceSnapshot: null,
      legacySettings: {
        'agentTeam.git.logScope': 'current',
        'agent-team:theme': 'must-not-copy',
        'agentTeam.analyzerModel': 'must-not-copy',
        'agentTeam.yolo': 'must-not-copy',
        'agentTeam.terminal.optionSelectHintSeen': 'must-not-copy',
        'git-ai-panel-width': 420,
        'git-ai-panel-width.agent': 'claude',
        'agentTeam.unrelated': 'must-not-copy',
      },
    }

    await expect(migrateBundledGitPreferences(store, options)).resolves.toEqual({ migrated: true, completed: true })
    await expect(store.execute(readExecution('active', 'plugin', 'agentTeam.git.logScope', null)))
      .resolves.toEqual({ found: true, value: 'current' })
    await expect(store.execute(readExecution('active', 'workspace', 'agentTeam.gitTabRepo', 'workspace-1')))
      .resolves.toEqual({ found: false, value: null })
    await expect(store.execute(readExecution('active', 'plugin', 'agentTeam.unrelated', null)))
      .resolves.toEqual({ found: false, value: null })
    for (const key of [
      'agent-team:theme',
      'agentTeam.analyzerModel',
      'agentTeam.yolo',
      'agentTeam.terminal.optionSelectHintSeen',
    ]) {
      await expect(store.execute(readExecution('active', 'plugin', key, null)))
        .resolves.toEqual({ found: false, value: null })
    }
    await expect(store.execute(readExecution('active', 'plugin', 'git-ai-panel-width', null)))
      .resolves.toEqual({ found: true, value: 420 })
    await expect(store.execute(readExecution('active', 'plugin', 'git-ai-panel-width.agent', null)))
      .resolves.toEqual({ found: true, value: 'claude' })

    await expect(migrateBundledGitPreferences(store, {
      ...options,
      legacySettings: { 'agentTeam.git.logScope': 'all' },
    })).resolves.toEqual({ migrated: false, completed: true })
    await expect(store.execute(readExecution('active', 'workspace', 'agentTeam.gitTabRepo', 'workspace-1')))
      .resolves.toEqual({ found: false, value: null })

    await expect(migrateBundledGitPreferences(store, {
      ...options,
      legacySettings: { 'agentTeam.git.logScope': 'all' },
    })).resolves.toEqual({ migrated: false, completed: true })
    await expect(store.execute(readExecution('active', 'plugin', 'agentTeam.git.logScope', null)))
      .resolves.toEqual({ found: true, value: 'current' })
  })

  it('clones the previous active version before applying first-install migration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-git-storage-upgrade-'))
    roots.push(root)
    const store = new PluginStorageStore(root)
    await migrateBundledGitPreferences(store, {
      packageVersion: previousVersion,
      sourceSnapshot: null,
      legacySettings: { 'agentTeam.git.logScope': 'all' },
    })

    await migrateBundledGitPreferences(store, {
      packageVersion: version,
      sourceSnapshot: {
        pluginId,
        packageVersion: previousVersion,
        tier: 'active',
      },
      legacySettings: { 'agentTeam.git.logScope': 'current' },
    })

    await expect(store.execute(readExecution('active', 'plugin', 'agentTeam.git.logScope', null)))
      .resolves.toEqual({ found: true, value: 'all' })
    await expect(store.execute(readExecution('active', 'workspace', 'agentTeam.gitTabRepo', 'workspace-1')))
      .resolves.toEqual({ found: false, value: null })
    await expect(store.execute(readExecution('active', 'plugin', 'agentTeam.git.logScope', null, previousVersion)))
      .resolves.toEqual({ found: true, value: 'all' })
  })

  it('does not infer a source from a retained snapshot identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-git-storage-no-infer-'))
    roots.push(root)
    const store = new PluginStorageStore(root)
    await migrateBundledGitPreferences(store, {
      packageVersion: previousVersion,
      sourceSnapshot: null,
      legacySettings: { 'agentTeam.git.logScope': 'all' },
    })

    await migrateBundledGitPreferences(store, {
      packageVersion: '0.1.90-beta.1',
      sourceSnapshot: null,
      legacySettings: { 'agentTeam.git.logScope': 'current' },
    })

    await expect(store.execute(readExecution(
      'active',
      'plugin',
      'agentTeam.git.logScope',
      null,
      '0.1.90-beta.1',
    ))).resolves.toEqual({ found: true, value: 'current' })
  })

  it('resumes an interrupted candidate without replacing its already-written seed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-git-storage-interrupted-'))
    roots.push(root)
    const store = new PluginStorageStore(root)
    const options = {
      packageVersion: version,
      sourceSnapshot: null,
      legacySettings: { 'agentTeam.git.logScope': 'current' },
    }
    const originalExecute = store.execute.bind(store)
    const execute = vi.spyOn(store, 'execute')
    execute.mockImplementation(async (request) => {
      if (
        request.address === 'storage.set' &&
        request.snapshot.tier === 'candidate' &&
        request.args.key === '__navide_git_storage_migration_v2'
      ) {
        throw new Error('simulated interruption after candidate seed')
      }
      return originalExecute(request)
    })

    await expect(migrateBundledGitPreferences(store, options))
      .resolves.toEqual({ migrated: false, completed: false })
    execute.mockRestore()

    await expect(migrateBundledGitPreferences(store, {
      ...options,
      legacySettings: { 'agentTeam.git.logScope': 'all' },
    })).resolves.toEqual({ migrated: true, completed: true })
    await expect(store.execute(readExecution('active', 'plugin', 'agentTeam.git.logScope', null)))
      .resolves.toEqual({ found: true, value: 'current' })
  })

  it('serializes repeated cutovers so the first completed target remains authoritative', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-git-storage-concurrent-'))
    roots.push(root)
    const store = new PluginStorageStore(root)
    const first = {
      packageVersion: version,
      sourceSnapshot: null,
      legacySettings: { 'agentTeam.git.logScope': 'current' },
    }
    const second = {
      ...first,
      legacySettings: { 'agentTeam.git.logScope': 'all' },
    }

    const [firstResult, secondResult] = await Promise.all([
      migrateBundledGitPreferences(store, first),
      migrateBundledGitPreferences(store, second),
    ])

    expect(firstResult).toEqual({ migrated: true, completed: true })
    expect(secondResult).toEqual({ migrated: false, completed: true })
    await expect(store.execute(readExecution('active', 'plugin', 'agentTeam.git.logScope', null)))
      .resolves.toEqual({ found: true, value: 'current' })
  })

  it('merges missing candidate values into a pre-existing active snapshot without replacing active values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-git-storage-existing-active-'))
    roots.push(root)
    const store = new PluginStorageStore(root)
    await store.execute({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'agentTeam.git.logScope', value: 'all' },
      partition: { pluginId, workspaceId: null, key: 'agentTeam.git.logScope' },
      snapshot: { pluginId, packageVersion: version, tier: 'active' },
    })

    await expect(migrateBundledGitPreferences(store, {
      packageVersion: version,
      sourceSnapshot: null,
      legacySettings: {
        'agentTeam.git.logScope': 'current',
        'git-ai-panel-width': 480,
      },
    })).resolves.toEqual({ migrated: true, completed: true })
    await expect(store.execute(readExecution('active', 'plugin', 'agentTeam.git.logScope', null)))
      .resolves.toEqual({ found: true, value: 'all' })
    await expect(store.execute(readExecution('active', 'plugin', 'git-ai-panel-width', null)))
      .resolves.toEqual({ found: true, value: 480 })
  })

  it('leaves the marker unset when an active merge is interrupted and completes on retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-git-storage-active-retry-'))
    roots.push(root)
    const store = new PluginStorageStore(root)
    await store.execute({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'agentTeam.git.logScope', value: 'all' },
      partition: { pluginId, workspaceId: null, key: 'agentTeam.git.logScope' },
      snapshot: { pluginId, packageVersion: version, tier: 'active' },
    })
    const originalExecute = store.execute.bind(store)
    const execute = vi.spyOn(store, 'execute')
    execute.mockImplementation(async (request) => {
      if (
        request.address === 'storage.set' &&
        request.snapshot.tier === 'active' &&
        request.args.key === 'git-ai-panel-width'
      ) throw new Error('simulated active merge interruption')
      return originalExecute(request)
    })

    const options = {
      packageVersion: version,
      sourceSnapshot: null,
      legacySettings: { 'git-ai-panel-width': 500 },
    }
    await expect(migrateBundledGitPreferences(store, options))
      .resolves.toEqual({ migrated: false, completed: false })
    await expect(store.execute(readExecution('active', 'plugin', '__navide_git_storage_migration_v2', null)))
      .resolves.toEqual({ found: false, value: null })

    execute.mockRestore()
    await expect(migrateBundledGitPreferences(store, options))
      .resolves.toEqual({ migrated: true, completed: true })
    await expect(store.execute(readExecution('active', 'plugin', 'git-ai-panel-width', null)))
      .resolves.toEqual({ found: true, value: 500 })
  })
})
