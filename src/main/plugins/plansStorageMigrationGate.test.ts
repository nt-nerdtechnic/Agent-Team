import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MissingStorageSnapshotError, PluginStorageStore } from './pluginStorage'
import { PlansStorageLifecycleSelector } from './plansStorageLifecycle'
import { migratePlansStorage, projectLegacyPlansPreferences, runPlansLegacyRecovery } from './plansStorageMigration'
import { createPlansStorageMigrationGate } from './plansStorageMigrationGate'
import { retainedPlansLegacyAdapter } from './plansLegacyAdapter'

const pluginId = 'navide.plans'
const previousVersion = '1.0.0'
const packageVersion = '2.0.0'
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(previous = true) {
  const root = mkdtempSync(join(tmpdir(), 'plans-migration-gate-'))
  roots.push(root)
  const storageRoot = join(root, 'storage')
  const store = new PluginStorageStore(storageRoot)
  const lifecyclePath = join(root, 'lifecycle.json')
  const lifecycle = new PlansStorageLifecycleSelector(lifecyclePath)
  if (previous) {
    await migratePlansStorage(store, { packageVersion: previousVersion, sourceSnapshot: null })
    await projectLegacyPlansPreferences(store, {
      packageVersion: previousVersion, workspaceId: 'workspace', values: { 'plans.sort': 'title' },
    })
    expect(lifecycle.rememberActive(previousVersion)).toBe(true)
  }
  const onReady = vi.fn()
  const onFailure = vi.fn()
  const ensure = createPlansStorageMigrationGate({ store, lifecycle, onReady, onFailure })
  const recover = () => runPlansLegacyRecovery(store, lifecycle, {
    currentPackageVersion: packageVersion, workspaceId: 'workspace', adapter: retainedPlansLegacyAdapter,
  })
  return { root, storageRoot, lifecyclePath, store, lifecycle, ensure, onReady, onFailure, recover }
}

describe('Plans storage migration admission', () => {
  it.each(['clone', 'promotion', 'remember-false', 'remember-throw'] as const)(
    'recovers the previous snapshot and never publishes context after %s failure', async (failure) => {
      const fixture = await setup()
      if (failure === 'clone' || failure === 'promotion') {
        const clone = fixture.store.cloneSnapshot.bind(fixture.store)
        vi.spyOn(fixture.store, 'cloneSnapshot').mockImplementation((source, target) => {
          if (failure === 'clone' || target.tier === 'active') return Promise.reject(new Error('disk failure'))
          return clone(source, target)
        })
      } else if (failure === 'remember-false') {
        vi.spyOn(fixture.lifecycle, 'rememberActive').mockReturnValue(false)
      } else {
        vi.spyOn(fixture.lifecycle, 'rememberActive').mockImplementation(() => { throw new Error('disk failure') })
      }
      expect(await fixture.ensure(packageVersion)).toEqual({ status: 'recovery' })
      expect(fixture.onReady).not.toHaveBeenCalled()
      expect(fixture.onFailure).toHaveBeenCalledOnce()
      expect(await fixture.recover()).toMatchObject({
        sourcePackageVersion: previousVersion, result: { preferences: { 'plans.sort': 'title' } },
      })
    },
  )

  it.each(['unreadable', 'corrupt'] as const)('fails closed on %s lifecycle without touching snapshots', async (failure) => {
    const fixture = await setup()
    if (failure === 'unreadable') {
      vi.spyOn(fixture.lifecycle, 'sourceFor').mockImplementation(() => { throw new Error('permission denied') })
    } else writeFileSync(fixture.lifecyclePath, '{broken')
    const clone = vi.spyOn(fixture.store, 'cloneSnapshot')
    expect(await fixture.ensure(packageVersion)).toEqual({ status: 'unavailable' })
    expect(clone).not.toHaveBeenCalled()
    expect(fixture.onReady).not.toHaveBeenCalled()
  })

  it('rejects a corrupt selected snapshot instead of presenting empty legacy recovery', async () => {
    const fixture = await setup()
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    writeFileSync(join(fixture.storageRoot, hash(pluginId), hash(previousVersion), 'active', 'plugin.json'), '{broken')
    expect(await fixture.ensure(packageVersion)).toEqual({ status: 'unavailable' })
    expect(fixture.onReady).not.toHaveBeenCalled()
    await expect(fixture.recover()).rejects.toThrow()
  })

  it('distinguishes an absent recovery source from a readable empty snapshot', async () => {
    const fixture = await setup(false)
    fixture.lifecycle.rememberActive(previousVersion)
    await expect(fixture.recover()).rejects.toBeInstanceOf(MissingStorageSnapshotError)
    expect(await fixture.ensure(packageVersion)).toEqual({ status: 'ready' })
    expect(fixture.onReady).toHaveBeenCalledWith(packageVersion, null)
  })

  it('does not publish an existing active snapshot with a valid marker and corrupt workspace partition', async () => {
    const fixture = await setup()
    expect(await fixture.ensure(packageVersion)).toEqual({ status: 'ready' })
    fixture.onReady.mockClear()
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    writeFileSync(join(fixture.storageRoot, hash(pluginId), hash(packageVersion), 'active', 'workspaces', `${hash('workspace')}.json`), '{broken')
    expect(await fixture.ensure(packageVersion)).toEqual({ status: 'recovery' })
    expect(fixture.onReady).not.toHaveBeenCalled()
    expect(await fixture.recover()).toMatchObject({
      sourcePackageVersion: previousVersion, result: { preferences: { 'plans.sort': 'title' } },
    })
  })

  it('shares the startup promise with first open and publishes only after persistence', async () => {
    const fixture = await setup()
    const clone = fixture.store.cloneSnapshot.bind(fixture.store)
    let release!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    const cloneSpy = vi.spyOn(fixture.store, 'cloneSnapshot').mockImplementation(async (source, target) => {
      await paused
      return clone(source, target)
    })
    const startup = fixture.ensure(packageVersion)
    expect(fixture.ensure(packageVersion)).toBe(startup)
    await Promise.resolve()
    expect(fixture.onReady).not.toHaveBeenCalled()
    release()
    expect(await startup).toEqual({ status: 'ready' })
    expect(cloneSpy).toHaveBeenCalledTimes(2)
    expect(fixture.lifecycle.sourceFor(packageVersion)?.packageVersion).toBe(previousVersion)
    expect(fixture.onReady).toHaveBeenCalledWith(packageVersion, previousVersion)
  })

  it('initializes fresh installs and reruns after same-version storage reset', async () => {
    const fixture = await setup(false)
    expect(await fixture.ensure(packageVersion)).toEqual({ status: 'ready' })
    rmSync(fixture.storageRoot, { recursive: true, force: true })
    fixture.lifecycle.clear()
    const clone = vi.spyOn(fixture.store, 'cloneSnapshot')
    expect(await fixture.ensure(packageVersion)).toEqual({ status: 'ready' })
    expect(clone).toHaveBeenCalledOnce()
    await fixture.store.assertSnapshotReadable({ pluginId, packageVersion, tier: 'active' })
  })

  it('does not offer recovery when first-install persistence fails', async () => {
    const fixture = await setup(false)
    vi.spyOn(fixture.lifecycle, 'rememberActive').mockReturnValue(false)
    expect(await fixture.ensure(packageVersion)).toEqual({ status: 'unavailable' })
    expect(fixture.onReady).not.toHaveBeenCalled()
  })
})
