/** Browser-tab style pane cycling: Ctrl+Tab / Ctrl+Shift+Tab walk the visible
 *  pane list and wrap around at both ends. */

export type CycleDirection = 1 | -1

/** Next pane id in `orderedIds` relative to `currentId`, wrapping around.
 *  Returns null for an empty list. When `currentId` is absent from the list
 *  (never focused, minimized, or on another tab) the walk starts from the end
 *  the user is heading towards. */
export function nextPaneId(
  orderedIds: string[],
  currentId: string | null,
  direction: CycleDirection,
): string | null {
  if (orderedIds.length === 0) return null
  const idx = currentId ? orderedIds.indexOf(currentId) : -1
  if (idx === -1) return direction === 1 ? orderedIds[0] : orderedIds[orderedIds.length - 1]
  return orderedIds[(idx + direction + orderedIds.length) % orderedIds.length]
}
