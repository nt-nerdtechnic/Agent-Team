/**
 * plansPaneModel.ts
 *
 * Pure list-shaping helpers for PlansPane: search matching, row ordering, and
 * the fail-safe localStorage persistence for the pane's stage filter, sort and
 * grouping choices. Extracted from PlansPane.vue so the logic is unit-testable
 * without mounting the component.
 */

export const PLAN_SORT_MODES = ['title', 'updated', 'progress'] as const
export type PlanSortMode = (typeof PLAN_SORT_MODES)[number]

export const PLAN_SORT_DIRECTIONS = ['asc', 'desc'] as const
export type PlanSortDirection = (typeof PLAN_SORT_DIRECTIONS)[number]

/**
 * The direction each mode starts in — the one users expect when they pick it:
 * A→Z for titles, newest and most-complete first for the other two. Switching
 * mode resets the direction to this; the arrow button then flips it.
 */
export const DEFAULT_SORT_DIRECTION: Record<PlanSortMode, PlanSortDirection> = {
  title: 'asc',
  updated: 'desc',
  progress: 'desc',
}

/** Flat = one list across every stage; stage = the per-stage groups. */
export const PLAN_GROUP_MODES = ['flat', 'stage'] as const
export type PlanGroupMode = (typeof PLAN_GROUP_MODES)[number]

export interface PlanSearchFields {
  title: string
  filename: string
  overview?: string
}

/** Case-insensitive substring match over title, filename and overview. */
export function planMatchesQuery(query: string, fields: PlanSearchFields): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    fields.title.toLowerCase().includes(q) ||
    fields.filename.toLowerCase().includes(q) ||
    (fields.overview ?? '').toLowerCase().includes(q)
  )
}

export interface SortablePlanRow {
  title: string
  /** File mtime in seconds; undefined when the backend did not report one. */
  mtime?: number
  done: number
  total: number
}

/**
 * Locale title order with numeric collation, so "Plan 2" precedes "Plan 10".
 */
function compareTitles(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}

/**
 * Comparator for list ordering.
 * - 'title': locale order by plan title.
 * - 'updated': file mtime order ('desc' = newest first).
 * - 'progress': done/total ratio order ('desc' = most complete first).
 * Rows missing the sort key (no mtime, no todos) sink to the bottom in BOTH
 * directions — flipping the arrow must not float unknowns to the top. Ties
 * always fall back to ascending title order so the result is stable.
 */
export function comparePlanRows(
  mode: PlanSortMode,
  a: SortablePlanRow,
  b: SortablePlanRow,
  direction: PlanSortDirection = DEFAULT_SORT_DIRECTION[mode],
): number {
  const sign = direction === 'asc' ? 1 : -1
  if (mode === 'updated') {
    const missing = Number(a.mtime === undefined) - Number(b.mtime === undefined)
    if (missing !== 0) return missing
    const diff = (a.mtime ?? 0) - (b.mtime ?? 0)
    if (diff !== 0) return diff * sign
  } else if (mode === 'progress') {
    const missing = Number(a.total <= 0) - Number(b.total <= 0)
    if (missing !== 0) return missing
    if (a.total > 0 && b.total > 0) {
      const diff = a.done / a.total - b.done / b.total
      if (diff !== 0) return diff * sign
    }
  } else {
    const diff = compareTitles(a.title, b.title)
    if (diff !== 0) return diff * sign
  }
  return compareTitles(a.title, b.title)
}

/**
 * Fail-safe localStorage read of a persisted choice: anything missing,
 * unreadable, or outside `allowed` falls back to `fallback` — a storage
 * problem must never break the pane (same contract as the collapse state).
 */
export function loadStoredChoice<T extends string>(
  storageKey: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw !== null && (allowed as readonly string[]).includes(raw)) return raw as T
    return fallback
  } catch {
    return fallback
  }
}

export function saveStoredChoice(storageKey: string, value: string): void {
  try {
    localStorage.setItem(storageKey, value)
  } catch {
    // Storage unavailable (quota/private mode) — persistence is best-effort.
  }
}
