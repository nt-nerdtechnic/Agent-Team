import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginStorageStore } from './pluginStorage'
import { PlansStorageLifecycleSelector } from './plansStorageLifecycle'
import { migratePlansStorage } from './plansStorageMigration'
import { createPlansStorageMigrationGate } from './plansStorageMigrationGate'
import { repairPlansStorageRecord } from './plansStorageRepair'

const previousVersion = '1.0.0'
const packageVersion = '2.0.0'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'plans-storage-repair-'))
  roots.push(root)
  const store = new PluginStorageStore(join(root, 'storage'))
  const lifecyclePath = join(root, 'plans-lifecycle.json')
  const lifecycle = new PlansStorageLifecycleSelector(lifecyclePath)
  await migratePlansStorage(store, { packageVersion: previousVersion, sourceSnapshot: null })
  expect(lifecycle.rememberActive(previousVersion)).toBe(true)
  const onReady = vi.fn()
  const onFailure = vi.fn()
  const ensureStorage = createPlansStorageMigrationGate({ store, lifecycle, onReady, onFailure })
  return { lifecyclePath, lifecycle, ensureStorage, onReady, onFailure }
}

describe('Plans storage record repair', () => {
  it('makes Plans storage usable again after an unreadable record wedged the gate', async () => {
    const fixture = await setup()
    writeFileSync(fixture.lifecyclePath, '{broken')
    // The wedge this repairs: the record is unreadable, so the gate fails
    // closed and every later launch repeats the same failure.
    expect(await fixture.ensureStorage(packageVersion)).toEqual({ status: 'unavailable' })

    expect(await repairPlansStorageRecord({
      lifecycle: fixture.lifecycle,
      packageVersion,
      ensureStorage: fixture.ensureStorage,
    })).toEqual({ ok: true, repaired: true })

    // Observable outcome: the gate now completes and the record is readable
    // again, so the next launch starts from a valid record rather than the
    // same failure.
    expect(fixture.onReady).toHaveBeenCalledWith(packageVersion, null)
    expect(await fixture.ensureStorage(packageVersion)).toEqual({ status: 'ready' })
    expect(JSON.parse(readFileSync(fixture.lifecyclePath, 'utf8'))).toMatchObject({
      pluginId: 'navide.plans', packageVersion, tier: 'active',
    })
  })

  it('leaves a readable record alone instead of discarding the recovery source', async () => {
    const fixture = await setup()
    const before = readFileSync(fixture.lifecyclePath, 'utf8')

    expect(await repairPlansStorageRecord({
      lifecycle: fixture.lifecycle,
      packageVersion,
      ensureStorage: fixture.ensureStorage,
    })).toEqual({ ok: true, repaired: false })

    expect(readFileSync(fixture.lifecyclePath, 'utf8')).toBe(before)
    // The upgrade source is still reachable: the repair never ran the gate.
    expect(fixture.lifecycle.sourceFor(packageVersion)).toEqual({
      pluginId: 'navide.plans', packageVersion: previousVersion, tier: 'active',
    })
    expect(fixture.onReady).not.toHaveBeenCalled()
  })

  it('reports storage that is still unusable after the record was discarded', async () => {
    const fixture = await setup()
    writeFileSync(fixture.lifecyclePath, '{broken')

    expect(await repairPlansStorageRecord({
      lifecycle: fixture.lifecycle,
      packageVersion,
      ensureStorage: () => Promise.resolve({ status: 'unavailable' as const }),
    })).toEqual({ ok: false, repaired: true, reason: 'Plans storage is unavailable' })
  })
})
