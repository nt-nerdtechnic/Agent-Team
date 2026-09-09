import { describe, expect, it } from 'vitest'
import {
  countHistoryCleanupEntries,
  entryBelongsToWorkspace,
  filterHistoryEntries,
  filterWorkspaceEntries,
  groupHistory,
  groupHistoryByDay,
  historyCleanupCutoffIso,
  historyCleanupMatches,
  historyEntriesFor,
  historyEntryLabel,
  isHistoryEntryRemoved,
  legacyHistoryLogPath,
  manualLogFileName,
  matchesHistorySearch,
  updateHistoryCustomName,
  type HistoryStatusFilter,
  type HistoryTitleEntry,
  type SpawnHistoryEntry,
} from '../spawnHistory'
import {
  formatTerminalExit,
  isTerminalCrashLoopOpen,
  recordTerminalExit,
  resetTerminalCrashLoop,
  terminalCrashKey,
} from '@navide/terminal'

function entry(overrides: Partial<HistoryTitleEntry> = {}): HistoryTitleEntry {
  return {
    paneId: 'pane-1',
    agentLabel: 'Claude Code',
    ...overrides,
  }
}

/** A complete record, for the helpers that read more than the title fields. */
function fullEntry(overrides: Partial<SpawnHistoryEntry> = {}): SpawnHistoryEntry {
  return {
    paneId: 'pane-1',
    agentKey: 'claude',
    agentLabel: 'Claude Code',
    roleKey: 'dev' as SpawnHistoryEntry['roleKey'],
    roleLabel: 'Dev',
    command: 'claude',
    origin: 'manual',
    stageId: '' as SpawnHistoryEntry['stageId'],
    workspacePath: '/ws',
    ...overrides,
  }
}

describe('spawn history titles', () => {
  it('prefers the CLI custom title and falls back to the vendor label', () => {
    expect(historyEntryLabel(entry({ customName: 'Frontend Lead' }))).toBe('Frontend Lead')
    expect(historyEntryLabel(entry())).toBe('Claude Code')
  })

  it('ranks the auto-derived name between the custom title and the vendor label', () => {
    expect(historyEntryLabel(entry({ customName: 'Frontend Lead', autoName: 'Fix login' })))
      .toBe('Frontend Lead')
    expect(historyEntryLabel(entry({ autoName: 'Fix login' }))).toBe('Fix login')
    expect(historyEntryLabel(entry())).toBe('Claude Code')
  })

  it('synchronizes rename and reset operations with the matching history entry', () => {
    const entries = [entry()]

    expect(updateHistoryCustomName(entries, 'pane-1', ' Reviewer ')).toBe(true)
    expect(entries[0].customName).toBe('Reviewer')

    expect(updateHistoryCustomName(entries, 'pane-1', '  ')).toBe(true)
    expect(entries[0].customName).toBeUndefined()
  })

  it('leaves history unchanged when the pane is not present', () => {
    const entries = [entry()]
    expect(updateHistoryCustomName(entries, 'missing', 'Reviewer')).toBe(false)
    expect(entries).toEqual([entry()])
  })

  it('matches a changed Codex pane id through the stable session home', () => {
    const entries = [entry({
      paneId: 'old-pane',
      agentKey: 'codex',
      sessionId: 'session-1',
      sessionHomeId: 'codex-home-1',
    })]

    expect(updateHistoryCustomName(entries, {
      paneId: 'new-pane',
      agentKey: 'codex',
      sessionId: 'session-1',
      sessionHomeId: 'codex-home-1',
    }, 'Restored Codex')).toBe(true)
    expect(entries[0].customName).toBe('Restored Codex')
  })

  it('matches a legacy Codex history pane id to the stable session home', () => {
    const entries = [entry({
      paneId: 'codex-home-1',
      agentKey: 'codex',
      sessionId: 'session-1',
    })]

    expect(updateHistoryCustomName(entries, {
      paneId: 'new-pane',
      agentKey: 'codex',
      sessionId: 'session-1',
      sessionHomeId: 'codex-home-1',
    }, 'Restored legacy Codex')).toBe(true)
    expect(entries[0].customName).toBe('Restored legacy Codex')
  })

  it('matches a changed pane id through the normalized vendor session id', () => {
    const entries = [entry({
      paneId: 'old-pane',
      agentKey: 'claude',
      sessionId: 'session-1',
    })]

    expect(updateHistoryCustomName(entries, {
      paneId: 'new-pane',
      agentKey: 'claude',
      sessionId: ' session-1 ',
    }, 'Restored Claude')).toBe(true)
    expect(entries[0].customName).toBe('Restored Claude')
  })

  it('does not match a changed pane id from a different session', () => {
    const entries = [entry({
      paneId: 'old-pane',
      agentKey: 'claude',
      sessionId: 'session-1',
    })]

    expect(updateHistoryCustomName(entries, {
      paneId: 'new-pane',
      agentKey: 'claude',
      sessionId: 'session-2',
    }, 'Wrong title')).toBe(false)
    expect(entries[0].customName).toBeUndefined()
  })

  it('updates all entries in the same session lineage', () => {
    const entries = [
      entry({ paneId: 'exact-pane', agentKey: 'claude', sessionId: 'session-1' }),
      entry({ paneId: 'older-pane', agentKey: 'claude', sessionId: 'session-1' }),
    ]

    expect(updateHistoryCustomName(entries, {
      paneId: 'exact-pane',
      agentKey: 'claude',
      sessionId: 'session-1',
    }, 'Exact title')).toBe(true)
    expect(entries[0].customName).toBe('Exact title')
    expect(entries[1].customName).toBe('Exact title')
  })
})

