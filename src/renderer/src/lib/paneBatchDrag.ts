// Batch drag for multi-selected panes: dragging any pane that belongs to a
// multi-selection carries the whole selection, so a reorder, a tab move, or a
// context drop applies to every selected pane instead of just the grabbed one.
// The right-click menu already works this way (ctxTargetIds in App.vue); these
// helpers give the drag surfaces the same semantics.

/**
 * The panes a drag actually carries.
 *
 * @param draggedId   The pane the pointer grabbed.
 * @param selectedIds Current multi-selection (App.vue's selectedPaneIds).
 * @param orderedIds  Pane ids in the order the batch should move in — normally
 *                    the authoritative pane order, so the batch keeps its
 *                    relative arrangement rather than the click order.
 * @returns `[draggedId]` unless the dragged pane is part of a selection of more
 *          than one, in which case the selection in `orderedIds` order. The
 *          dragged pane is always included, even when `orderedIds` omits it.
 */
export function resolveDragBatch(
  draggedId: string,
  selectedIds: ReadonlySet<string> | undefined,
  orderedIds: readonly string[]
): string[] {
  if (!draggedId) return []
  if (!selectedIds || selectedIds.size < 2 || !selectedIds.has(draggedId)) return [draggedId]
  const batch = orderedIds.filter((id) => selectedIds.has(id))
  return batch.includes(draggedId) ? batch : [...batch, draggedId]
}

/**
 * Move every item in `movingIds` to the slot currently occupied by `toId`,
 * mutating `items` in place and preserving the movers' relative order.
 *
 * Drop side follows `reorderByIds`, so the single-mover case behaves exactly as
 * it did before batching existed: a batch that sits entirely above the target
 * lands below it, otherwise it lands above. Unknown movers are skipped; a
 * target inside the batch is a no-op (a pane cannot be dropped onto itself).
 * Returns true only when the order actually changed, so callers can gate
 * persistence on it.
 */
export function reorderBatchByIds<T extends { id: string }>(
  items: T[],
  movingIds: readonly string[],
  toId: string
): boolean {
  const moving = new Set(movingIds)
  if (moving.size === 0 || moving.has(toId)) return false
  const targetIndex = items.findIndex((it) => it.id === toId)
  if (targetIndex < 0) return false
  const movers = items.filter((it) => moving.has(it.id))
  if (movers.length === 0) return false

  const before = items.map((it) => it.id)
  const lastMoverIndex = items.reduce((last, it, i) => (moving.has(it.id) ? i : last), -1)
  const rest = items.filter((it) => !moving.has(it.id))
  const restTargetIndex = rest.findIndex((it) => it.id === toId)
  const insertAt = lastMoverIndex < targetIndex ? restTargetIndex + 1 : restTargetIndex
  rest.splice(insertAt, 0, ...movers)
  if (rest.every((it, i) => it.id === before[i])) return false
  items.splice(0, items.length, ...rest)
  return true
}
