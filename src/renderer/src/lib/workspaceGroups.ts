import { collapseHomePath } from '@navide/terminal'

/** One row of the lineage tree: a pane id and where it sits in the subtree.
 *
 *  Every field is pure structure — ids and spawn pointers, never a pane's live
 *  status or name. That is what lets this list be rebuilt only when the tree
 *  actually changes instead of on every 400ms status sync. */
export interface LineageRow {
  id: string
  depth: number
  hasChildren: boolean
  collapsed: boolean
  /** The panes this one hangs under, outermost first; empty for a root. Ids,
   *  not names — a name is live state, and joining the two is the renderer's
   *  job. */
  ancestors: readonly string[]
  /** How many panes descend from this one, at any depth. Counted whether or
   *  not they are currently drawn, because a folded row shows this number in
   *  place of the children it is hiding. */
  descendantCount: number
}

/** One run group's slice of a workspace's panes.
 *
 *  A group's rows are whole lineage subtrees: an MCP child inherits its
 *  parent's runGroupId at spawn, so grouping can never separate a child from
 *  its parent. That is what lets the group layer sit above the lineage layer
 *  without either having to know about the other. */
export interface PaneGroupSection {
  /** The run group's id; empty for panes that belong to no group. */
  id: string
  /** Its name; empty for the ungrouped section, which the caller labels. */
  name: string
  rows: LineageRow[]
}

export interface WorkspaceGroupInput {
  /** The workspace on screen. */
  here: string
  /** Every workspace this window holds, in the order it took them on. */
  order: readonly string[]
  /** This window's panes; id, workspacePath and run group are read. */
  panes: readonly { id: string; workspacePath: string; runGroupId?: string }[]
  /** The whole window's lineage, in render order. */
  lineage: readonly LineageRow[]
  /** The run groups of the workspace on screen, in tab order. This is the
   *  live list the tab bar edits, so it can sit ahead of what was persisted. */
  runGroups: readonly { id: string; name: string }[]
  /** Every OTHER held workspace's run groups, keyed by path with trailing
   *  slashes trimmed.
   *
   *  Groups are persisted per workspace, and this used to hold only the viewed
   *  one's, so the sidebar had nothing to group any other workspace's panes by
   *  and listed them flat: a project's Run sections vanished the moment you
   *  switched away, though its records were intact on disk. The window loads
   *  each held workspace's list and keeps it here. */
  runGroupsByWorkspace: Readonly<Record<string, readonly { id: string; name: string }[]>>
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
  /** Every row of this workspace, in RENDER order — which is the grouped order,
   *  not spawn order. Shift-range selection walks this, so it has to be what
   *  the eye walks. */
  lineage: LineageRow[]
  /** The same rows, split into their run groups. */
  groups: PaneGroupSection[]
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
  const { here, order, panes, lineage, runGroups, runGroupsByWorkspace, collapsed, homeDir } =
    input
  const rows: WorkspaceGroupRow[] = []

  // A pane records the workspace it was started in, and an MCP child inherits
  // its parent's, so each workspace's panes form whole subtrees of the lineage
  // — filtering it per workspace cannot orphan a child from its parent.
  const paneWorkspace = new Map(panes.map((p) => [p.id, norm(p.workspacePath)]))
  const paneGroup = new Map(panes.map((p) => [p.id, p.runGroupId ?? '']))
  const lineageFor = (path: string): LineageRow[] =>
    lineage.filter((r) => paneWorkspace.get(r.id) === norm(path))

  /** Split one workspace's rows into its run groups.
   *
   *  Group order follows the tab bar, so the sidebar and the tabs name things
   *  in the same sequence. The ungrouped rows come last: they are what is left
   *  over rather than a group of their own, and putting them first would make
   *  every workspace with one stray manual pane open on it.
   *
   *  Empty groups are dropped. A group with no panes is a tab, not a section —
   *  a heading with nothing under it is a dead row that cannot be collapsed
   *  into anything. */
  const sectionsFor = (path: string, rows: readonly LineageRow[]): PaneGroupSection[] => {
    // The viewed workspace splits by the live list the tab bar edits; every
    // other held one by the copy loaded when the window took it on.
    const groupsOf =
      norm(path) === norm(here) ? runGroups : (runGroupsByWorkspace[norm(path)] ?? [])
    const byGroup = new Map<string, LineageRow[]>()
    for (const r of rows) {
      const gid = paneGroup.get(r.id) ?? ''
      const list = byGroup.get(gid)
      if (list) list.push(r)
      else byGroup.set(gid, [r])
    }
    const out: PaneGroupSection[] = []
    for (const g of groupsOf) {
      const own = byGroup.get(g.id)
      if (own?.length) out.push({ id: g.id, name: g.name, rows: own })
    }
    const loose = byGroup.get('')
    if (loose?.length) out.push({ id: '', name: '', rows: loose })
    // A group the tab bar does not list — another workspace's, or one deleted
    // while its panes lived on. Its rows still belong on screen, so they land
    // with the ungrouped rather than vanishing.
    for (const [gid, own] of byGroup) {
      if (gid === '' || groupsOf.some((g) => g.id === gid)) continue
      const tail = out.find((sec) => sec.id === '')
      if (tail) tail.rows.push(...own)
      else out.push({ id: '', name: '', rows: own })
    }
    return out
  }

  const pushRow = (path: string): void => {
    const own = lineageFor(path)
    const groups = sectionsFor(path, own)
    rows.push({
      path,
      label: basename(path),
      displayPath: workspaceParentPath(path, homeDir),
      isCurrent: true,
      collapsed: collapsed.has(path),
      count: own.length,
      // Grouped order, not spawn order — this is what the sidebar renders, and
      // shift-range selection walks it.
      lineage: groups.flatMap((g) => g.rows),
      groups,
    })
  }

  // `here` is appended in case this runs before it joins the order list; the
  // seen set keeps that from listing it twice.
  const seenLocal = new Set<string>()
  for (const path of [...order, ...(here ? [here] : [])]) {
    if (!path || seenLocal.has(norm(path))) continue
    seenLocal.add(norm(path))
    pushRow(path)
  }

  // A pane whose workspace is in neither list still has to be listed. Detaching
  // a workspace takes it out of the order without taking its panes with it, and
  // a manual resume can start one in a folder this window never adopted. The
  // stage shows those panes either way; leaving them out here left them with no
  // heading to sit under, which is not "hidden" but missing — and a restore
  // placeholder among them could not be opened from anywhere else.
  for (const pane of panes) {
    const path = pane.workspacePath
    if (!path || seenLocal.has(norm(path))) continue
    seenLocal.add(norm(path))
    pushRow(path)
  }

  return rows
}
