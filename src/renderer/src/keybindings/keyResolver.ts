import type { KeybindingRule, ParsedKey } from './types'
import { isRemovalRule, removalTarget } from './types'
import { evaluateWhen } from './whenEvaluator'
import {
  matchesEvent,
  parsedKeyEquals,
  parseKeySpec,
  eventToParsedKey,
  formatParsedKey,
} from './parseKey'

interface ResolvedBinding {
  rule: KeybindingRule
  keys: ParsedKey[]
  spec: string // canonical key spec, used to pair removals with their target
}

function removalId(spec: string, command: string): string {
  return `${spec}\u0000${command}`
}

export class KeyResolver {
  // Rules are stored in priority order: last rule wins (user rules beat defaults).
  private readonly bindings: ResolvedBinding[]
  // Removals indexed by (canonical key, target command) so cancelling one
  // binding never disturbs the others that share the key.
  private readonly removals = new Map<string, KeybindingRule[]>()
  private chordState: ParsedKey | null = null

  constructor(rules: KeybindingRule[]) {
    // Reverse so rules appearing later have higher priority (checked first).
    this.bindings = rules
      .map((rule) => {
        const keys = parseKeySpec(rule.key)
        return { rule, keys, spec: keys.map(formatParsedKey).join(' ') }
      })
      .reverse()

    for (const { rule, spec } of this.bindings) {
      if (!isRemovalRule(rule)) continue
      const id = removalId(spec, removalTarget(rule))
      const list = this.removals.get(id)
      if (list) list.push(rule)
      else this.removals.set(id, [rule])
    }
  }

  resolve(
    e: KeyboardEvent,
    ctx: Record<string, boolean | string>,
  ): KeybindingRule | null {
    // Ignore bare modifier key presses.
    if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null

    if (this.chordState) {
      const first = this.chordState
      this.chordState = null
      return this.resolveChord(first, e, ctx)
    }

    // Check if this key starts any chord that is eligible in the current
    // context. Cancelled chords do not hold the prefix hostage: once every
    // chord on a prefix is removed, the bare key is usable again.
    const startsChord = this.bindings.some(
      (b) => b.keys.length === 2 && matchesEvent(b.keys[0], e) && this.isActive(b, ctx),
    )
    if (startsChord) {
      this.chordState = eventToParsedKey(e)
      return null
    }

    return this.resolveSingle(e, ctx)
  }

  resetChord(): void {
    this.chordState = null
  }

  hasPendingChord(): boolean {
    return this.chordState !== null
  }

  // A binding fires when it is not itself a removal, its own when-clause holds,
  // and no eligible removal targets it.
  private isActive(b: ResolvedBinding, ctx: Record<string, boolean | string>): boolean {
    if (isRemovalRule(b.rule)) return false
    if (b.rule.when && !evaluateWhen(b.rule.when, ctx)) return false
    const cancels = this.removals.get(removalId(b.spec, b.rule.command))
    if (!cancels) return true
    return !cancels.some((r) => !r.when || evaluateWhen(r.when, ctx))
  }

  private resolveSingle(
    e: KeyboardEvent,
    ctx: Record<string, boolean | string>,
  ): KeybindingRule | null {
    for (const b of this.bindings) {
      if (b.keys.length !== 1) continue
      if (!matchesEvent(b.keys[0], e)) continue
      if (!this.isActive(b, ctx)) continue
      return b.rule
    }
    return null
  }

  private resolveChord(
    first: ParsedKey,
    e: KeyboardEvent,
    ctx: Record<string, boolean | string>,
  ): KeybindingRule | null {
    for (const b of this.bindings) {
      if (b.keys.length !== 2) continue
      if (!parsedKeyEquals(b.keys[0], first)) continue
      if (!matchesEvent(b.keys[1], e)) continue
      if (!this.isActive(b, ctx)) continue
      return b.rule
    }
    return null
  }
}
