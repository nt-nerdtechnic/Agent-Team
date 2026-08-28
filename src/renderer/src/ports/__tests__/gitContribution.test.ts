import { describe, expect, it } from 'vitest'
import { normalizeGitContributionAction } from '../gitContribution'

describe('Git contribution Host envelope', () => {
  it('restores nested UI payloads without losing their event shape', () => {
    expect(normalizeGitContributionAction({
      operation: 'open_diff',
      payload: { filepath: 'src/app.ts', staged: true, name: 'app.ts' },
    })).toEqual({
      operation: 'open_diff',
      payload: { filepath: 'src/app.ts', staged: true, name: 'app.ts' },
    })
  })

  it('restores scalar contribution payloads at the action root', () => {
    expect(normalizeGitContributionAction({
      operation: 'changes_count',
      payload: { count: 3 },
    })).toEqual({ operation: 'changes_count', count: 3 })
  })
})
