// Pure range-selection for Shift-click on pane lists (GitPane semantics):
// selects every id between the anchor and the target, inclusive, in the
// rendering order of the surface that was clicked — so a range never sweeps
// in panes that surface does not show (minimized, other tab, other grid page).

/**
 * @param orderedIds Pane ids in the clicked surface's actual render order.
 * @param anchorId   Resolved anchor (last-clicked pane, or the focused pane
 *                   as fallback); null when neither exists.
 * @param targetId   The shift-clicked pane.
 * @returns The new selection. Falls back to only the target when the anchor
 *          is missing or not part of the surface's order.
 */
export function computeRangeSelection(
  orderedIds: string[],
  anchorId: string | null,
  targetId: string
): Set<string> {
  const from = anchorId ? orderedIds.indexOf(anchorId) : -1
  const to = orderedIds.indexOf(targetId)
  if (from === -1 || to === -1) return new Set([targetId])
  const [a, b] = from <= to ? [from, to] : [to, from]
  return new Set(orderedIds.slice(a, b + 1))
}
