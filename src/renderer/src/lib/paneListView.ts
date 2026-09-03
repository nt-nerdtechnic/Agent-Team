// How the pane lists say who opened what.
//
// The sidebar tree spends horizontal space on indentation to show ancestry.
// The lists each main-window mode renders have none to spare — a card is
// already a name, a vendor and a status — so they spend a line of text.
//
// Pure structure in, text out: a pane's name is live state, so this takes a
// lookup rather than reaching for it, and the join happens where the row is
// rendered.

/** The source line for a nested row: `官方網站 › SEO 稽核`, without the ↳,
 *  which is the template's decoration rather than data.
 *
 *  Truncates from the LEFT once the chain outgrows `maxSegments`, because the
 *  nearest parent is the half that carries information — it says who opened
 *  this pane — while the outermost root is usually obvious from context.
 *
 *  An ancestor with no name yet is skipped rather than rendered as a gap:
 *  rows and pane views are separate reactive writes, so a frame can see one
 *  before the other.
 */
export function ancestorTrail(
  ancestors: readonly string[],
  nameOf: (id: string) => string,
  maxSegments = 2,
): string {
  const names = ancestors.map(nameOf).filter((name) => !!name)
  if (names.length === 0) return ''
  if (names.length <= maxSegments) return names.join(' › ')
  return `… › ${names.slice(-maxSegments).join(' › ')}`
}
