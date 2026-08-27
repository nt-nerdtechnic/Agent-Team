/** Pane reorder helper: move the item with id `fromId` to the index currently
 *  occupied by `toId` (splice-remove-then-insert, mutating `items` in place).
 *  The dragged item ends up at the target's original index; items in between
 *  shift by one. No-op (returns false) when the ids are equal or either id is
 *  not present. Returns true when the order actually changed, so callers can
 *  gate follow-up work (e.g. persistence) on it. */
export function reorderByIds<T extends { id: string }>(items: T[], fromId: string, toId: string): boolean {
  if (fromId === toId) return false
  const from = items.findIndex((it) => it.id === fromId)
  const to = items.findIndex((it) => it.id === toId)
  if (from < 0 || to < 0) return false
  const [moved] = items.splice(from, 1)
  items.splice(to, 0, moved)
  return true
}

/** Move `from` to `to`'s position in a list whose items ARE their identity.
 *
 *  Same semantics as reorderByIds, for plain strings — workspace paths, which
 *  have no wrapper object to carry an id. Returns false when nothing moved, so
 *  the caller can skip persisting a no-op drop onto the row you picked up. */
export function reorderStrings(items: string[], from: string, to: string): boolean {
  if (from === to) return false
  const at = items.indexOf(from)
  const onto = items.indexOf(to)
  if (at < 0 || onto < 0) return false
  const [moved] = items.splice(at, 1)
  items.splice(onto, 0, moved)
  return true
}

/** Re-sort `items` in place so the items whose ids appear in `idOrder` follow
 *  that order. Only the slots occupied by listed items are permuted — items
 *  whose id is not in `idOrder` stay exactly where they are, and ids in
 *  `idOrder` with no matching item are skipped (no data loss either way).
 *  Returns true when any item actually moved. */
export function sortByIdOrder<T extends { id: string }>(items: T[], idOrder: string[]): boolean {
  const rank = new Map(idOrder.map((id, i) => [id, i]))
  const slots: number[] = []
  for (let i = 0; i < items.length; i++) {
    if (rank.has(items[i].id)) slots.push(i)
  }
  const sorted = slots
    .map((i) => items[i])
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
  let changed = false
  slots.forEach((slot, k) => {
    if (items[slot] !== sorted[k]) {
      items.splice(slot, 1, sorted[k])
      changed = true
    }
  })
  return changed
}