describe('matchesHistorySearch', () => {
  const searchable = {
    ...entry({ customName: 'Frontend Lead', sessionId: 'abc123-session' }),
    roleKey: 'frontend',
    roleLabel: 'Frontend Engineer',
  }

  it('matches everything when the query is empty or whitespace', () => {
    expect(matchesHistorySearch(entry(), '')).toBe(true)
    expect(matchesHistorySearch(entry(), '   ')).toBe(true)
  })

  it('matches the custom name and the agent label', () => {
    expect(matchesHistorySearch(searchable, 'Frontend Lead')).toBe(true)
    expect(matchesHistorySearch(entry(), 'Claude')).toBe(true)
  })

  it('matches the auto-derived name', () => {
    const autoNamed = entry({ autoName: 'Fix login bug' })
    expect(matchesHistorySearch(autoNamed, 'login')).toBe(true)
    expect(matchesHistorySearch(autoNamed, 'LOGIN BUG')).toBe(true)
    expect(matchesHistorySearch(autoNamed, 'logout')).toBe(false)
  })

  it('matches a partial session id', () => {
    expect(matchesHistorySearch(searchable, 'abc123')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matchesHistorySearch(searchable, 'fRoNtEnD lEaD')).toBe(true)
    expect(matchesHistorySearch(searchable, 'ABC123')).toBe(true)
  })

  it('matches the role key and role label', () => {
    expect(matchesHistorySearch(searchable, 'engineer')).toBe(true)
    expect(matchesHistorySearch(searchable, 'frontend')).toBe(true)
  })

  it('rejects a query that hits no field', () => {
    expect(matchesHistorySearch(searchable, 'backend')).toBe(false)
    expect(matchesHistorySearch(entry(), 'missing')).toBe(false)
  })
})

