/** Workspace rails: the sidebar's outermost layer.
 *
 *  A rail is a named set of workspaces shown as one cell on a narrow strip
 *  down the sidebar's left edge. Picking a cell filters the list to that set,
 *  so only one rail's workspaces are on screen at a time — which is what keeps
 *  the list one screen tall however many projects the window holds.
 *
 *  DELIBERATELY A VIEW LAYER. Nothing here reaches a pane, a run group or the
 *  backend: a rail only ever says which workspace headings to draw. That is
 *  what lets the strip sit outside the existing workspace → run group → pane
 *  → lineage stack without any of those four knowing it exists.
 *
 *  Per window and not shared, the same judgement `workspaceOrder` makes: the
 *  rails live in sessionStorage, so a second window groups its own projects
 *  its own way and a restart starts clean. Moving to one shared set later is a
 *  swap of `parseRails`/`serializeRails` for a kv read/write — no other
 *  function here changes.
 */

/** The always-present first cell: every workspace, unfiltered. Its id is empty
 *  rather than a name like `all` so it can never collide with a real rail id,
 *  and so "no rail chosen" and "the All rail" are the same state. */
export const ALL_RAIL_ID = ''

export interface WorkspaceRail {
  /** Minted as `wr-<epoch ms>`, matching run groups' `rg-` ids. */
  id: string
  name: string
  /** Workspace paths, normalised. A path appears in at most one rail. */
  members: string[]
}

/** One cell of the strip, ready to render. */
export interface RailCell {
  id: string
  /** The one character drawn in the cell. */
  glyph: string
  /** The full name, for the tooltip and the list heading. */
  name: string
  /** Panes across this rail's held workspaces — the superscript count. */
  count: number
  active: boolean
  /** The workspace on screen belongs to this rail. Drawn as a dot, because
   *  switching rails deliberately does NOT move you: without it, stepping away
   *  from your own rail leaves nothing on screen saying where you still are. */
  hasCurrent: boolean
  /** No member of this rail is open in this window. Not hidden — that cell is
   *  the way back to a group of projects you closed. */
  empty: boolean
}

/** Rows this module needs from a workspace heading. Structural on purpose, so
 *  callers can pass `WorkspaceGroupRow` without this file importing it. */
interface RailRow {
  path: string
  count: number
}

const norm = (p: string): string => p.replace(/\/+$/, '')

/** A workspace path in the shape rail membership is compared in. */
export function normalizeRailPath(path: string): string {
  return norm(path)
}

export function newRailId(now: number = Date.now()): string {
  return `wr-${now}`
}

/** The single character a cell shows.
 *
 *  Code POINTS, not code units: `[0]` on an emoji name yields half a surrogate
 *  pair, which renders as a replacement glyph. A CJK first character carries
 *  as much meaning here as a whole word would — which is why the cell needs no
 *  icon to maintain. */
export function railGlyph(name: string): string {
  return Array.from(name.trim())[0] ?? '?'
}

/** Which rail a workspace belongs to; `ALL_RAIL_ID` when it belongs to none. */
export function railIdOf(rails: readonly WorkspaceRail[], path: string): string {
  const p = norm(path)
  return rails.find((r) => r.members.some((m) => norm(m) === p))?.id ?? ALL_RAIL_ID
}

/** Move a workspace into one rail, or out of all of them with `ALL_RAIL_ID`.
 *
 *  Membership is exclusive: the path is dropped from every other rail first.
 *  Two rails claiming the same workspace would make their counts add up to
 *  more panes than the window has, and the strip's whole job is to be a
 *  trustworthy tally of where the work is. */
export function assignToRail(
  rails: readonly WorkspaceRail[],
  path: string,
  railId: string
): WorkspaceRail[] {
  const p = norm(path)
  if (!p) return [...rails]
  return rails.map((r) => {
    const without = r.members.filter((m) => norm(m) !== p)
    const members = r.id === railId && railId !== ALL_RAIL_ID ? [...without, p] : without
    return members.length === r.members.length && members.every((m, i) => m === r.members[i])
      ? r
      : { ...r, members }
  })
}

/** Add a rail. An empty or whitespace-only name is refused — a cell whose
 *  glyph is a space is an invisible button. */
export function createRail(
  rails: readonly WorkspaceRail[],
  name: string,
  now: number = Date.now()
): WorkspaceRail[] {
  const trimmed = name.trim()
  if (!trimmed) return [...rails]
  return [...rails, { id: newRailId(now), name: trimmed, members: [] }]
}

