/**
 * Turns a pasted screenshot into a path a CLI agent can read.
 *
 * A capture taken with ⌘⇧4 (or ⌘⇧Ctrl+4, or "Copy" from the screenshot
 * thumbnail) exists only as pixels on the clipboard — there is no file and no
 * text, so pasting into a terminal has nothing to send and the agent has no
 * way to reach the clipboard itself. Main writes the bytes into the same store
 * the drag path uses, and the paste sends that path instead.
 */

/** The first image on a paste event, or null when the clipboard has none. */
export function extractClipboardImage(dt: DataTransfer | null): File | null {
  if (!dt?.items?.length) return null
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) return file
  }
  return null
}