describe('filterHistoryEntries', () => {
  const entries = [
    { ...entry({ paneId: 'a', customName: 'Frontend Lead' }), origin: 'manual' as const },
    { ...entry({ paneId: 'b', agentLabel: 'Codex' }), origin: 'manual' as const, removedAt: '2026-07-21T10:00:00.000Z' },
    { ...entry({ paneId: 'c', agentLabel: 'Claude Code' }), origin: 'pipeline' as const, removedAt: '2026-07-20T10:00:00.000Z' },
    { ...entry({ paneId: 'd', agentLabel: 'Claude Code' }), origin: 'pipeline' as const },
  ]

  it('passes everything through with the all/all/empty filter', () => {
    expect(filterHistoryEntries(entries, { query: '', status: 'all', origin: 'all' }))
      .toEqual(entries)
  })

  it('filters by status: active keeps only entries without removedAt', () => {
    expect(filterHistoryEntries(entries, { query: '', status: 'active', origin: 'all' })
      .map((e) => e.paneId)).toEqual(['a', 'd'])
  })

  it('filters by status: removed keeps only entries with removedAt', () => {
    expect(filterHistoryEntries(entries, { query: '', status: 'removed', origin: 'all' })
      .map((e) => e.paneId)).toEqual(['b', 'c'])
  })

  it('filters by origin', () => {
    expect(filterHistoryEntries(entries, { query: '', status: 'all', origin: 'manual' })
      .map((e) => e.paneId)).toEqual(['a', 'b'])
    expect(filterHistoryEntries(entries, { query: '', status: 'all', origin: 'pipeline' })
      .map((e) => e.paneId)).toEqual(['c', 'd'])
  })

  it('combines status, origin, and text query', () => {
    expect(filterHistoryEntries(entries, { query: 'claude', status: 'active', origin: 'pipeline' })
      .map((e) => e.paneId)).toEqual(['d'])
    expect(filterHistoryEntries(entries, { query: 'codex', status: 'active', origin: 'all' }))
      .toEqual([])
  })

  it('unions metadata matches with contentMatchedIds when a query is set', () => {
    // No entry's metadata contains "hello"; 'b' is included only because its
    // paneId is in contentMatchedIds (simulating a log-content match).
    expect(filterHistoryEntries(entries, {
      query: 'hello',
      status: 'all',
      origin: 'all',
      contentMatchedIds: new Set(['b']),
    }).map((e) => e.paneId)).toEqual(['b'])
  })

  it('ignores contentMatchedIds when the query is empty (metadata match already passes everything)', () => {
    expect(filterHistoryEntries(entries, {
      query: '',
      status: 'all',
      origin: 'all',
      contentMatchedIds: new Set(),
    })).toEqual(entries)
  })

  it('starredOnly keeps only starred entries and combines with other dimensions', () => {
    const starrable = [
      { ...entry({ paneId: 'a', customName: 'Frontend Lead' }), origin: 'manual' as const, starred: true },
      { ...entry({ paneId: 'b', agentLabel: 'Codex' }), origin: 'manual' as const },
      { ...entry({ paneId: 'c', agentLabel: 'Claude Code' }), origin: 'pipeline' as const, starred: true, removedAt: '2026-07-20T10:00:00.000Z' },
    ]
    expect(filterHistoryEntries(starrable, { query: '', status: 'all', origin: 'all', starredOnly: true })
      .map((e) => e.paneId)).toEqual(['a', 'c'])
    // Combined with status: only the starred active entry remains.
    expect(filterHistoryEntries(starrable, { query: '', status: 'active', origin: 'all', starredOnly: true })
      .map((e) => e.paneId)).toEqual(['a'])
    // Combined with a query: starred is a hard gate, not a union with the
    // text match — an unstarred metadata match stays hidden.
    expect(filterHistoryEntries(starrable, { query: 'codex', status: 'all', origin: 'all', starredOnly: true }))
      .toEqual([])
    // Off (or omitted) leaves everything through.
    expect(filterHistoryEntries(starrable, { query: '', status: 'all', origin: 'all', starredOnly: false }))
      .toEqual(starrable)
  })
})

describe('groupHistoryByDay', () => {
  // Local-calendar reference point: 2026-07-22 15:30 local time.
  const now = new Date(2026, 6, 22, 15, 30, 0)
  const localIso = (d: number, h: number, m = 0): string =>
    new Date(2026, 6, d, h, m).toISOString()

  it('buckets entries by local calendar day across the midnight boundaries', () => {
    const groups = groupHistoryByDay([
      { paneId: 'today-start', spawnedAt: localIso(22, 0) },
      { paneId: 'yesterday-end', spawnedAt: localIso(21, 23, 59) },
      { paneId: 'yesterday-start', spawnedAt: localIso(21, 0) },
      { paneId: 'earlier-end', spawnedAt: localIso(20, 23, 59) },
    ], now)

    expect(groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'earlier'])
    expect(groups[0].entries.map((e) => e.paneId)).toEqual(['today-start'])
    expect(groups[1].entries.map((e) => e.paneId)).toEqual(['yesterday-end', 'yesterday-start'])
    expect(groups[2].entries.map((e) => e.paneId)).toEqual(['earlier-end'])
  })

  it('sends missing and unparseable spawnedAt to earlier', () => {
    const groups = groupHistoryByDay([
      { paneId: 'none' },
      { paneId: 'garbage', spawnedAt: 'not-a-date' },
    ], now)

    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('earlier')
    expect(groups[0].entries.map((e) => e.paneId)).toEqual(['none', 'garbage'])
  })

  it('omits empty buckets', () => {
    const groups = groupHistoryByDay([{ paneId: 'a', spawnedAt: localIso(22, 9) }], now)
    expect(groups.map((g) => g.key)).toEqual(['today'])
  })

  it('preserves the input order within each bucket (stable)', () => {
    const groups = groupHistoryByDay([
      { paneId: 'n1', spawnedAt: localIso(22, 14) },
      { paneId: 'n2', spawnedAt: localIso(22, 15) },
      { paneId: 'n3', spawnedAt: localIso(22, 9) },
    ], now)

    expect(groups[0].entries.map((e) => e.paneId)).toEqual(['n1', 'n2', 'n3'])
  })

  it('returns no groups for an empty list', () => {
    expect(groupHistoryByDay([], now)).toEqual([])
  })
})

