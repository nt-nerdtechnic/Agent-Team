import type { RoleKey } from '../data/roles'
import type { StageId } from '../data/stages'
import { normalizeResumeSessionId, usesSessionHome } from '@navide/plugin-shell'

export interface HistoryTitleEntry {
  paneId: string
  agentLabel: string
  customName?: string
  /** Auto-derived title mirrored from the pane record; only a fallback —
   *  a user-set customName always wins. */
  autoName?: string
  agentKey?: string
  sessionId?: string
  sessionHomeId?: string
}

export interface SpawnHistoryEntry extends HistoryTitleEntry {
  agentKey: string
  roleKey: RoleKey
  roleLabel: string
  command: string
  sessionId?: string
  origin: 'manual' | 'pipeline' | 'mcp'
  stageId: StageId
  workspacePath: string
  spawnedAt: string
  removedAt?: string
  restoreMode?: 'memory-resume' | 'fresh'
  sessionHomeId?: string
  runGroupId?: string
  outputLogFile?: string
  /** User favorite. Persisted across restarts; bulk cleanup skips starred
   *  entries (explicit single delete still removes them). */
  starred?: boolean
}

export interface HistoryTitleIdentity {
  paneId: string
  agentKey?: string
  sessionId?: string
  sessionHomeId?: string
}

export interface WorkspaceIdentity {
  /** The workspace path as the renderer spells it (currentWorkspace). */
  workspacePath: string
  /** Backend-resolved realpath of the same workspace (symlink alias), when known. */
  canonicalWorkspacePath?: string
}

/** Display/write-layer line of the workspace-isolation defense (the backend
 *  store filters independently on persist): true when an entry's
 *  workspacePath names the current workspace, matching either the renderer's
 *  spelling or the backend's canonical (symlink-resolved) spelling. Entries
 *  without a workspacePath are treated as foreign. */
export function entryBelongsToWorkspace(
  entry: { workspacePath?: string } | null | undefined,
  workspace: WorkspaceIdentity
): boolean {
  const path = entry?.workspacePath
  if (!path || !workspace.workspacePath) return false
  if (path === workspace.workspacePath) return true
  return !!workspace.canonicalWorkspacePath && path === workspace.canonicalWorkspacePath
}

export function filterWorkspaceEntries<T extends { workspacePath?: string }>(
  entries: T[],
  workspace: WorkspaceIdentity
): T[] {
  return entries.filter((entry) => entryBelongsToWorkspace(entry, workspace))
}

/** Display title for a history entry, in priority order:
 *  user rename > auto-derived name > vendor default label. */
export function historyEntryLabel(entry: HistoryTitleEntry): string {
  return entry.customName || entry.autoName || entry.agentLabel
}

/** Case-insensitive match of a history entry against a search query
 *  (both name layers are searchable).
 *  An empty (or whitespace-only) query matches everything. */
export function matchesHistorySearch(
  entry: HistoryTitleEntry & { roleKey?: string; roleLabel?: string },
  query: string
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [entry.customName, entry.autoName, entry.agentLabel, entry.sessionId, entry.roleKey, entry.roleLabel]
    .some((field) => !!field && field.toLowerCase().includes(q))
}

export type HistoryStatusFilter = 'all' | 'active' | 'removed'
export type HistoryOriginFilter = 'all' | 'manual' | 'pipeline'

export interface HistoryEntryFilter {
  query: string
  status: HistoryStatusFilter
  origin: HistoryOriginFilter
  /** Show only starred (favorite) entries. */
  starredOnly?: boolean
  /** paneIds whose conversation log content matched `query` (from an async
   *  search). Union'd with the metadata match so either one includes the
   *  entry in the results. */
  contentMatchedIds?: Set<string>
}

/** Combines the text search with a status filter (active = no removedAt),
 *  an origin filter, and the starred-only toggle. 'all' (or a false
 *  starredOnly) disables the corresponding dimension. An entry passes the
 *  text search if its metadata matches `filter.query`, or (union) if its
 *  paneId is in `filter.contentMatchedIds`. */
export function filterHistoryEntries<T extends HistoryTitleEntry & {
  removedAt?: string
  origin?: 'manual' | 'pipeline' | 'mcp'
  roleKey?: string
  roleLabel?: string
  starred?: boolean
}>(entries: T[], filter: HistoryEntryFilter): T[] {
  return entries.filter((entry) => {
    if (filter.status === 'active' && entry.removedAt) return false
    if (filter.status === 'removed' && !entry.removedAt) return false
    if (filter.origin === 'pipeline' && entry.origin !== 'pipeline') return false
    // The 'manual' filter means "not a pipeline pane" — mcp-spawned panes belong here too.
    if (filter.origin === 'manual' && entry.origin === 'pipeline') return false
    if (filter.starredOnly && !entry.starred) return false
    if (matchesHistorySearch(entry, filter.query)) return true
    return !!filter.contentMatchedIds?.has(entry.paneId)
  })
}

export type HistoryDayGroupKey = 'today' | 'yesterday' | 'earlier'

export interface HistoryDayGroup<T> {
  key: HistoryDayGroupKey
  entries: T[]
}

/** Buckets entries into today / yesterday / earlier by the local calendar
 *  day of `spawnedAt` relative to `now` (injected for testability). Entries
 *  with a missing or unparseable spawnedAt land in 'earlier'. Empty buckets
 *  are omitted; bucket order is today, yesterday, earlier. */
