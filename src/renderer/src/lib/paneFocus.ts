import type { LineageRow } from './workspaceGroups'

/** Which pane the stage focuses, and the order the sidebar walks.
 *
 *  Both answer questions about panes the screen can actually show, and both
 *  produced a visible fault when they answered about panes it could not: a
 *  focused pane the grid filters out leaves an empty main area beside a full
 *  agent list, and a range that walks the wrong order selects rows the user
 *  did not sweep over.
 */

export interface FocusablePane {
  id: string
}

/** The focused pane, or the first one that can stand in for it.
 *
 *  `panes` must already be the workspace on screen: sidebar and spotlight
 *  render this pane and nothing else, so naming one from another workspace
 *  renders nothing at all.
 */
export function resolveFocusedPane(
  requested: string | null,
  panes: readonly FocusablePane[],
  minimized: ReadonlySet<string>,
): string | null {
  if (requested && !minimized.has(requested) && panes.some((p) => p.id === requested)) {
    return requested
  }
  // A minimized pane is docked, not on the stage — falling back to it would
  // leave the stage empty just as surely.
  return panes.find((p) => !minimized.has(p.id))?.id ?? null
}

export interface SidebarSection {
  /** True for a workspace this window runs panes in. */
  isCurrent: boolean
  lineage: readonly LineageRow[]
}

/** The order the sidebar renders panes in: each of this window's workspaces in
 *  turn, its lineage flattened.
 *
 *  Shift-range selection walks this. It used to walk the flat spawn order,
 *  which stopped matching the moment the list gained indentation and stopped
 *  matching further once it gained workspace sections. Rows from other windows
 *  are skipped — this window has no terminal for those panes.
 */
export function flattenSidebarOrder(sections: readonly SidebarSection[]): string[] {
  const out: string[] = []
  for (const section of sections) {
    if (!section.isCurrent) continue
    for (const row of section.lineage) out.push(row.id)
  }
  return out
}