describe('groupHistory', () => {
  const now = new Date(2026, 6, 22, 15, 30, 0)
  const localIso = (d: number, h: number, m = 0): string =>
    new Date(2026, 6, d, h, m).toISOString()
  const entries = [
    { paneId: 'busy-today', spawnedAt: localIso(22, 14) },
    { paneId: 'quiet-today', spawnedAt: localIso(22, 9) },
    { paneId: 'busy-old', spawnedAt: localIso(20, 9) },
    { paneId: 'quiet-old', spawnedAt: localIso(20, 8) },
  ]

  it('pins the working panes on top, newest-first order preserved', () => {
    const groups = groupHistory(entries, now, new Set(['busy-today', 'busy-old']))

    expect(groups.map((g) => g.key)).toEqual(['active', 'today', 'earlier'])
    expect(groups[0].entries.map((e) => e.paneId)).toEqual(['busy-today', 'busy-old'])
  })

  it('moves them out of their day group rather than copying them', () => {
    const groups = groupHistory(entries, now, new Set(['busy-today', 'busy-old']))

    expect(groups[1].entries.map((e) => e.paneId)).toEqual(['quiet-today'])
    expect(groups[2].entries.map((e) => e.paneId)).toEqual(['quiet-old'])
    const all = groups.flatMap((g) => g.entries.map((e) => e.paneId))
    expect(new Set(all).size).toBe(all.length)
  })

  it('falls back to the plain day grouping when nothing is working', () => {
    expect(groupHistory(entries, now, new Set())).toEqual(groupHistoryByDay(entries, now))
  })

  it('omits the active group when no listed entry matches a working pane', () => {
    const groups = groupHistory(entries, now, new Set(['a-pane-not-in-this-list']))
    expect(groups.map((g) => g.key)).toEqual(['today', 'earlier'])
  })
})

describe('manualLogFileName', () => {
  it('joins the agent key with the first 8 chars of the pane id', () => {
    expect(manualLogFileName('claude', 'abcd1234-5678')).toBe('claude-abcd1234.log')
  })
})

describe('legacy history log path reconstruction', () => {
  it('builds a manual pane path from the UTC spawn date', () => {
    expect(legacyHistoryLogPath({
      spawnedAt: '2026-07-19T10:00:00.000Z',
      origin: 'manual',
      stageId: '',
      paneId: 'abcd1234-5678',
      agentKey: 'claude',
    }, '/ws')).toBe('/ws/.agent-team/manual/20260719/claude-abcd1234.log')
  })

  it('builds a pipeline stage path without the date folder', () => {
    expect(legacyHistoryLogPath({
      spawnedAt: '2026-07-19T10:00:00.000Z',
      origin: 'pipeline',
      stageId: 'build',
      paneId: 'abcd1234-5678',
      agentKey: 'claude',
    }, '/ws')).toBe('/ws/.agent-team/stage-build-abcd1234.log')
  })
})

