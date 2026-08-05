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

// An out-of-workspace open arrives as (file_ws, basename): `filepath` is
// relative to `file_ws`, not to the window's workspace. index.ts picks the root
// with `params.file_ws || workspacePath` before calling in here; these tests pin
// what each choice resolves to, so a regression that drops file_ws is visible as
// "opened the wrong file / opened nothing".
describe('resolveExternalOpenTarget – out-of-workspace opens (file_ws as the root)', () => {
  const workspace = join('/tmp', 'editor-fallback-ws')
  const external = join('/tmp', 'editor-fallback-ext')
  const always = () => true

  it('resolves a basename against the file own root (file_ws)', () => {
    expect(resolveExternalOpenTarget(external, 'notes.txt', always)).toBe(
      resolve(external, 'notes.txt')
    )
  })

  it('resolves the same basename to a DIFFERENT file when the workspace is used as root', () => {
    // Exactly the damage of ignoring file_ws: a real path, but the wrong file.
    expect(resolveExternalOpenTarget(workspace, 'notes.txt', always)).not.toBe(
      resolveExternalOpenTarget(external, 'notes.txt', always)
    )
  })

  it('returns null when the workspace copy does not exist (open silently does nothing)', () => {
    // The usual shape of the bug: /ws has no notes.txt, so the fallback finds
    // nothing to hand to the OS and drops to the "unavailable" dialog.
    const exists = (p: string): boolean => p === resolve(external, 'notes.txt')
    expect(resolveExternalOpenTarget(workspace, 'notes.txt', exists)).toBeNull()
    expect(resolveExternalOpenTarget(external, 'notes.txt', exists)).toBe(
      resolve(external, 'notes.txt')
    )
  })

  // `file_ws: '/'` is reachable in production — ⌘O on /notes.txt and a ⌘-click
  // on a filesystem-root path both emit it — and the containment check must not
  // demand a '//' prefix for that root.
  it('resolves against the filesystem root when file_ws is /', () => {
    expect(resolveExternalOpenTarget('/', 'notes.txt', always)).toBe('/notes.txt')
  })

  it('applies the same containment rule to an external root', () => {
    expect(resolveExternalOpenTarget(external, '../outside.txt', always)).toBeNull()
    expect(resolveExternalOpenTarget(external, '.', always)).toBeNull()
  })

  it('still classifies an open carrying file_ws as a plain file open', () => {
    // The OS-default-app branch is what handles it; file_ws must not push the
    // request into the diff/bare branches.
    expect(classifyEditorOpen({ filepath: 'notes.txt', file_ws: external })).toBe('file')
    expect(classifyEditorOpen({ file_ws: external })).toBe('bare')
  })
})
