import { describe, it, expect } from 'vitest'
import { parseLegacyRunGroups, resolveActiveTab, resolveManualSpawnGroupId } from '../runGroups'

describe('resolveActiveTab', () => {
  const groups = [{ id: 'rg-default' }, { id: 'rg-1' }, { id: 'rg-2' }]

  it('keeps the current tab when it still exists', () => {
    expect(resolveActiveTab(groups, 'rg-1')).toBe('rg-1')
  })

  it("keeps the special 'manual' tab even with no groups", () => {
    expect(resolveActiveTab([], 'manual')).toBe('manual')
    expect(resolveActiveTab(groups, 'manual')).toBe('manual')
  })

  it('falls back to the last remaining group when the current tab was deleted', () => {
    // simulates a peer window deleting the group this window was viewing
    expect(resolveActiveTab(groups, 'rg-removed')).toBe('rg-2')
  })

  it("falls back to 'manual' when no groups remain", () => {
    expect(resolveActiveTab([], 'rg-1')).toBe('manual')
  })

  it("treats an empty current id as invalid and falls back", () => {
    expect(resolveActiveTab(groups, '')).toBe('rg-2')
    expect(resolveActiveTab([], '')).toBe('manual')
  })
})

describe('resolveManualSpawnGroupId', () => {
  const groups = [{ id: 'run-a' }, { id: 'run-b' }]

  it('keeps a manual pane in the currently viewed run tab', () => {
    expect(resolveManualSpawnGroupId(groups, 'run-b')).toBe('run-b')
  })

  it('leaves panes unassigned in the synthetic manual tab', () => {
    expect(resolveManualSpawnGroupId(groups, 'manual')).toBe('')
  })

  it('does not assign a stale tab to an unrelated run', () => {
    expect(resolveManualSpawnGroupId(groups, 'missing')).toBe('')
  })
})

describe('parseLegacyRunGroups', () => {
  it('returns the stored groups verbatim', () => {
    const groups = [{ id: 'rg-default', name: '預設', createdAt: 1 }]
    expect(parseLegacyRunGroups(JSON.stringify(groups))).toEqual(groups)
  })

  it('returns null when nothing was stored (default group may be created)', () => {
    expect(parseLegacyRunGroups(null)).toBeNull()
  })

  it('keeps an explicitly stored empty list (user deleted the default group)', () => {
    expect(parseLegacyRunGroups('[]')).toEqual([])
  })

  it('yields [] (not null) for corrupt or non-array data', () => {
    expect(parseLegacyRunGroups('{not json')).toEqual([])
    expect(parseLegacyRunGroups('{"id":"rg-1"}')).toEqual([])
  })
})