describe('terminal crash-loop diagnostics', () => {
  const key = terminalCrashKey({
    agentKey: 'claude',
    cwd: '/workspace',
    resumeKey: 'session-1',
    command: ['zsh', '-lc', 'claude --resume session-1'],
  })

  it('opens after three consecutive exits within one second', () => {
    resetTerminalCrashLoop(key)
    const fastExit = { reason: 'exit', exit_code: -9, signal: 'SIGKILL', uptime_ms: 42 }

    expect(recordTerminalExit(key, fastExit)).toEqual({ count: 1, open: false })
    expect(recordTerminalExit(key, fastExit)).toEqual({ count: 2, open: false })
    expect(recordTerminalExit(key, fastExit)).toEqual({ count: 3, open: true })
    expect(isTerminalCrashLoopOpen(key)).toBe(true)
  })

  it('resets the consecutive count after a non-fast exit', () => {
    resetTerminalCrashLoop(key)
    recordTerminalExit(key, { reason: 'exit', exit_code: -9, uptime_ms: 50 })

    expect(recordTerminalExit(key, { reason: 'exit', exit_code: 0, uptime_ms: 1_500 }))
      .toEqual({ count: 0, open: false })
    expect(isTerminalCrashLoopOpen(key)).toBe(false)
  })

  it('formats the exact signal, lifetime, and resolved binary', () => {
    expect(formatTerminalExit({
      reason: 'exit',
      exit_code: -9,
      signal: 'SIGKILL',
      uptime_ms: 42,
      startup_probe: { binary_path: '/opt/bin/claude' },
    })).toBe('Process was terminated by SIGKILL 42ms after spawn — /opt/bin/claude')
  })
})

describe('workspace isolation filter', () => {
  const workspace = {
    workspacePath: '/Users/me/alias-workspace',
    canonicalWorkspacePath: '/Users/me/real-workspace',
  }

  it('matches the workspace path as spelled by the renderer', () => {
    expect(entryBelongsToWorkspace({ workspacePath: '/Users/me/alias-workspace' }, workspace)).toBe(true)
  })

  it('matches the backend-resolved canonical (symlink) spelling', () => {
    expect(entryBelongsToWorkspace({ workspacePath: '/Users/me/real-workspace' }, workspace)).toBe(true)
  })

  it('rejects entries from a foreign workspace', () => {
    expect(entryBelongsToWorkspace({ workspacePath: '/Users/me/other' }, workspace)).toBe(false)
  })

  it('rejects entries without a workspacePath and nullish entries', () => {
    expect(entryBelongsToWorkspace({}, workspace)).toBe(false)
    expect(entryBelongsToWorkspace({ workspacePath: '' }, workspace)).toBe(false)
    expect(entryBelongsToWorkspace(null, workspace)).toBe(false)
    expect(entryBelongsToWorkspace(undefined, workspace)).toBe(false)
  })

  it('rejects everything when the current workspace is empty', () => {
    expect(entryBelongsToWorkspace(
      { workspacePath: '/Users/me/real-workspace' },
      { workspacePath: '', canonicalWorkspacePath: '/Users/me/real-workspace' },
    )).toBe(false)
  })

  it('works without a canonical alias (exact match only)', () => {
    const bare = { workspacePath: '/Users/me/ws' }
    expect(entryBelongsToWorkspace({ workspacePath: '/Users/me/ws' }, bare)).toBe(true)
    expect(entryBelongsToWorkspace({ workspacePath: '/Users/me/real-workspace' }, bare)).toBe(false)
  })

  it('filterWorkspaceEntries keeps only entries of the current workspace', () => {
    const entries = [
      { paneId: 'a', workspacePath: '/Users/me/alias-workspace' },
      { paneId: 'b', workspacePath: '/Users/me/real-workspace' },
      { paneId: 'c', workspacePath: '/Users/me/other' },
      { paneId: 'd' } as { paneId: string; workspacePath?: string },
    ]
    expect(filterWorkspaceEntries(entries, workspace).map((e) => e.paneId)).toEqual(['a', 'b'])
  })
})

