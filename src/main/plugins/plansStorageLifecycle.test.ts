import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlansStorageLifecycleFileOps } from './plansStorageLifecycle'
import { PlansStorageLifecycleSelector } from './plansStorageLifecycle'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Plans storage lifecycle selector', () => {
  it.each(['unreadable', 'corrupt'] as const)('does not treat an %s record as first install', (failure) => {
    const operations = realOperations({ readFileSync: () => {
      if (failure === 'corrupt') return '{broken'
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    } })
    const selector = new PlansStorageLifecycleSelector('/unused/lifecycle.json', operations)
    expect(() => selector.sourceFor('0.1.94')).toThrow()
  })

  it('clears the selector when plugin storage is removed', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'navide-plans-lifecycle-'))
    roots.push(root)
    const selector = new PlansStorageLifecycleSelector(join(root, 'lifecycle.json'))
    selector.rememberActive('0.1.93')
    selector.clear()
    expect(selector.sourceFor('0.1.94')).toBeNull()
    expect(() => selector.clear()).not.toThrow()
  })

  it('does not retain a missing source after successful empty migration', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'navide-plans-lifecycle-'))
    roots.push(root)
    const selector = new PlansStorageLifecycleSelector(join(root, 'lifecycle.json'))
    selector.rememberActive('0.1.93')
    selector.rememberActive('0.1.94', null)
    expect(selector.sourceFor('0.1.94')).toBeNull()
  })

  it('returns the exact previously recorded active identity', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'navide-plans-lifecycle-'))
    roots.push(root)
    const selector = new PlansStorageLifecycleSelector(join(root, 'nested', 'lifecycle.json'))
    expect(selector.rememberActive('0.1.93')).toBe(true)
    expect(selector.sourceFor('0.1.94')).toEqual({
      pluginId: 'navide.plans',
      packageVersion: '0.1.93',
      tier: 'active',
    })
    expect(selector.sourceFor('0.1.93')).toBeNull()
  })

  it('retains the displaced active identity after promoting the current package', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'navide-plans-lifecycle-'))
    roots.push(root)
    const selector = new PlansStorageLifecycleSelector(join(root, 'lifecycle.json'))

    expect(selector.rememberActive('0.1.93')).toBe(true)
    expect(selector.rememberActive('0.1.94')).toBe(true)
    expect(selector.sourceFor('0.1.94')).toEqual({
      pluginId: 'navide.plans',
      packageVersion: '0.1.93',
      tier: 'active',
    })
  })

  it('keeps the previous selector when the atomic write fails', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'navide-plans-lifecycle-'))
    roots.push(root)
    const recordPath = join(root, 'lifecycle.json')
    const selector = new PlansStorageLifecycleSelector(recordPath)
    expect(selector.rememberActive('0.1.93')).toBe(true)
    const operations = realOperations({ fsyncSync: () => { throw new Error('interrupted') } })
    expect(new PlansStorageLifecycleSelector(recordPath, operations).rememberActive('0.1.94')).toBe(false)
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8')).packageVersion).toBe('0.1.93')
    expect(fs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([])
  })
})

function realOperations(overrides: Partial<PlansStorageLifecycleFileOps> = {}): PlansStorageLifecycleFileOps {
  return {
    mkdirSync: (path, options) => { fs.mkdirSync(path, options) },
    openSync: (path, flags, mode) => fs.openSync(path, flags, mode),
    writeSync: (fd, buffer, offset, length, position) => fs.writeSync(fd, buffer, offset, length, position),
    fsyncSync: (fd) => fs.fsyncSync(fd),
    closeSync: (fd) => fs.closeSync(fd),
    renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
    unlinkSync: (path) => fs.unlinkSync(path),
    readFileSync: (path, encoding) => fs.readFileSync(path, encoding),
    ...overrides,
  }
}
