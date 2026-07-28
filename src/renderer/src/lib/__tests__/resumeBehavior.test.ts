import { describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceRestoreSession,
  normalizeResumeBehavior,
  normalizeRestoreScope,
  pendingRestorePaneIds,
  resolveWorkspaceRestoreSession,
  restoreScopeTargetIds,
  settleWorkspaceRestoreSession,
  stripPinnedSessionId,
} from '../resumeBehavior'

describe('normalizeResumeBehavior', () => {
  it('passes through the known behaviors', () => {
    expect(normalizeResumeBehavior('always')).toBe('always')
    expect(normalizeResumeBehavior('never')).toBe('never')
    expect(normalizeResumeBehavior('ask')).toBe('ask')
  })

  it('defaults anything else to always', () => {
    expect(normalizeResumeBehavior(undefined)).toBe('always')
    expect(normalizeResumeBehavior(null)).toBe('always')
    expect(normalizeResumeBehavior('sometimes')).toBe('always')
    expect(normalizeResumeBehavior(42)).toBe('always')
  })
})

describe('normalizeRestoreScope', () => {
  it('accepts the configured restore scopes', () => {
    expect(normalizeRestoreScope('single')).toBe('single')
    expect(normalizeRestoreScope('page')).toBe('page')
    expect(normalizeRestoreScope('tab')).toBe('tab')
  })

  it('defaults missing or invalid values to one CLI', () => {
    expect(normalizeRestoreScope(undefined)).toBe('single')
    expect(normalizeRestoreScope('workspace')).toBe('single')
  })
})

describe('restoreScopeTargetIds', () => {
  const base = {
    pendingPaneIds: ['a', 'b', 'c', 'd'],
    activeTabPaneIds: ['a', 'b', 'c'],
    gridPagePaneIds: ['b', 'c'],
    minimizedPaneIds: new Set(['c']),
  }

  it('uses the focused eligible pane for a single cold, tab, or layout restore', () => {
    expect(restoreScopeTargetIds({ ...base, scope: 'single', focusedPaneId: 'b', trigger: 'layout' })).toEqual(['b'])
  })

  it('uses the first eligible pane on a newly selected Grid page', () => {
    expect(restoreScopeTargetIds({ ...base, scope: 'single', focusedPaneId: 'a', trigger: 'grid-page' })).toEqual(['b'])
  })

  it('uses the supplied Grid page independent of the active layout', () => {
    expect(restoreScopeTargetIds({ ...base, scope: 'page' })).toEqual(['b'])
  })

  it('uses every eligible pane in the active tab', () => {
    expect(restoreScopeTargetIds({ ...base, scope: 'tab' })).toEqual(['a', 'b'])
  })
})

describe('pendingRestorePaneIds', () => {
  it('uses workspace, unrealized state, and deferred metadata rather than batch identity', () => {
    expect(pendingRestorePaneIds([
      { id: 'pending', workspacePath: '/ws/a', realized: false, deferredRestore: { batch: { session: {} } } },
      { id: 'realized', workspacePath: '/ws/a', realized: true, deferredRestore: {} },
      { id: 'no-deferred', workspacePath: '/ws/a', realized: false },
      { id: 'other-workspace', workspacePath: '/ws/b', realized: false, deferredRestore: {} },
    ], '/ws/a')).toEqual(['pending'])
  })
})

describe('stripPinnedSessionId', () => {
  const id = 'abcdef12-3456-7890-abcd-ef1234567890'

  it('removes a space-separated --session-id and its value', () => {
    expect(stripPinnedSessionId(`claude --session-id ${id}`)).toBe('claude')
    expect(stripPinnedSessionId(`claude --session-id ${id} --foo`)).toBe('claude --foo')
  })

  it('removes an =-separated --session-id', () => {
    expect(stripPinnedSessionId(`claude --session-id=${id}`)).toBe('claude')
  })

  it('leaves commands without --session-id untouched', () => {
    expect(stripPinnedSessionId('claude --dangerously-skip-permissions')).toBe(
      'claude --dangerously-skip-permissions'
    )
    expect(stripPinnedSessionId('')).toBe('')
  })
})

describe('workspace restore session', () => {
  const create = (behavior: unknown = 'always', scope: unknown = 'single') =>
    createWorkspaceRestoreSession({ workspacePath: '/ws/a', behavior, scope })

  it('snapshots the configured behavior and scope for the workspace open', () => {
    expect(create('ask', 'page')).toMatchObject({
      workspacePath: '/ws/a', behavior: 'ask', scope: 'page',
    })
  })

  it('always → resume without prompting', async () => {
    const ask = vi.fn()
    await expect(
      resolveWorkspaceRestoreSession({ session: create('always'), restorableCount: 3, ask })
    ).resolves.toBe('resume')
    expect(ask).not.toHaveBeenCalled()
  })

  it('never → fresh without prompting', async () => {
    const ask = vi.fn()
    await expect(
      resolveWorkspaceRestoreSession({ session: create('never'), restorableCount: 3, ask })
    ).resolves.toBe('fresh')
    expect(ask).not.toHaveBeenCalled()
  })

  it('ask with nothing restorable → resume without prompting', async () => {
    const ask = vi.fn()
    await expect(
      resolveWorkspaceRestoreSession({
        session: create('ask'), restorableCount: 0, ask,
      })
    ).resolves.toBe('resume')
    expect(ask).not.toHaveBeenCalled()
  })

  it('ask records the selected scope or fresh decision for the session', async () => {
    const resume = create('ask')
    await expect(
      resolveWorkspaceRestoreSession({ session: resume, restorableCount: 3, ask: async () => 'tab' })
    ).resolves.toBe('resume')
    expect(resume.scope).toBe('tab')
    expect(resume.decision).toBe('resume')
    const fresh = create('ask')
    await expect(
      resolveWorkspaceRestoreSession({ session: fresh, restorableCount: 3, ask: async () => 'fresh' })
    ).resolves.toBe('fresh')
    expect(fresh.decision).toBe('fresh')
  })

  it('keeps cancellation for automatic triggers but permits an explicit retry', async () => {
    const session = create('ask')
    await expect(
      resolveWorkspaceRestoreSession({ session, restorableCount: 3, ask: async () => null })
    ).resolves.toBe('cancelled')
    const automaticAsk = vi.fn(async () => 'page' as const)
    await expect(
      resolveWorkspaceRestoreSession({ session, restorableCount: 3, ask: automaticAsk })
    ).resolves.toBe('cancelled')
    expect(automaticAsk).not.toHaveBeenCalled()
    await expect(
      resolveWorkspaceRestoreSession({ session, restorableCount: 3, retryCancelled: true, ask: async () => 'page' })
    ).resolves.toBe('resume')
    expect(session.scope).toBe('page')
  })

  it('settles a preselected decision without rereading settings', () => {
    const session = create('always', 'single')
    settleWorkspaceRestoreSession(session, 'fresh')
    expect(session).toMatchObject({ behavior: 'always', scope: 'single', decision: 'fresh' })
  })
})
