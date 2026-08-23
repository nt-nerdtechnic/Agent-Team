// The preview contract is the trust boundary for agent- and plugin-pushed
// payloads (MCP ui.preview.show, plugin capability). Everything here pins a
// case where accepting bad input would surface as a broken or unsafe panel.
import { describe, it, expect } from 'vitest'
import {
  MAX_INLINE_CONTENT,
  asAgentPush,
  normalizePreviewTarget,
  previewSubtitle,
  previewTitle,
} from '../previewTarget'

describe('normalizePreviewTarget', () => {
  it('accepts a file target and drops unknown extras', () => {
    const t = normalizePreviewTarget({
      kind: 'file',
      workspacePath: '/ws',
      relPath: 'src/a.ts',
      bogus: 'ignored',
    })
    expect(t).toEqual({ kind: 'file', workspacePath: '/ws', relPath: 'src/a.ts', source: undefined, origin: undefined })
  })

  it('rejects a file target missing either path', () => {
    expect(normalizePreviewTarget({ kind: 'file', workspacePath: '/ws' })).toBeNull()
    expect(normalizePreviewTarget({ kind: 'file', relPath: 'a.ts' })).toBeNull()
    expect(normalizePreviewTarget({ kind: 'file', workspacePath: '', relPath: 'a.ts' })).toBeNull()
  })

  it('coerces diff flags rather than trusting them', () => {
    const t = normalizePreviewTarget({
      kind: 'diff',
      workspacePath: '/ws',
      relPath: 'a.ts',
      staged: 'yes',
    })
    // A truthy-but-not-true value must not silently become a staged diff.
    expect(t).toMatchObject({ kind: 'diff', staged: false })
  })

  it('keeps a commit hash when given', () => {
    expect(
      normalizePreviewTarget({ kind: 'diff', workspacePath: '/ws', relPath: 'a.ts', commit: 'abc1234' }),
    ).toMatchObject({ commit: 'abc1234' })
  })

  it('accepts inline kinds and preserves content verbatim', () => {
    const html = '<p>hi</p>'
    expect(normalizePreviewTarget({ kind: 'html', content: html })).toMatchObject({
      kind: 'html',
      content: html,
    })
    expect(normalizePreviewTarget({ kind: 'markdown', content: '# t' })).toMatchObject({ kind: 'markdown' })
    expect(normalizePreviewTarget({ kind: 'snippet', content: 'x', lang: 'ts' })).toMatchObject({ lang: 'ts' })
  })

  it('accepts empty inline content', () => {
    // An agent producing an empty result should render an empty panel, not an
    // error toast.
    expect(normalizePreviewTarget({ kind: 'snippet', content: '' })).toMatchObject({ content: '' })
  })

  it('rejects oversized inline content', () => {
    const big = 'a'.repeat(MAX_INLINE_CONTENT + 1)
    expect(normalizePreviewTarget({ kind: 'snippet', content: big })).toBeNull()
  })

  it('rejects unknown kinds and non-objects', () => {
    expect(normalizePreviewTarget({ kind: 'exec', content: 'rm -rf /' })).toBeNull()
    expect(normalizePreviewTarget(null)).toBeNull()
    expect(normalizePreviewTarget('file')).toBeNull()
    expect(normalizePreviewTarget(undefined)).toBeNull()
  })

  it('only accepts known source values', () => {
    expect(normalizePreviewTarget({ kind: 'markdown', content: 'x', source: 'agent' })).toMatchObject({
      source: 'agent',
    })
    expect(normalizePreviewTarget({ kind: 'markdown', content: 'x', source: 'root' })).toMatchObject({
      source: undefined,
    })
  })
})

describe('display helpers', () => {
  it('titles a file target with its basename', () => {
    expect(previewTitle({ kind: 'file', workspacePath: '/ws', relPath: 'a/b/c.png' })).toBe('c.png')
  })

  it('labels diff provenance so the footer cannot be misread', () => {
    const base = { kind: 'diff', workspacePath: '/ws', relPath: 'a.ts' } as const
    expect(previewSubtitle({ ...base })).toContain('working tree')
    expect(previewSubtitle({ ...base, staged: true })).toContain('staged')
    expect(previewSubtitle({ ...base, commit: 'abcdef1234' })).toContain('abcdef1')
  })
})

describe('asAgentPush', () => {
  it('stamps agent attribution on a payload that omitted it', () => {
    // Without this an agent could just leave `source` out and its push would
    // render exactly like a file the user opened.
    const t = asAgentPush({ kind: 'markdown', content: '# t' })
    expect(t).toMatchObject({ source: 'agent', origin: 'MCP' })
  })

  it('overrides a payload that claims to be a user action', () => {
    const t = asAgentPush({ kind: 'markdown', content: '# t', source: 'user' })
    expect(t.source).toBe('agent')
  })

  it('keeps a self-reported origin as the label but never the source', () => {
    const t = asAgentPush({ kind: 'markdown', content: '# t', source: 'user', origin: 'claude' })
    expect(t).toMatchObject({ source: 'agent', origin: 'claude' })
  })

  it('does not otherwise alter the target', () => {
    const t = asAgentPush({ kind: 'diff', workspacePath: '/ws', relPath: 'a.ts', staged: true })
    expect(t).toMatchObject({ kind: 'diff', workspacePath: '/ws', relPath: 'a.ts', staged: true })
  })
})
