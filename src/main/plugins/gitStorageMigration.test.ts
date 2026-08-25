import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
  it('copies allowlisted legacy values, promotes a candidate, and preserves the target on retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-git-storage-'))
    roots.push(root)
    const store = new PluginStorageStore(root)
    const options = {
      packageVersion: version,
      sourceSnapshot: null,
      workspaceId: 'workspace-1',
      workspacePath: '/workspace/project',
      legacySettings: {
        'agentTeam.git.logScope': 'current',
        'agentTeam.gitTabRepo./workspace/project': 'repo-a',
        'agentTeam.unrelated': 'must-not-copy',
      },
    }

    await expect(migrateBundledGitPreferences(store, options)).resolves.toEqual({ migrated: true, completed: true })
    await expect(store.execute(readExecution('active', 'plugin', 'agentTeam.git.logScope', null)))
      .resolves.toEqual({ found: true, value: 'current' })
    await expect(store.execute(readExecution('active', 'workspace', 'agentTeam.gitTabRepo', 'workspace-1')))
      .resolves.toEqual({ found: true, value: 'repo-a' })
    await expect(store.execute(readExecution('active', 'plugin', 'agentTeam.unrelated', null)))
      .resolves.toEqual({ found: false, value: null })

    await expect(migrateBundledGitPreferences(store, {
      ...options,
      workspaceId: 'workspace-2',
      workspacePath: '/workspace/other-project',
      legacySettings: { 'agentTeam.gitTabRepo./workspace/other-project': 'repo-b' },
    })).resolves.toEqual({ migrated: true, completed: true })
    await expect(store.execute(readExecution('active', 'workspace', 'agentTeam.gitTabRepo', 'workspace-2')))
      .resolves.toEqual({ found: true, value: 'repo-b' })
    await expect(store.execute(readExecution('active', 'workspace', 'agentTeam.gitTabRepo', 'workspace-1')))
      .resolves.toEqual({ found: true, value: 'repo-a' })

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
      workspaceId: 'workspace-1',
      workspacePath: '/workspace/project',
      legacySettings: { 'agentTeam.git.logScope': 'all' },
    })

    await migrateBundledGitPreferences(store, {
      packageVersion: version,
      sourceSnapshot: {
        pluginId,
        packageVersion: previousVersion,
        tier: 'active',
      },
      workspaceId: 'workspace-1',
      workspacePath: '/workspace/project',
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
      workspaceId: null,
      workspacePath: '',
      legacySettings: { 'agentTeam.git.logScope': 'all' },
    })

    await migrateBundledGitPreferences(store, {
      packageVersion: '0.1.90-beta.1',
      sourceSnapshot: null,
      workspaceId: null,
      workspacePath: '',
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
})
