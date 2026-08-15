// What the focused page last reported as its terminal selection, keyed by
// WebContents id.
//
// Edit > Copy used to ask the page for its selection at the moment the user
// pressed ⌘C, racing a 300ms deadline (see menu.ts). A renderer busy painting
// CLI output loses that race, and the fallback — webContents.copy() — copies
// nothing at all over a terminal, because `.xterm` is user-select: none. The
// user pressed Copy and got an unchanged clipboard, with nothing to say why.
//
// So the page pushes instead: the work happens when the selection changes, not
// while the user waits. A miss here is not a failure — a page that never pushed
// (a plugin view on a different preload, a window with no terminal) simply
// leaves Copy on its original ask-the-page path.
//
// One entry per WebContents, not per pane: panes in a window share a renderer,
// and the page only ever reports the focused pane's selection, which is the
// same rule the old global followed.

const selections = new Map<number, string>()

/**
 * Record a page's current terminal selection.
 *
 * An empty selection deletes the entry rather than storing '', so "has no
 * selection" and "never reported" stay one state — both mean Copy should fall
 * back rather than write an empty clipboard.
 */
export function setTerminalSelection(webContentsId: number, selection: string): void {
  if (selection) selections.set(webContentsId, selection)
  else selections.delete(webContentsId)
}

/** The page's last reported selection, or '' when it has none. */
export function getTerminalSelection(webContentsId: number): string {
  return selections.get(webContentsId) ?? ''
}

/**
 * Drop a page's entry.
 *
 * Called when its WebContents is destroyed: ids are reused, so a stale entry
 * would eventually answer Copy for an unrelated page.
 */
export function forgetTerminalSelection(webContentsId: number): void {
  selections.delete(webContentsId)
}