export function groupHistoryByDay<T extends { spawnedAt?: string }>(
  entries: T[],
  now: Date
): HistoryDayGroup<T>[] {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  const buckets: Record<HistoryDayGroupKey, T[]> = { today: [], yesterday: [], earlier: [] }
  for (const entry of entries) {
    const ts = entry.spawnedAt ? new Date(entry.spawnedAt).getTime() : Number.NaN
    const key: HistoryDayGroupKey = Number.isNaN(ts)
      ? 'earlier'
      : ts >= todayStart
        ? 'today'
        : ts >= yesterdayStart
          ? 'yesterday'
          : 'earlier'
    buckets[key].push(entry)
  }
  return (['today', 'yesterday', 'earlier'] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, entries: buckets[key] }))
}

export type HistoryCleanupMode = 'removed' | 'older_than'

/** What a delete asks the backend to remove — the renderer half of a
 *  `project.delete_spawn_history` payload (mode + its selector). */
export interface HistoryDeleteTarget {
  mode: 'ids' | HistoryCleanupMode
  paneIds?: string[]
  cutoffIso?: string
}

/** Dry-run answer for a `HistoryDeleteTarget`: deleting a history entry also
 *  unlinks its CLI transcript log, so the confirmation has to name the files
 *  and the bytes at stake before the user agrees. */
export interface HistoryDeletePreview {
  entries: number
  logFiles: number
  freedBytes: number
}

export const HISTORY_CLEANUP_DAYS = 7

/** ISO cutoff for the "older than" cleanup: `days` before `now`. */
export function historyCleanupCutoffIso(now: Date, days = HISTORY_CLEANUP_DAYS): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

/** True when a cleanup of `mode` would delete this entry. Mirrors the
 *  backend predicate (SpawnHistoryStore.delete_entries): only removed
 *  entries are ever bulk-cleaned, starred entries always survive bulk
 *  cleanup; 'older_than' additionally requires a parseable spawnedAt
 *  strictly before the cutoff. */
export function historyCleanupMatches(
  entry: { removedAt?: string; spawnedAt?: string; starred?: boolean },
  mode: HistoryCleanupMode,
  cutoffIso?: string
): boolean {
  if (!entry.removedAt || entry.starred) return false
  if (mode === 'removed') return true
  if (!cutoffIso || !entry.spawnedAt) return false
  const spawned = new Date(entry.spawnedAt).getTime()
  const cutoff = new Date(cutoffIso).getTime()
  return !Number.isNaN(spawned) && !Number.isNaN(cutoff) && spawned < cutoff
}

export function countHistoryCleanupEntries(
  entries: { removedAt?: string; spawnedAt?: string; starred?: boolean }[],
  mode: HistoryCleanupMode,
  cutoffIso?: string
): number {
  return entries.filter((entry) => historyCleanupMatches(entry, mode, cutoffIso)).length
}

export function updateHistoryCustomName(
  entries: HistoryTitleEntry[],
  identity: string | HistoryTitleIdentity,
  customName?: string
): boolean {
  const source = typeof identity === 'string' ? { paneId: identity } : identity
  let updated = false
  const nameToSet = customName?.trim() || undefined

  for (const candidate of entries) {
    if (candidate.paneId === source.paneId) {
      candidate.customName = nameToSet
      updated = true
      continue
    }

    // A vendor with a per-pane session home keeps that home id stable across
    // restores, so it identifies the same conversation even after the pane id
    // changed — which is what a rename has to follow.
    const sessionHomeId = source.sessionHomeId?.trim()
    if (source.agentKey && usesSessionHome(source.agentKey) && sessionHomeId) {
      if (candidate.agentKey === source.agentKey
        && (candidate.sessionHomeId?.trim() === sessionHomeId || candidate.paneId === sessionHomeId)) {
        candidate.customName = nameToSet
        updated = true
        continue
      }
    }

    const agentKey = source.agentKey
    const sessionId = agentKey && source.sessionId ? normalizeResumeSessionId(agentKey, source.sessionId) : ''
    if (agentKey && sessionId) {
      if (candidate.agentKey === agentKey && !!candidate.sessionId && normalizeResumeSessionId(agentKey, candidate.sessionId) === sessionId) {
        candidate.customName = nameToSet
        updated = true
        continue
      }
    }
  }

  return updated
}

export interface LegacyHistoryLogPathEntry {
  spawnedAt: string
  origin: 'manual' | 'pipeline' | 'mcp'
  stageId: string
  paneId: string
  agentKey: string
}

/** Filename used for a manual-session conversation log:
 *  `<agentKey>-<first 8 chars of paneId>.log`. Shared by legacyHistoryLogPath
 *  and the outputLogFile-less search fallback so both stay in sync. */
export function manualLogFileName(agentKey: string, paneId: string): string {
  return `${agentKey}-${paneId.slice(0, 8)}.log`
}

/** Reconstructs the conversation log path for spawnHistory entries persisted
 *  before outputLogFile was recorded at spawn time. Best-effort: assumes the
 *  workspace and UTC spawn date used at spawn time, which may drift. */
export function legacyHistoryLogPath(entry: LegacyHistoryLogPathEntry, workspacePath: string): string {
  const ymd = new Date(entry.spawnedAt).toISOString().slice(0, 10).replace(/-/g, '')
  return entry.origin === 'pipeline'
    ? `${workspacePath}/.agent-team/stage-${entry.stageId}-${entry.paneId.slice(0, 8)}.log`
    : `${workspacePath}/.agent-team/manual/${ymd}/${manualLogFileName(entry.agentKey, entry.paneId)}`
}