describe('history cleanup helpers', () => {
  const now = new Date('2026-07-22T12:00:00Z')

  it('computes the cutoff N days before now as an ISO string', () => {
    expect(historyCleanupCutoffIso(now)).toBe('2026-07-15T12:00:00.000Z')
    expect(historyCleanupCutoffIso(now, 1)).toBe('2026-07-21T12:00:00.000Z')
  })

  it('removed mode matches only entries with a removedAt', () => {
    expect(historyCleanupMatches({ removedAt: '2026-07-20T00:00:00Z' }, 'removed')).toBe(true)
    expect(historyCleanupMatches({}, 'removed')).toBe(false)
    expect(historyCleanupMatches({ spawnedAt: '2026-01-01T00:00:00Z' }, 'removed')).toBe(false)
  })

  it('older_than matches removed entries spawned strictly before the cutoff', () => {
    const cutoff = historyCleanupCutoffIso(now)
    const removed = { removedAt: '2026-07-20T00:00:00Z' }
    expect(historyCleanupMatches({ ...removed, spawnedAt: '2026-07-15T11:59:59Z' }, 'older_than', cutoff)).toBe(true)
    // Exactly at the cutoff → kept (strict comparison, mirrors the backend).
    expect(historyCleanupMatches({ ...removed, spawnedAt: '2026-07-15T12:00:00.000Z' }, 'older_than', cutoff)).toBe(false)
    expect(historyCleanupMatches({ ...removed, spawnedAt: '2026-07-16T00:00:00Z' }, 'older_than', cutoff)).toBe(false)
    // Active entries are never bulk-cleaned, no matter how old.
    expect(historyCleanupMatches({ spawnedAt: '2026-01-01T00:00:00Z' }, 'older_than', cutoff)).toBe(false)
    // Missing or unparseable spawnedAt → kept.
    expect(historyCleanupMatches({ ...removed }, 'older_than', cutoff)).toBe(false)
    expect(historyCleanupMatches({ ...removed, spawnedAt: 'not-a-date' }, 'older_than', cutoff)).toBe(false)
    // Missing cutoff → nothing matches.
    expect(historyCleanupMatches({ ...removed, spawnedAt: '2026-01-01T00:00:00Z' }, 'older_than')).toBe(false)
  })

  it('countHistoryCleanupEntries tallies matches per mode', () => {
    const cutoff = historyCleanupCutoffIso(now)
    const entries = [
      { spawnedAt: '2026-07-01T00:00:00Z', removedAt: '2026-07-02T00:00:00Z' },
      { spawnedAt: '2026-07-21T00:00:00Z', removedAt: '2026-07-21T01:00:00Z' },
      { spawnedAt: '2026-07-01T00:00:00Z' },
    ]
    expect(countHistoryCleanupEntries(entries, 'removed')).toBe(2)
    expect(countHistoryCleanupEntries(entries, 'older_than', cutoff)).toBe(1)
  })

  it('starred entries survive both bulk modes (mirrors the backend skip)', () => {
    const cutoff = historyCleanupCutoffIso(now)
    const starredOld = {
      spawnedAt: '2026-07-01T00:00:00Z',
      removedAt: '2026-07-02T00:00:00Z',
      starred: true,
    }
    expect(historyCleanupMatches(starredOld, 'removed')).toBe(false)
    expect(historyCleanupMatches(starredOld, 'older_than', cutoff)).toBe(false)
    expect(countHistoryCleanupEntries([
      starredOld,
      { spawnedAt: '2026-07-01T00:00:00Z', removedAt: '2026-07-02T00:00:00Z' },
    ], 'removed')).toBe(1)
  })
})

