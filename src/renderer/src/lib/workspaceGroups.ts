import { collapseHomePath } from './paths'

/** One row of the lineage tree: a pane id and where it sits in the subtree. */
export interface LineageRow {
  id: string
  depth: number
  hasChildren: boolean
  collapsed: boolean
}

export interface WorkspaceGroupInput {
  /** The workspace on screen. */
  here: string
  /** Every workspace this window holds, in the order it took them on. */
  order: readonly string[]
  /** This window's panes; only id and workspacePath are read. */
  panes: readonly { id: string; workspacePath: string }[]
  /** The whole window's lineage, in render order. */
  lineage: readonly LineageRow[]
  collapsed: ReadonlySet<string>
  homeDir: string
}

export interface WorkspaceGroupRow {
  path: string
  label: string
  displayPath: string
  isCurrent: boolean
  collapsed: boolean
  count: number
  lineage: LineageRow[]
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

/** The sidebar's outer layer: one row per workspace this window holds.
 *
 *  STRUCTURE ONLY — ids, paths and counts. Nothing here reads live pane status,
 *  so the 400ms status sync does not rebuild it; the list renders these rows
 *  and looks each pane's status up separately.
 *
 *  Only workspaces THIS window holds. It used to list two more bands — what
 *  other windows were running, and what was open with no CLI yet — which made
 *  the same project appear in every window at once, one copy live and the rest
 *  read-only. A window is its own space; what another one is doing belongs to
 *  that window.
 *
 *  Ordered by when the window took each on, NOT viewed-first: deriving the
 *  order from what is on screen makes the list reshuffle on every switch.
 */
export function buildWorkspaceGroups(input: WorkspaceGroupInput): WorkspaceGroupRow[] {
  const { here, order, panes, lineage, collapsed, homeDir } = input
  const rows: WorkspaceGroupRow[] = []

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
    })
  }

  return rows
}
