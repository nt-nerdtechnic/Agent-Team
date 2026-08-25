import type { LineageRow } from './workspaceGroups'

export type { LineageRow }

/** The only fields of a pane this file reads. */
export interface LineagePane {
  id: string
  /** The pane that spawned this one, when it was spawned by another. */
  spawnedBy?: string
}

/** Flatten the spawn tree into the order the sidebar renders it.
 *
 *  Depth-first from the roots, each pane followed by its descendants. Three
 *  situations decide the shape, and each is a real state rather than a
 *  defensive guess:
 *
 *  - **A parent that is not present** — closed in another window, or a record
 *    that predates lineage being persisted. Its child becomes a root rather
 *    than disappearing with it.
 *  - **A collapsed pane** — its descendants are left out entirely, which is
 *    what makes range selection over this list collapse-aware for free.
 *  - **A cycle** the backend's guard did not catch (hand-edited state, or a
 *    record from an older build). The walk cannot reach those panes, so they
 *    are appended as roots — listing them wrongly beats dropping them.
 */
export function buildPaneLineage(
  panes: readonly LineagePane[],
  collapsed: ReadonlySet<string>,
): LineageRow[] {
  const ids = new Set(panes.map((p) => p.id))
  const childrenOf = new Map<string, string[]>()
  for (const p of panes) {
    const parent = p.spawnedBy && ids.has(p.spawnedBy) && p.spawnedBy !== p.id ? p.spawnedBy : ''
    const bucket = childrenOf.get(parent)
    if (bucket) bucket.push(p.id)
    else childrenOf.set(parent, [p.id])
  }

  const rows: LineageRow[] = []
  const seen = new Set<string>()
  // Descendants of a collapsed pane. The walk does not reach them, and the
  // unreachable sweep at the end must not mistake that for a cycle: appending
  // them as roots put a folded subtree back on screen, unindented, at the
  // bottom of the list.
  const folded = new Set<string>()
  const fold = (parent: string): void => {
    for (const id of childrenOf.get(parent) ?? []) {
      if (folded.has(id)) continue
      folded.add(id)
      fold(id)
    }
  }

  const walk = (parent: string, depth: number): void => {
    for (const id of childrenOf.get(parent) ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      const isCollapsed = collapsed.has(id)
      rows.push({
        id,
        depth,
        hasChildren: (childrenOf.get(id)?.length ?? 0) > 0,
        collapsed: isCollapsed,
      })
      if (isCollapsed) fold(id)
      else walk(id, depth + 1)
    }
  }
  walk('', 0)

  for (const p of panes) {
    if (seen.has(p.id) || folded.has(p.id)) continue
    rows.push({ id: p.id, depth: 0, hasChildren: false, collapsed: false })
  }
  return rows
}
