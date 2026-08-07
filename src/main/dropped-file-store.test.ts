import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isSystemTempPath,
  stabilizeDroppedPaths,
  pruneDroppedFiles,
  DROPPED_FILE_MAX_AGE_MS
} from './dropped-file-store'

// The store's whole job is surviving macOS reclaiming its temp directory, so
// these tests use real files under the real temp root rather than mocking fs.
let sandbox: string
let store: string

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'drop-test-'))
  store = join(sandbox, 'store')
})

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

describe('isSystemTempPath', () => {
  it('accepts a path inside the system temp root', () => {
    expect(isSystemTempPath(join(sandbox, 'shot.png'))).toBe(true)
  })

  it('rejects a path outside it', () => {
    expect(isSystemTempPath('/Users/test/Desktop/shot.png')).toBe(false)
  })

  it('rejects the temp root itself, not just its children', () => {
    expect(isSystemTempPath(tmpdir())).toBe(false)
  })

  it('treats /var and /private/var as the same root', () => {
    // macOS resolves /var → /private/var; a naive prefix test would miss.
    expect(isSystemTempPath('/private/var/x', '/var')).toBe(isSystemTempPath('/var/x', '/var'))
  })
})

describe('stabilizeDroppedPaths', () => {
  it('copies a temp file into the store and survives the original going away', async () => {
    const source = join(sandbox, 'Screenshot 2026-08-07.png')
    await writeFile(source, 'png-bytes')

    const [stable] = await stabilizeDroppedPaths([source], store)

    expect(stable).not.toBe(source)
    expect(stable.startsWith(store)).toBe(true)
    // The filename is what the agent sees — keep it recognisable.
    expect(stable.endsWith('Screenshot 2026-08-07.png')).toBe(true)

    // This is the actual bug: macOS moves the capture out from under us.
    await rm(source)
    expect(await readFile(stable, 'utf8')).toBe('png-bytes')
  })

  it('leaves paths outside temp untouched', async () => {
    expect(await stabilizeDroppedPaths(['/Users/test/notes.md'], store)).toEqual([
      '/Users/test/notes.md'
    ])
    expect(existsSync(store)).toBe(false)
  })

  it('leaves a temp directory untouched rather than deep-copying it', async () => {
    const dir = join(sandbox, 'a-folder')
    await mkdir(dir)
    expect(await stabilizeDroppedPaths([dir], store)).toEqual([dir])
  })

  it('keeps both copies when two drops share a filename', async () => {
    const first = join(sandbox, 'one', 'shot.png')
    const second = join(sandbox, 'two', 'shot.png')
    await mkdir(join(sandbox, 'one'))
    await mkdir(join(sandbox, 'two'))
    await writeFile(first, 'first')
    await writeFile(second, 'second')

    const [a] = await stabilizeDroppedPaths([first], store)
    const [b] = await stabilizeDroppedPaths([second], store)

    expect(a).not.toBe(b)
    expect(b.endsWith('shot-2.png')).toBe(true)
    expect(await readFile(a, 'utf8')).toBe('first')
    expect(await readFile(b, 'utf8')).toBe('second')
  })

  it('falls back to the original path when the copy cannot be made', async () => {
    const missing = join(sandbox, 'gone.png')
    expect(await stabilizeDroppedPaths([missing], store)).toEqual([missing])
  })

  it('preserves order and length across a mixed batch', async () => {
    const temp = join(sandbox, 'shot.png')
    await writeFile(temp, 'x')
    const result = await stabilizeDroppedPaths(['/Users/test/a.ts', temp, '/Users/test/b.ts'], store)
    expect(result).toHaveLength(3)
    expect(result[0]).toBe('/Users/test/a.ts')
    expect(result[2]).toBe('/Users/test/b.ts')
    expect(result[1].startsWith(store)).toBe(true)
  })
})

describe('pruneDroppedFiles', () => {
  it('removes copies past the age limit and keeps fresh ones', async () => {
    await mkdir(store, { recursive: true })
    const old = join(store, 'old.png')
    const fresh = join(store, 'fresh.png')
    await writeFile(old, 'old')
    await writeFile(fresh, 'fresh')
    const staleSec = (Date.now() - DROPPED_FILE_MAX_AGE_MS - 60_000) / 1000
    await utimes(old, staleSec, staleSec)

    await pruneDroppedFiles(store)

    expect(await readdir(store)).toEqual(['fresh.png'])
  })

  it('is a no-op when the store was never created', async () => {
    await expect(pruneDroppedFiles(join(sandbox, 'nope'))).resolves.toBeUndefined()
  })
})
