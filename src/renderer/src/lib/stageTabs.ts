/** The tab strip above the stage, as structure only.
 *
 *  One tab per run group that this window shows, plus a synthetic tab for
 *  panes that belong to no group. No live status is read here — the strip
 *  renders these shapes and looks each pane's status up separately, so a
 *  status dot ticking does not rebuild the strip.
 */

export interface TabPane {
  id: string
  runGroupId?: string
}

export interface RunGroupLike {
  id: string
  name: string
}

export interface StageTabShape {
  key: string
  label: string
  count: number
  type: 'stage' | 'manual'
  paneIds: string[]
}

export interface StageTabInput {
  /** The panes of the workspace on screen — already workspace-filtered, so a
   *  tab never counts a pane the stage will not show. */
  panes: readonly TabPane[]
  /** Run groups of the workspace on screen. */
  groups: readonly RunGroupLike[]
  /** True in a detached child window. */
  isDetached: boolean
  /** The group a detached window was detached for. */
  detachedGroupId: string
  /** Groups this main window has handed off to detached children. */
  detachedGroupIds: ReadonlySet<string>
  /** Label for the synthetic tab holding ungrouped panes. */
  manualLabel: string
}

export function buildStageTabs(input: StageTabInput): StageTabShape[] {
  const { panes, groups, isDetached, detachedGroupId, detachedGroupIds, manualLabel } = input

  const byGroup = new Map<string, string[]>()
  const ungrouped: string[] = []
  for (const p of panes) {
    if (!p.runGroupId) {
      ungrouped.push(p.id)
      continue
    }
    const list = byGroup.get(p.runGroupId)
    if (list) list.push(p.id)
    else byGroup.set(p.runGroupId, [p.id])
  }

  const shapes: StageTabShape[] = []
  for (const group of groups) {
    // A detached child shows ONLY its own group; a main window hides any group
    // it has handed off to one. Both are inert for an ordinary window
    // (isDetached false, no detached ids).
    if (isDetached) {
      if (group.id !== detachedGroupId) continue
    } else if (detachedGroupIds.has(group.id)) {
      continue
    }
    const paneIds = byGroup.get(group.id) ?? []
    shapes.push({ key: group.id, label: group.name, count: paneIds.length, type: 'stage', paneIds })
  }

  // The synthetic tab exists only while something needs it, and never in a
  // detached window: that window is one group's view and has no ungrouped
  // panes of its own to show.
  if (!isDetached && ungrouped.length > 0) {
    shapes.push({
      key: 'manual',
      label: manualLabel,
      count: ungrouped.length,
      type: 'manual',
      paneIds: ungrouped,
    })
  }
  return shapes
}
