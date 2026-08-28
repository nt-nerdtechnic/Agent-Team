/** Pick a still-valid active tab after runGroups changed underneath us (e.g. a
 *  peer window deleted the group this window was viewing). Keeps the current tab
 *  if it still exists or is the special 'manual' tab; otherwise falls back to the
 *  last remaining group, or 'manual' when no groups remain. */
export function resolveActiveTab(groups: { id: string }[], current: string): string {
  if (current === 'manual') return current
  if (groups.some((g) => g.id === current)) return current
  return groups[groups.length - 1]?.id ?? 'manual'
}

/** Manual panes belong to the tab the user is viewing. The synthetic manual
 * tab has no run-group id, while a real run tab keeps its own id. */
export function resolveManualSpawnGroupId(groups: { id: string }[], activeTab: string): string {
  return groups.some((group) => group.id === activeTab) ? activeTab : ''
}

/** The creation time to give a group record being rebuilt from the id its panes
 *  still carry. Ids are minted as `rg-<epoch ms>`, so the original time is in
 *  the id: recovering it keeps a rebuilt group where it belongs in the order
 *  instead of sorting it after groups that were made long after it. Anything
 *  not in that shape (the fixed `rg-default`, an id from an older scheme) has
 *  no time to recover and takes now. */
export function runGroupCreatedAt(id: string, now: number = Date.now()): number {
  const stamp = Number(id.slice(3))
  return id.startsWith('rg-') && Number.isSafeInteger(stamp) && stamp > 0 ? stamp : now
}

/** Parse the legacy per-workspace `agentTeam.runGroups.<ws>` localStorage blob
 *  (one-time migration into project.json's ui_run_groups). Returns null when
 *  nothing was stored; corrupt / non-array data yields [] — matching the old
 *  loader, where stored-but-unreadable was NOT "never stored" and therefore
 *  must not resurrect the default group the user may have deleted. */
export function parseLegacyRunGroups(
  raw: string | null
): { id: string; name: string; createdAt: number }[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