export function renameRail(
  rails: readonly WorkspaceRail[],
  id: string,
  name: string
): WorkspaceRail[] {
  const trimmed = name.trim()
  if (!trimmed) return [...rails]
  return rails.map((r) => (r.id === id ? { ...r, name: trimmed } : r))
}

/** Remove a rail. Its members are not touched — they simply stop being in any
 *  rail and show up under All, which is where an ungrouped project lives. */
export function deleteRail(rails: readonly WorkspaceRail[], id: string): WorkspaceRail[] {
  return rails.filter((r) => r.id !== id)
}

/** The rail actually in effect.
 *
 *  A stored id can outlive the rail it names — deleted here, or restored into
 *  a window whose rails were never created. Falling back to All rather than
 *  filtering by a rail that no longer exists is the difference between "no
 *  filter" and an empty sidebar with no visible cause. */
export function resolveActiveRail(rails: readonly WorkspaceRail[], activeId: string): string {
  if (!activeId) return ALL_RAIL_ID
  return rails.some((r) => r.id === activeId) ? activeId : ALL_RAIL_ID
}

/** The workspace headings one rail shows. All shows every one.
 *
 *  Generic in the row type so the caller keeps its own richer row: this only
 *  ever reads `path`. */
export function filterRowsByRail<T extends { path: string }>(
  rows: readonly T[],
  rails: readonly WorkspaceRail[],
  activeId: string
): T[] {
  const id = resolveActiveRail(rails, activeId)
  if (id === ALL_RAIL_ID) return [...rows]
  const members = new Set((rails.find((r) => r.id === id)?.members ?? []).map(norm))
  return rows.filter((row) => members.has(norm(row.path)))
}

/** Every cell of the strip, All first.
 *
 *  `allLabel` comes from i18n rather than a constant here: the cell shows its
 *  first character, and that character has to be the one the interface's own
 *  language would use.
 *
 *  The All cell's `hasCurrent` is always false. It holds the current workspace
 *  by definition, so a dot on it would mark nothing. */
export function buildRailCells(input: {
  rails: readonly WorkspaceRail[]
  rows: readonly RailRow[]
  currentPath: string
  activeId: string
  allLabel: string
}): RailCell[] {
  const { rails, rows, currentPath, activeId, allLabel } = input
  const active = resolveActiveRail(rails, activeId)
  const here = norm(currentPath)
  const countOf = new Map(rows.map((r) => [norm(r.path), r.count]))

  const all: RailCell = {
    id: ALL_RAIL_ID,
    glyph: railGlyph(allLabel),
    name: allLabel,
    count: rows.reduce((sum, r) => sum + r.count, 0),
    active: active === ALL_RAIL_ID,
    hasCurrent: false,
    empty: rows.length === 0,
  }

  const cells = rails.map((rail) => {
    const held = rail.members.map(norm).filter((m) => countOf.has(m))
    return {
      id: rail.id,
      glyph: railGlyph(rail.name),
      name: rail.name,
      count: held.reduce((sum, m) => sum + (countOf.get(m) ?? 0), 0),
      active: active === rail.id,
      hasCurrent: !!here && rail.members.some((m) => norm(m) === here),
      empty: held.length === 0,
    }
  })

  return [all, ...cells]
}

/** Read the stored rails, surviving anything that is not what we wrote.
 *
 *  Corrupt or foreign data yields `[]` rather than throwing: the strip is a
 *  convenience layered over a list that works without it, so a bad blob must
 *  cost the grouping, never the sidebar. Entries are validated one by one —
 *  a single malformed rail drops itself, not the rest. */
export function parseRails(raw: string | null): WorkspaceRail[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: WorkspaceRail[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const rail = item as Partial<WorkspaceRail>
    if (typeof rail.id !== 'string' || !rail.id || seen.has(rail.id)) continue
    if (typeof rail.name !== 'string' || !rail.name.trim()) continue
    const members = Array.isArray(rail.members)
      ? rail.members.filter((m): m is string => typeof m === 'string' && !!m).map(norm)
      : []
    seen.add(rail.id)
    // Exclusive membership is an invariant of the model, so it is enforced on
    // the way in too: a hand-edited or half-written blob must not make two
    // cells count the same panes.
    const mine = members.filter((m) => !out.some((r) => r.members.includes(m)))
    out.push({ id: rail.id, name: rail.name.trim(), members: [...new Set(mine)] })
  }
  return out
}

export function serializeRails(rails: readonly WorkspaceRail[]): string {
  return JSON.stringify(rails)
}
