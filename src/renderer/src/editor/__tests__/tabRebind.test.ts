import { describe, it, expect } from 'vitest'
import { rebindPath, rebindTabs } from '../tabRebind'

describe('rebindPath', () => {
  it('maps an exact file rename in the same directory', () => {
    expect(rebindPath('src/a.ts', 'src/a.ts', 'src/b.ts')).toBe('src/b.ts')
  })

  it('maps a file move into another directory', () => {
    expect(rebindPath('a.ts', 'a.ts', 'src/a.ts')).toBe('src/a.ts')
  })

  it('maps a file move to the workspace root', () => {
    expect(rebindPath('src/deep/a.ts', 'src/deep/a.ts', 'a.ts')).toBe('a.ts')
  })

  it('rewrites paths under a renamed folder', () => {
    expect(rebindPath('src/old/deep/a.ts', 'src/old', 'src/new')).toBe('src/new/deep/a.ts')
  })

  it('rewrites the folder path itself', () => {
    expect(rebindPath('src/old', 'src/old', 'src/new')).toBe('src/new')
  })

  it('returns null for unrelated paths', () => {
    expect(rebindPath('lib/x.ts', 'src/old', 'src/new')).toBeNull()
  })

  it('does not treat a sibling sharing the prefix as a match (src/a vs src/ab)', () => {
    expect(rebindPath('src/ab/x.ts', 'src/a', 'src/z')).toBeNull()
    expect(rebindPath('src/ab', 'src/a', 'src/z')).toBeNull()
  })

  it('handles nested rename where old and new share ancestry', () => {
    expect(rebindPath('src/a/b/c.ts', 'src/a/b', 'src/a/b2')).toBe('src/a/b2/c.ts')
  })
})

describe('rebindTabs', () => {
  const tab = (relPath: string, kind = 'file') => ({
    kind,
    relPath,
    name: relPath.split('/').pop() || relPath,
  })

  it('rewrites relPath and name of the renamed file tab, in place', () => {
    const t = tab('src/a.ts')
    const moved = rebindTabs([t], 'src/a.ts', 'src/b.ts')
    expect(moved).toHaveLength(1)
    expect(moved[0].prevRelPath).toBe('src/a.ts')
    expect(moved[0].tab).toBe(t)
    expect(t.relPath).toBe('src/b.ts')
    expect(t.name).toBe('b.ts')
  })

  it('rewrites every open tab under a renamed folder and no others', () => {
    const inside = tab('src/old/a.ts')
    const nested = tab('src/old/deep/b.ts')
    const outside = tab('lib/c.ts')
    const sibling = tab('src/oldish/d.ts')
    const moved = rebindTabs([inside, nested, outside, sibling], 'src/old', 'pkg/new')
    expect(moved.map((m) => m.prevRelPath)).toEqual(['src/old/a.ts', 'src/old/deep/b.ts'])
    expect(inside.relPath).toBe('pkg/new/a.ts')
    expect(nested.relPath).toBe('pkg/new/deep/b.ts')
    expect(nested.name).toBe('b.ts')
    expect(outside.relPath).toBe('lib/c.ts')
    expect(sibling.relPath).toBe('src/oldish/d.ts')
  })

  it('keeps the basename when a file is moved between directories', () => {
    const t = tab('a.ts')
    rebindTabs([t], 'a.ts', 'src/sub/a.ts')
    expect(t.relPath).toBe('src/sub/a.ts')
    expect(t.name).toBe('a.ts')
  })

  it('ignores non-file tabs even when their synthetic key would prefix-match', () => {
    const diff = { kind: 'diff', relPath: 'src/a.ts', name: 'a.ts' }
    const moved = rebindTabs([diff], 'src/a.ts', 'src/b.ts')
    expect(moved).toHaveLength(0)
    expect(diff.relPath).toBe('src/a.ts')
  })

  it('returns an empty list when nothing matches', () => {
    const t = tab('src/a.ts')
    expect(rebindTabs([t], 'other/x.ts', 'other/y.ts')).toEqual([])
    expect(t.relPath).toBe('src/a.ts')
  })

  it('leaves tabs from another workspace alone even on an identical relPath', () => {
    const inside = tab('notes.md')
    const outside = { ...tab('notes.md'), wsPath: '/ext/dir' }
    const moved = rebindTabs([inside, outside], 'notes.md', 'renamed.md')
    expect(moved.map((m) => m.tab)).toEqual([inside])
    expect(inside.relPath).toBe('renamed.md')
    // Rewriting this would silently redirect the tab's next save.
    expect(outside.relPath).toBe('notes.md')
    expect(outside.name).toBe('notes.md')
  })

  it('rebinds only the tabs of the workspace the rename happened in', () => {
    const inside = tab('notes.md')
    const outside = { ...tab('notes.md'), wsPath: '/ext/dir' }
    const other = { ...tab('notes.md'), wsPath: '/other/dir' }
    const moved = rebindTabs([inside, outside, other], 'notes.md', 'renamed.md', '/ext/dir')
    expect(moved.map((m) => m.tab)).toEqual([outside])
    expect(outside.relPath).toBe('renamed.md')
    expect(inside.relPath).toBe('notes.md')
    expect(other.relPath).toBe('notes.md')
  })
})
