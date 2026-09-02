import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolvePlansRootPath } from './plansRoot'

describe('resolvePlansRootPath', () => {
  it('uses the nearest repository root for a nested workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-root-'))
    const nested = join(root, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    mkdirSync(join(root, '.git'))
    try {
      expect(resolvePlansRootPath(nested)).toBe(realpathSync(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts a linked-worktree .git file as a repository marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-root-'))
    const nested = join(root, 'src')
    mkdirSync(nested)
    writeFileSync(join(root, '.git'), 'gitdir: /private/git/worktree')
    try {
      expect(resolvePlansRootPath(nested)).toBe(realpathSync(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a non-repository workspace unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-root-'))
    try {
      expect(resolvePlansRootPath(root)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
