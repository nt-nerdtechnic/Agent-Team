/** Path helpers with no runtime dependencies.
 *
 *  Kept out of useTerminal so that importing one of these does not pull in
 *  xterm and everything it loads at module scope — a pure function should be
 *  usable from a test that has no DOM.
 */

/** `/Users/me/x` → `~/x`, when `home` is that user's home directory. */
export function collapseHomePath(p: string, home: string): string {
  if (!home) return p
  const h = home.replace(/\/+$/, '')
  return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p
}
