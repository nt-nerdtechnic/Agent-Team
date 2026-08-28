import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitStorageLifecycleFileOps } from './gitStorageLifecycle'
import { GitStorageLifecycleSelector } from './gitStorageLifecycle'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Git storage lifecycle selector', () => {
  it('returns the exact previously recorded active identity', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'navide-git-lifecycle-'))
    roots.push(root)
    const selector = new GitStorageLifecycleSelector(join(root, 'nested', 'lifecycle.json'))
    expect(selector.rememberActive('2.0.0-beta.1')).toBe(true)

    expect(selector.sourceFor('1.0.0')).toEqual({
      pluginId: 'navide.git',
      packageVersion: '2.0.0-beta.1',
      tier: 'active',
    })
    expect(selector.sourceFor('2.0.0-beta.1')).toBeNull()
    expect(JSON.parse(fs.readFileSync(join(root, 'nested', 'lifecycle.json'), 'utf8'))).toEqual({
      pluginId: 'navide.git',
      packageVersion: '2.0.0-beta.1',
      tier: 'active',
    })
  })

  it('preserves the previous selector when writing the temporary file fails', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'navide-git-lifecycle-'))
    roots.push(root)
    const recordPath = join(root, 'lifecycle.json')
    const selector = new GitStorageLifecycleSelector(recordPath)
    expect(selector.rememberActive('1.0.0')).toBe(true)

    const ops = realOps({
      fsyncSync: () => { throw new Error('simulated interrupted write') },
    })
    const failed = new GitStorageLifecycleSelector(recordPath, ops).rememberActive('2.0.0')

    expect(failed).toBe(false)
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8')).packageVersion).toBe('1.0.0')
    expect(fs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('preserves the previous selector when atomic rename fails', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'navide-git-lifecycle-'))
    roots.push(root)
    const recordPath = join(root, 'lifecycle.json')
    const selector = new GitStorageLifecycleSelector(recordPath)
    expect(selector.rememberActive('1.0.0')).toBe(true)

    const ops = realOps({
      renameSync: () => { throw new Error('simulated rename interruption') },
    })
    expect(new GitStorageLifecycleSelector(recordPath, ops).rememberActive('2.0.0')).toBe(false)
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8')).packageVersion).toBe('1.0.0')
  })

  it('keeps a complete new selector when the parent directory flush fails', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'navide-git-lifecycle-'))
    roots.push(root)
    const recordPath = join(root, 'lifecycle.json')
    let fsyncCount = 0
    const ops = realOps({
      fsyncSync: (fd) => {
        fsyncCount += 1
        if (fsyncCount === 2) throw new Error('simulated directory flush interruption')
        fs.fsyncSync(fd)
      },
    })

    expect(new GitStorageLifecycleSelector(recordPath, ops).rememberActive('2.0.0-rc.1')).toBe(false)
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8')).packageVersion).toBe('2.0.0-rc.1')
  })

  it('ignores an interrupted temporary record during restart source selection', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'navide-git-lifecycle-'))
    roots.push(root)
    const recordPath = join(root, 'lifecycle.json')
    const selector = new GitStorageLifecycleSelector(recordPath)
    expect(selector.rememberActive('3.0.0-beta.2')).toBe(true)
    fs.writeFileSync(join(root, '.lifecycle.json.tmp-torn'), '{"pluginId":"navide.git"')

    const restarted = new GitStorageLifecycleSelector(recordPath)
    expect(restarted.sourceFor('3.0.0-beta.3')?.packageVersion).toBe('3.0.0-beta.2')
  })
})

function realOps(overrides: Partial<GitStorageLifecycleFileOps> = {}): GitStorageLifecycleFileOps {
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
