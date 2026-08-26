// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mergePreferredPath, expandHomePath, collapseHomePath, extractPlanDocRelPath, type PickerItem } from '../useTerminal'

const item = (abs: string): PickerItem => {
  const parts = abs.split('/')
  const name = parts.pop() ?? abs
  return { abs, name, dir: parts.join('/') }
}

// The exact bug-report path: a file on the Desktop, outside any workspace.
const PDF = '/Users/neillu/Desktop/NT-CRM系統說明書.pdf'

describe('mergePreferredPath', () => {
  it('surfaces the click-resolved path when the search found nothing (no workspace / outside it)', () => {
    // This is the screenshot case: workspace search returns [] (pane has no
    // workspace, or the file lives outside it), but the click already stat'd
    // the path as existing — it must still appear instead of "No files found".
    const out = mergePreferredPath([], PDF, true)
    expect(out).toEqual([{ abs: PDF, name: 'NT-CRM系統說明書.pdf', dir: '/Users/neillu/Desktop' }])
  })

  it('inserts the preferred path at the front when results omit it', () => {
    const results = [item('/ws/a.ts'), item('/ws/b.ts')]
    const out = mergePreferredPath(results, PDF, true)
    expect(out[0].abs).toBe(PDF)
    expect(out.map((i) => i.abs)).toEqual([PDF, '/ws/a.ts', '/ws/b.ts'])
  })

  it('pulls the preferred path to the front when results already contain it', () => {
    const results = [item('/ws/a.ts'), item('/ws/hit.ts'), item('/ws/b.ts')]
    const out = mergePreferredPath(results, '/ws/hit.ts', true)
    expect(out.map((i) => i.abs)).toEqual(['/ws/hit.ts', '/ws/a.ts', '/ws/b.ts'])
  })

  it('leaves results untouched when the preferred path is already first', () => {
    const results = [item('/ws/hit.ts'), item('/ws/a.ts')]
    const out = mergePreferredPath(results, '/ws/hit.ts', true)
    expect(out).toBe(results) // same reference — no copy, no reorder
  })

  it('does not insert the preferred path once the user types a new query', () => {
    const results = [item('/ws/a.ts')]
    expect(mergePreferredPath(results, PDF, false)).toBe(results)
  })

  it('returns results unchanged when there is no preferred path', () => {
    const results = [item('/ws/a.ts')]
    expect(mergePreferredPath(results, undefined, true)).toBe(results)
  })
})

// The bug-report path: a '~/'-prefixed link in terminal output was glued to
// the workspace root instead of the home directory, so stat failed and the
// picker showed "No files found" for an existing file.
describe('expandHomePath', () => {
  it('expands ~/ against the home directory', () => {
    expect(expandHomePath('~/.cloudflared/ida_cert.pem', '/Users/u'))
      .toBe('/Users/u/.cloudflared/ida_cert.pem')
  })

  it('expands bare ~', () => {
    expect(expandHomePath('~', '/Users/u')).toBe('/Users/u')
  })

  it('tolerates a trailing slash on home', () => {
    expect(expandHomePath('~/x', '/Users/u/')).toBe('/Users/u/x')
  })

  it('leaves relative, absolute, and ~user paths alone', () => {
    expect(expandHomePath('src/a.ts', '/Users/u')).toBe('src/a.ts')
    expect(expandHomePath('/etc/hosts', '/Users/u')).toBe('/etc/hosts')
    expect(expandHomePath('~other/x', '/Users/u')).toBe('~other/x')
  })

  it('is a no-op when home is unknown', () => {
    expect(expandHomePath('~/x', '')).toBe('~/x')
  })
})

describe('collapseHomePath', () => {
  it('collapses the home prefix back to ~ for display', () => {
    expect(collapseHomePath('/Users/u/.cloudflared', '/Users/u')).toBe('~/.cloudflared')
  })

  it('collapses home itself to ~', () => {
    expect(collapseHomePath('/Users/u', '/Users/u')).toBe('~')
  })

  it('does not collapse a sibling directory sharing the prefix string', () => {
    expect(collapseHomePath('/Users/u2/x', '/Users/u')).toBe('/Users/u2/x')
  })

  it('is a no-op when home is unknown', () => {
    expect(collapseHomePath('/Users/u/x', '')).toBe('/Users/u/x')
  })
})

// cmd+click on a plan doc reference routes to the plan review window. The CLI
// wraps the path in CJK prose ("計畫已建立：…（stage:…"); the ASCII-only extractor
// must recover just the rel-path, matching isHtmlPlanDoc's shape.
describe('extractPlanDocRelPath', () => {
  it('extracts the plan rel-path from CJK prose (the screenshot case)', () => {
    const line = '計畫已建立：.agent-team/plans/employment-check-mail_e7b41a.html（stage: in-review）'
    expect(extractPlanDocRelPath(line)).toBe('.agent-team/plans/employment-check-mail_e7b41a.html')
  })

  it('strips a leading ./ and absolute prefix, keeping the workspace-relative path', () => {
    expect(extractPlanDocRelPath('./.agent-team/plans/x.html')).toBe('.agent-team/plans/x.html')
    expect(extractPlanDocRelPath('/Users/u/proj/.agent-team/plans/x_1a2b.html'))
      .toBe('.agent-team/plans/x_1a2b.html')
  })

  it('ignores infrastructure docs whose name starts with _ (matches isHtmlPlanDoc)', () => {
    expect(extractPlanDocRelPath('.agent-team/plans/_template.html')).toBeUndefined()
  })

  it('ignores non-.html and non-plan paths', () => {
    expect(extractPlanDocRelPath('.agent-team/plans/notes.md')).toBeUndefined()
    expect(extractPlanDocRelPath('src/main/index.ts')).toBeUndefined()
    expect(extractPlanDocRelPath('.agent-team/plans/sub/x.html')).toBeUndefined()
  })
})