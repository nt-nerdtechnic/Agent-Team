import { describe, it, expect } from 'vitest'
import { join, resolve } from 'node:path'
import { classifyEditorOpen, resolveExternalOpenTarget } from './editor-fallback'

describe('classifyEditorOpen', () => {
  it('classifies a plain file open', () => {
    expect(classifyEditorOpen({ filepath: 'src/app.ts', line: '12' })).toBe('file')
  })

  it('classifies a diff open even when filepath is absent', () => {
    expect(classifyEditorOpen({ diff_filepath: 'src/app.ts', diff_staged: '1', sidebar: 'git' })).toBe('diff')
  })

  it('classifies a branch-diff open', () => {
    expect(classifyEditorOpen({ branch_diff_base: 'main', branch_diff_compare: 'feature' })).toBe('diff')
  })

  it('diff wins over filepath when both are present', () => {
    expect(classifyEditorOpen({ filepath: 'src/app.ts', diff_filepath: 'src/app.ts' })).toBe('diff')
  })

  it('classifies a bare open (no filepath, e.g. sidebar only)', () => {
    expect(classifyEditorOpen({ sidebar: 'files' })).toBe('bare')
    expect(classifyEditorOpen({})).toBe('bare')
  })

  it('treats an empty filepath as bare', () => {
    expect(classifyEditorOpen({ filepath: '' })).toBe('bare')
  })
})

describe('resolveExternalOpenTarget', () => {
  const workspace = join('/tmp', 'editor-fallback-ws')
  const always = () => true

  it('resolves a workspace-relative path', () => {
    expect(resolveExternalOpenTarget(workspace, 'src/app.ts', always)).toBe(
      resolve(workspace, 'src/app.ts')
    )
  })

  it('returns null when workspace or filepath is empty', () => {
    expect(resolveExternalOpenTarget('', 'src/app.ts', always)).toBeNull()
    expect(resolveExternalOpenTarget(workspace, '', always)).toBeNull()
  })

  it('rejects ../ escapes out of the workspace', () => {
    expect(resolveExternalOpenTarget(workspace, '../outside.txt', always)).toBeNull()
    expect(resolveExternalOpenTarget(workspace, 'src/../../outside.txt', always)).toBeNull()
  })

  it('rejects the workspace root itself', () => {
    expect(resolveExternalOpenTarget(workspace, '.', always)).toBeNull()
  })

  it('allows internal ../ that stays inside the workspace', () => {
    expect(resolveExternalOpenTarget(workspace, 'src/../README.md', always)).toBe(
      resolve(workspace, 'README.md')
    )
  })

  it('returns null when the file does not exist on disk', () => {
    expect(resolveExternalOpenTarget(workspace, 'src/app.ts', () => false)).toBeNull()
  })

  it('uses existsSync by default (missing file on real disk)', () => {
    expect(resolveExternalOpenTarget(workspace, 'definitely-not-there-3f1a.txt')).toBeNull()
  })
})
