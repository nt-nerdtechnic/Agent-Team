/** Which panes the stage draws, in two layers.
 *
 *  A window can hold several workspaces and runs panes in all of them, but
 *  draws one workspace at a time; within that workspace, a run-group tab
 *  narrows it further. Getting either layer wrong is invisible until something
 *  else disagrees with it — a tab counting panes it will not show, or a
 *  focused pane the grid filters out leaving an empty stage next to a full
 *  agent list.
 */

/** The only fields of a pane these functions read. */
export interface VisibilityPane {
  id: string
  workspacePath: string
  runGroupId?: string
}

const norm = (p: string): string => p.replace(/\/+$/, '')

/** The panes of the workspace on screen.
 *
 *  Only the OTHER workspaces this window holds are excluded. A pane whose
 *  workspace is in neither list — a manual resume can pull a session in from
 *  any folder — stays visible exactly as it did before workspaces were a
 *  layer. With nothing held back this returns the input array ITSELF, which is
 *  what makes a single-workspace window behave identically.
 */
export function panesOfViewedWorkspace<P extends VisibilityPane>(
  panes: readonly P[],
  otherWorkspaces: readonly string[],
): readonly P[] {
  if (!otherWorkspaces.length) return panes
  const held = new Set(otherWorkspaces.map(norm))
  if (!held.size) return panes
  return panes.filter((p) => !held.has(norm(p.workspacePath)))
}

export interface TabFilter {
  /** False when the window shows no run-group tabs at all. */
  hasTabs: boolean
  /** The selected tab: a run-group id, the synthetic 'manual', or ''. */
  activeTab: string
  /** Run-group ids that exist in the workspace on screen. */
  groupIds: readonly string[]
}

/** Narrow a workspace's panes to the selected tab.
 *
 *  A run-group id is per workspace, so a tab id from the workspace you just
 *  left matches nothing here — the fallback returns everything rather than
 *  leaving the stage blank while the new workspace's tabs load.
 */
export function panesOfActiveTab<P extends VisibilityPane>(
  panes: readonly P[],
  { hasTabs, activeTab, groupIds }: TabFilter,
): Set<string> {
  const all = (): Set<string> => new Set(panes.map((p) => p.id))
  if (!hasTabs) return all()
  // The synthetic tab for panes that belong to no run group.
  if (activeTab === 'manual') return new Set(panes.filter((p) => !p.runGroupId).map((p) => p.id))
  if (activeTab && groupIds.includes(activeTab)) {
    return new Set(panes.filter((p) => p.runGroupId === activeTab).map((p) => p.id))
  }
  return all()
}
