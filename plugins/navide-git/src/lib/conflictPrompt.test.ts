import { describe, expect, it } from 'vitest'
import { buildConflictPrompt } from './conflictPrompt'

describe('buildConflictPrompt', () => {
  it('includes repository provenance, operation, and every conflict side', () => {
    const prompt = buildConflictPrompt({
      workspacePath: '/workspace',
      relativePath: 'src/file.ts',
      absolutePath: '/workspace/src/file.ts',
      operation: 'merge',
      content: ['before', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> topic', 'after'].join('\n'),
    })

    expect(prompt).toContain('Repository: /workspace')
    expect(prompt).toContain('File: src/file.ts (absolute path: /workspace/src/file.ts)')
    expect(prompt).toContain('Operation in progress: merge')
    expect(prompt).toContain('Conflict blocks in this file: 1')
    expect(prompt).toContain('<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic')
    expect(prompt).toContain('Do not stage and do not commit')
  })

  it('quotes only conflict excerpts for a large file', () => {
    const content = [
      ...Array.from({ length: 1_100 }, (_, index) => `before-${index}`),
      '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> topic',
      ...Array.from({ length: 1_100 }, (_, index) => `after-${index}`),
    ].join('\n')
    const prompt = buildConflictPrompt({
      workspacePath: '/workspace',
      relativePath: 'large.txt',
      absolutePath: '/workspace/large.txt',
      content,
    })

    expect(prompt).toContain('only the conflict regions are quoted below')
    expect(prompt).toContain('ours\n=======\ntheirs')
    expect(prompt).not.toContain('before-0')
    expect(prompt).not.toContain('after-1099')
  })
})
