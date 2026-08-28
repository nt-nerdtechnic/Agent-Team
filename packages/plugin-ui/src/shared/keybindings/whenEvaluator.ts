// Evaluates `when` clause strings. Supported: ||, &&, !, identifiers.
// Precedence: && binds tighter than ||. Unknown identifiers resolve to false.
export function evaluateWhen(
  expr: string,
  ctx: Record<string, boolean | string>,
): boolean {
  const evalTerm = (term: string): boolean => {
    const t = term.trim()
    if (!t) return true
    if (t.startsWith('!')) return !ctx[t.slice(1).trim()]
    return !!ctx[t]
  }
  const evalAnd = (andExpr: string): boolean =>
    andExpr.split('&&').every(evalTerm)
  return expr.split('||').some(evalAnd)
}
