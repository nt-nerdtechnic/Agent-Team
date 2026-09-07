/** True when two pane-view snapshots would render identically.
 *
 *  The pane view models are rebuilt every 400 ms so that status the panes hold
 *  outside Vue's reactivity (a terminal's displayStatus, a rebuild's progress)
 *  reaches the sidebar and the grid. Nearly every one of those ticks reports
 *  exactly what the last one did, and assigning a fresh array anyway dirties
 *  every consumer: App's own pane list, each TerminalPane, and the sidebar all
 *  re-render 2.5 times a second for no visible difference.
 *
 *  Same idea as sameRenderedTabs, one layer up — that one keeps the tab bar
 *  still, this one keeps the pane list still.
 *
 *  Compared by the objects' own keys rather than a written-out field list:
 *  ActivePaneView carries more than twenty of them, and a field added to the
 *  snapshot but forgotten here would silently stop reaching the screen. A field
 *  whose value is not a primitive compares unequal on every tick — the two
 *  snapshots hold freshly built objects — so the caller falls back to assigning
 *  every time, which is what it did before this existed.
 */
export function sameRenderedPaneViews<T extends object>(
  a: readonly T[],
  b: readonly T[]
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const prev = a[i] as Record<string, unknown>
    const next = b[i] as Record<string, unknown>
    const prevKeys = Object.keys(prev)
    if (prevKeys.length !== Object.keys(next).length) return false
    for (const key of prevKeys) {
      if (!Object.is(prev[key], next[key])) return false
    }
  }
  return true
}
