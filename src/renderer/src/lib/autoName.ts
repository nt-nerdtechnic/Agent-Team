/**
 * Heuristic auto-title derivation for panes without a manual name.
 *
 * Ported from the AIChatPane thread auto-title heuristic. Pure and
 * synchronous by design: to swap in an LLM-based namer later, replace
 * this implementation (or wrap it behind an async provider) — callers
 * only depend on the signature.
 */

const MAX_MATERIAL = 500
const MAX_TITLE = 60
const CLAUSE_MIN = 8
const CLAUSE_MAX = 50

const EN_FILLER = /^(can you|please|could you|help me|i need|i want|sure[,!]?|okay[,!]?|ok[,!]?)\s+/i
const ZH_FILLER = /^(好的|沒問題|收到|了解|我來|我會|請|幫我)[，,、!！:：\s]*/

/** Drop a leading filler phrase. Keeps the original when stripping empties it. */
function stripFiller(text: string): string {
  const stripped = text.replace(EN_FILLER, '').replace(ZH_FILLER, '').trim()
  return stripped || text
}

export function deriveAutoName(material: string): string {
  const cleaned = material
    .slice(0, MAX_MATERIAL)
    .replace(/@\S+/g, '')
    .replace(/\[Context:[^\]]+\]/g, '')
    .replace(/^[#>*\-\s]+/, '')
    .trim()
  if (!cleaned) return ''

  // Strip the filler up front so every branch benefits, not just the truncating
  // one — a short "請幫我修 bug" is exactly the case the filler lists target.
  const flat = stripFiller(cleaned.replace(/\s+/g, ' ').trim())
  let title: string
  if (flat.length <= CLAUSE_MAX) {
    title = flat
  } else {
    const firstClause = stripFiller(
      cleaned
        .split(/[.!?。！？\n]/)[0]
        .replace(/\s+/g, ' ')
        .trim()
    )
    if (firstClause.length >= CLAUSE_MIN && firstClause.length <= CLAUSE_MAX) {
      title = firstClause
    } else {
      title = flat.slice(0, 47)
      if (flat.length > 47) title += '…'
    }
  }
  return title.slice(0, MAX_TITLE)
}