// A removed pane whose removal time was never recorded is still a removed
// pane. Before removedTimeUnknown existed, the restore backfill filled both
// timestamps with project.updated_at — rewritten on every save — so a whole
// batch of old sessions arrived carrying roughly the app's start time and
// piled into "Today". The fields now say "unknown" instead, which only works
// if every liveness test asks both of them.
describe('removed entries whose removal time is unknown', () => {
  it('isHistoryEntryRemoved answers on either field', () => {
    expect(isHistoryEntryRemoved({ removedAt: '2026-07-20T00:00:00Z' })).toBe(true)
    expect(isHistoryEntryRemoved({ removedTimeUnknown: true })).toBe(true)
    expect(isHistoryEntryRemoved({})).toBe(false)
  })

  it('the status filter counts them as removed, not active', () => {
    const unknown = fullEntry({ paneId: 'no-time', removedTimeUnknown: true })
    const live = fullEntry({ paneId: 'live' })
    const timed = fullEntry({ paneId: 'timed', removedAt: '2026-07-20T00:00:00Z' })
    const entries = [unknown, live, timed]
    const ids = (status: HistoryStatusFilter): string[] =>
      filterHistoryEntries(entries, { query: '', status, origin: 'all' }).map((e) => e.paneId)
    expect(ids('removed')).toEqual(['no-time', 'timed'])
    expect(ids('active')).toEqual(['live'])
  })

  it('bulk cleanup can still sweep them in removed mode', () => {
    expect(historyCleanupMatches({ removedTimeUnknown: true }, 'removed')).toBe(true)
    // 'older_than' needs a spawnedAt to compare, so it leaves them alone.
    expect(historyCleanupMatches(
      { removedTimeUnknown: true },
      'older_than',
      historyCleanupCutoffIso(new Date('2026-07-22T12:00:00Z')),
    )).toBe(false)
  })

  it('groups an entry with no spawn time under earlier, never today', () => {
    const groups = groupHistoryByDay(
      [{ paneId: 'no-time', spawnedAt: undefined }],
      new Date('2026-07-22T12:00:00Z'),
    )
    expect(groups.map((g) => g.key)).toEqual(['earlier'])
  })

  it('has no legacy log path to guess without a spawn date', () => {
    // The manual layout files the log under a UTC date folder; without a date
    // there is nothing to reconstruct, and guessing from "now" would point the
    // reader at a folder the log was never written to.
    const base = {
      origin: 'manual' as const,
      stageId: '',
      paneId: 'abcd1234-5678',
      agentKey: 'claude',
    }
    expect(legacyHistoryLogPath(base, '/ws')).toBe('')
    expect(legacyHistoryLogPath({ ...base, spawnedAt: '' }, '/ws')).toBe('')
    expect(legacyHistoryLogPath({ ...base, spawnedAt: 'not-a-date' }, '/ws')).toBe('')
    // Pipeline logs are named from the stage and pane id alone, so they are
    // still reconstructable with no date at all.
    expect(legacyHistoryLogPath({ ...base, origin: 'pipeline', stageId: 'build' }, '/ws'))
      .toBe('/ws/.agent-team/stage-build-abcd1234.log')
  })
})

// A restore reopens a session under a fresh pane id and files a brand new
// record for it. That record has no title yet, and it is the newest — so
// dedupe kept it and dropped the older, named row, which is how renamed
// agents fell back to their vendor label after every restart.
describe('historyEntriesFor', () => {
  const ws = { workspacePath: '/ws' }

  it('keeps the newest row per session but inherits the name it lost', () => {
    const out = historyEntriesFor([
      fullEntry({ paneId: 'old', sessionId: 's1', autoName: 'Refactor the parser' }),
      fullEntry({ paneId: 'new', sessionId: 's1' }),
    ], ws)
    expect(out).toHaveLength(1)
    expect(out[0].paneId).toBe('new')
    expect(out[0].autoName).toBe('Refactor the parser')
    expect(historyEntryLabel(out[0])).toBe('Refactor the parser')
  })

  it('lets a user rename on the older row survive too', () => {
    const out = historyEntriesFor([
      fullEntry({ paneId: 'old', sessionId: 's1', customName: 'Frontend Lead' }),
      fullEntry({ paneId: 'new', sessionId: 's1' }),
    ], ws)
    expect(out[0].customName).toBe('Frontend Lead')
  })

  it('does not let an older name override a newer one', () => {
    const out = historyEntriesFor([
      fullEntry({ paneId: 'oldest', sessionId: 's1', autoName: 'First topic' }),
      fullEntry({ paneId: 'newest', sessionId: 's1', autoName: 'Current topic' }),
    ], ws)
    expect(out[0].autoName).toBe('Current topic')
  })

  it('never mutates the source rows (spawnHistory feeds the persist watcher)', () => {
    const older = fullEntry({ paneId: 'old', sessionId: 's1', autoName: 'Kept name' })
    const newer = fullEntry({ paneId: 'new', sessionId: 's1' })
    const out = historyEntriesFor([older, newer], ws)
    expect(newer.autoName).toBeUndefined()
    expect(out[0]).not.toBe(newer)
  })

  it('still dedupes by pane id when there is no session id, newest first', () => {
    const out = historyEntriesFor([
      fullEntry({ paneId: 'a' }),
      fullEntry({ paneId: 'b' }),
      fullEntry({ paneId: 'a' }),
    ], ws)
    expect(out.map((e) => e.paneId)).toEqual(['a', 'b'])
  })

  it('drops another workspace\'s entries', () => {
    const out = historyEntriesFor([
      fullEntry({ paneId: 'mine' }),
      fullEntry({ paneId: 'theirs', workspacePath: '/other' }),
    ], ws)
    expect(out.map((e) => e.paneId)).toEqual(['mine'])
  })
})
