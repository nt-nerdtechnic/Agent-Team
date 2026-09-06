/**
 * The one spelling of a JSON document that the renderer and the backend can
 * both compute: sorted keys, no whitespace, every non-ASCII character escaped.
 *
 * It exists so a trust confirmation can be bound to a policy document. The
 * window canonicalises the object it is about to send; the backend
 * canonicalises the object it received (`confirm_token.canonical_json`, which
 * is `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)`);
 * the two strings meet inside the HMAC. A fixture test on each side pins both
 * to the same literal, so a drift in either implementation is a red test, not
 * a policy that silently refuses to save.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return escapeNonAscii(JSON.stringify(value))
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const body = keys.map(
      (k) => `${escapeNonAscii(JSON.stringify(k))}:${canonicalJson((value as Record<string, unknown>)[k])}`,
    )
    return `{${body.join(',')}}`
  }
  // undefined / functions have no JSON spelling; Python would refuse them too.
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`)
}

/** JSON.stringify already escapes `"`, `\\` and control characters the way
 *  Python does (short forms for \n \r \t \b \f, `\u00xx` otherwise); what
 *  it keeps raw and Python does not is everything from DEL upward. */
function escapeNonAscii(quoted: string): string {
  return quoted.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
