import { collapseHomePath } from './paths'

/** One row of the lineage tree: a pane id and where it sits in the subtree. */
export interface LineageRow {
  id: string
  depth: number
  hasChildren: boolean
  collapsed: boolean
}

/** The only fields of a roster entry this file reads. The caller's own type
 *  flows through unchanged — grouping has no business knowing what else a
 *  registry entry carries. */
export interface RosterEntry {
  pane_id: string
  workspace_path: string
  workspace_label?: string
}

export interface WorkspaceGroupInput<R extends RosterEntry> {
  /** The workspace on screen. */
  here: string
  /** Every workspace this window holds, in the order it took them on. */
  order: readonly string[]
  /** This window's panes; only id and workspacePath are read. */
  panes: readonly { id: string; workspacePath: string }[]
  /** The whole window's lineage, in render order. */
  lineage: readonly LineageRow[]
  /** Panes registered by every window, this one included. */
  roster: readonly R[]
  /** Workspaces open in some window, per main's registry. */
  openPaths: readonly string[]
  collapsed: ReadonlySet<string>
  homeDir: string
}

export interface WorkspaceGroupRow<R extends RosterEntry = RosterEntry> {
  path: string
  label: string
  displayPath: string
  isCurrent: boolean
  collapsed: boolean
  count: number
  lineage: LineageRow[]
  remote: R[]
}

const norm = (p: string): string => p.replace(/\/+$/, '')

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

/** The folder a workspace sits IN, home collapsed to `~`.
 *
 *  The heading already shows the last segment as the name, so repeating it in
 *  the path costs a whole row's width and identifies nothing. What tells two
 *  projects of the same name apart is where they live. */
export function workspaceParentPath(path: string, homeDir: string): string {
  const trimmed = norm(path)
  const cut = trimmed.lastIndexOf('/')
  // A root-level folder has no parent worth showing; fall back to itself.
  if (cut <= 0) return collapseHomePath(trimmed || path, homeDir)
  return collapseHomePath(trimmed.slice(0, cut), homeDir)
}

/** The sidebar's outer layer: one row per workspace, in three bands.
 *
 *  STRUCTURE ONLY — ids, paths and counts. Nothing here reads live pane status,
 *  so the 400ms status sync does not rebuild it; the list renders these rows
 *  and looks each pane's status up separately.
 *
 *  The bands, in order:
 *   1. Workspaces this window holds. Live panes, full controls. Ordered by
 *      when the window took them on, NOT viewed-first — deriving order from
 *      what is on screen makes the list reshuffle on every switch.
 *   2. Workspaces some other window holds, from the messaging registry. It
 *      knows a pane's name, agent and busy flag and nothing else, so these
 *      rows are read-only and click through to the window that owns them.
 *   3. Workspaces open with no CLI started yet. Without these, a workspace
 *      just opened is absent until its first pane registers, which reads as
 *      "it did not open".
 */
export function buildWorkspaceGroups<R extends RosterEntry>(
  input: WorkspaceGroupInput<R>,
): WorkspaceGroupRow<R>[] {
  const { here, order, panes, lineage, roster, openPaths, collapsed, homeDir } = input
  const rows: WorkspaceGroupRow<R>[] = []

  // A pane records the workspace it was started in, and an MCP child inherits
  // its parent's, so each workspace's panes form whole subtrees of the lineage
  // — filtering it per workspace cannot orphan a child from its parent.
  const paneWorkspace = new Map(panes.map((p) => [p.id, norm(p.workspacePath)]))
  const lineageFor = (path: string): LineageRow[] =>
    lineage.filter((r) => paneWorkspace.get(r.id) === norm(path))

  // `here` is appended in case this runs before it joins the order list; the
  // seen set keeps that from listing it twice.
  const seenLocal = new Set<string>()
  for (const path of [...order, ...(here ? [here] : [])]) {
    if (!path || seenLocal.has(norm(path))) continue
    seenLocal.add(norm(path))
    const own = lineageFor(path)
    rows.push({
      path,
      label: basename(path),
      displayPath: workspaceParentPath(path, homeDir),
      isCurrent: true,
      collapsed: collapsed.has(path),
      count: own.length,
      lineage: own,
      remote: [],
    })
  }

  // Panes this window already renders must not appear twice, and neither must
  // one whose workspace this window holds — the roster does not distinguish
  // this window from any other.
  const localIds = new Set(panes.map((p) => p.id))
  const byWorkspace = new Map<string, R[]>()
  for (const entry of roster) {
    const path = entry.workspace_path
    if (!path || seenLocal.has(norm(path)) || localIds.has(entry.pane_id)) continue
    const bucket = byWorkspace.get(path)
    if (bucket) bucket.push(entry)
    else byWorkspace.set(path, [entry])
  }
  for (const [path, entries] of byWorkspace) {
    rows.push({
      path,
      label: entries[0]?.workspace_label || basename(path),
      displayPath: workspaceParentPath(path, homeDir),
      isCurrent: false,
      collapsed: collapsed.has(path),
      count: entries.length,
      lineage: [],
      remote: entries,
    })
  }

  const listed = new Set(rows.map((r) => norm(r.path)))
  for (const path of openPaths) {
    if (!path || listed.has(norm(path))) continue
    listed.add(norm(path))
    rows.push({
      path,
      label: basename(path),
      displayPath: workspaceParentPath(path, homeDir),
      isCurrent: false,
      collapsed: collapsed.has(path),
      count: 0,
      lineage: [],
      remote: [],
    })
  }

  return rows
}
