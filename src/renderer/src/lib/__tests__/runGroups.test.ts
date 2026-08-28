import { describe, it, expect } from 'vitest'
import {
  parseLegacyRunGroups,
  resolveActiveTab,
  resolveManualSpawnGroupId,
  runGroupCreatedAt,
} from '../runGroups'

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

describe('runGroupCreatedAt', () => {
  const NOW = 1_800_000_000_000

  it('recovers the minting time from an `rg-<epoch ms>` id', () => {
    // A rebuilt group sorts where it always belonged instead of after every
    // group made since.
    expect(runGroupCreatedAt('rg-1755000000000', NOW)).toBe(1755000000000)
  })

  it('takes now for the fixed default id, which carries no time', () => {
    expect(runGroupCreatedAt('rg-default', NOW)).toBe(NOW)
  })

  it('takes now for an id from some other scheme', () => {
    expect(runGroupCreatedAt('run-1755000000000', NOW)).toBe(NOW)
    expect(runGroupCreatedAt('', NOW)).toBe(NOW)
    expect(runGroupCreatedAt('rg-', NOW)).toBe(NOW)
  })

  it('takes now rather than trusting a nonsensical stamp', () => {
    expect(runGroupCreatedAt('rg--5', NOW)).toBe(NOW)
    expect(runGroupCreatedAt('rg-0', NOW)).toBe(NOW)
    expect(runGroupCreatedAt('rg-abc', NOW)).toBe(NOW)
    expect(runGroupCreatedAt('rg-1.5', NOW)).toBe(NOW)
    // Beyond Number.MAX_SAFE_INTEGER the value read back is not the value
    // written, so it is no better evidence than now.
    expect(runGroupCreatedAt('rg-99999999999999999999', NOW)).toBe(NOW)
  })

  it('defaults to the wall clock when no time is passed', () => {
    const before = Date.now()
    const got = runGroupCreatedAt('rg-default')
    expect(got).toBeGreaterThanOrEqual(before)
    expect(got).toBeLessThanOrEqual(Date.now())
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
