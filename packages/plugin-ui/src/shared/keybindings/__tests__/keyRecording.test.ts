// @vitest-environment happy-dom
// The recorder direction: KeyboardEvent → rule string.
//
// The contract that matters is a round trip — whatever the recorder writes must
// be something matchesEvent() accepts for the very same keystroke. The three
// physical-key fallbacks in the matcher (slash under an IME, Option+letter on
// macOS, digits under an IME) are exactly where a naive `e.key` recorder would
// write a string that can never match again, so each gets a test.
import { describe, it, expect } from 'vitest'
import {
  canonicalizeKeySpec,
  eventToKeyString,
  formatParsedKey,
  matchesEvent,
  parseKey,
  parseKeySpec,
  validateKeySpec,
} from '../parseKey'

function mkEvent(
  key: string,
  opts: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string }> = {},
): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, ...opts })
}

function roundTrips(e: KeyboardEvent): boolean {
  const spec = eventToKeyString(e)
  if (!spec) return false
  const parsed = parseKeySpec(spec)
  return parsed.length === 1 && matchesEvent(parsed[0], e)
}

describe('eventToKeyString', () => {
  it('records a plain modifier combination', () => {
    expect(eventToKeyString(mkEvent('s', { metaKey: true }))).toBe('cmd+s')
  })

  it('lowercases the letter a shifted press reports in uppercase', () => {
    expect(eventToKeyString(mkEvent('S', { metaKey: true, shiftKey: true }))).toBe('cmd+shift+s')
  })

  it('emits modifiers in canonical order regardless of which are held', () => {
    expect(eventToKeyString(mkEvent('c', { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true })))
      .toBe('cmd+ctrl+alt+shift+c')
  })

  it('returns null while only modifiers are down', () => {
    expect(eventToKeyString(mkEvent('Meta', { metaKey: true }))).toBeNull()
    expect(eventToKeyString(mkEvent('Shift', { shiftKey: true }))).toBeNull()
    expect(eventToKeyString(mkEvent('Control', { ctrlKey: true }))).toBeNull()
    expect(eventToKeyString(mkEvent('Alt', { altKey: true }))).toBeNull()
  })

  it('records named keys in the form the alias table produces', () => {
    expect(eventToKeyString(mkEvent('Escape'))).toBe('escape')
    expect(eventToKeyString(mkEvent('ArrowUp'))).toBe('arrowup')
    expect(eventToKeyString(mkEvent('Enter'))).toBe('enter')
    expect(eventToKeyString(mkEvent('F12'))).toBe('f12')
  })

  it('records the space bar as its alias, never as a literal space', () => {
    // A literal space would be split into two chord segments by parseKeySpec.
    const spec = eventToKeyString(mkEvent(' ', { ctrlKey: true }))
    expect(spec).toBe('ctrl+space')
    expect(parseKeySpec(spec!)).toHaveLength(1)
  })

  it('returns null for an event with no identifiable key', () => {
    expect(eventToKeyString(mkEvent('Process'))).toBeNull()
    expect(eventToKeyString(mkEvent('Unidentified'))).toBeNull()
  })
})

describe('eventToKeyString mirrors the matcher’s physical-key fallbacks', () => {
  it('records Option+Z as alt+z although macOS reports "Ω"', () => {
    const e = mkEvent('Ω', { altKey: true, code: 'KeyZ' })
    expect(eventToKeyString(e)).toBe('alt+z')
    expect(roundTrips(e)).toBe(true)
  })

  it('records a digit as the digit although an IME reports "Process"', () => {
    const e = mkEvent('Process', { ctrlKey: true, code: 'Digit3' })
    expect(eventToKeyString(e)).toBe('ctrl+3')
    expect(roundTrips(e)).toBe(true)
  })

  it('records the numpad digit the same way', () => {
    expect(eventToKeyString(mkEvent('Unidentified', { ctrlKey: true, code: 'Numpad7' }))).toBe('ctrl+7')
  })

  it('records the slash key as / although an IME hides it', () => {
    const e = mkEvent('Process', { metaKey: true, code: 'Slash' })
    expect(eventToKeyString(e)).toBe('cmd+/')
    expect(roundTrips(e)).toBe(true)
  })

  it('records a shifted digit by its physical key so the matcher still hits', () => {
    const e = mkEvent('#', { shiftKey: true, ctrlKey: true, code: 'Digit3' })
    expect(eventToKeyString(e)).toBe('ctrl+shift+3')
    expect(roundTrips(e)).toBe(true)
  })

  it('keeps the layout character for a non-alt letter press', () => {
    // Without Alt the matcher has no physical fallback, so the recorder must
    // stay with e.key or the binding would never fire again.
    const e = mkEvent('z', { metaKey: true, code: 'KeyZ' })
    expect(eventToKeyString(e)).toBe('cmd+z')
    expect(roundTrips(e)).toBe(true)
  })
})

describe('round trip over a representative spread', () => {
  const cases: [string, Parameters<typeof mkEvent>[1]][] = [
    ['s', { metaKey: true }],
    ['F', { metaKey: true, shiftKey: true }],
    ['Escape', {}],
    ['ArrowDown', { altKey: true }],
    ['Backspace', { metaKey: true }],
    ['Tab', { ctrlKey: true, shiftKey: true }],
    [']', { metaKey: true }],
    ['f5', {}],
  ]
  for (const [key, opts] of cases) {
    it(`${key} + ${JSON.stringify(opts)} survives record → parse → match`, () => {
      expect(roundTrips(mkEvent(key, opts))).toBe(true)
    })
  }
})

describe('formatParsedKey / canonicalizeKeySpec', () => {
  it('serialises a parsed key back to canonical form', () => {
    expect(formatParsedKey(parseKey('shift+cmd+s'))).toBe('cmd+shift+s')
  })

  it('normalises modifier order', () => {
    expect(canonicalizeKeySpec('shift+alt+a')).toBe('alt+shift+a')
    expect(canonicalizeKeySpec('alt+shift+a')).toBe('alt+shift+a')
  })

  it('resolves aliases so two spellings compare equal', () => {
    expect(canonicalizeKeySpec('esc')).toBe(canonicalizeKeySpec('escape'))
    expect(canonicalizeKeySpec('cmd+up')).toBe('cmd+arrowup')
  })

  it('round-trips the space alias rather than emitting a bare space', () => {
    expect(canonicalizeKeySpec('space')).toBe('space')
  })

  it('keeps both segments of a chord', () => {
    expect(canonicalizeKeySpec('cmd+k  cmd+s')).toBe('cmd+k cmd+s')
  })

  it('is idempotent across every shipped default', async () => {
    const { defaults } = await import('../defaults')
    for (const rule of defaults) {
      const once = canonicalizeKeySpec(rule.key)
      expect(canonicalizeKeySpec(once)).toBe(once)
    }
  })
})

// ── validateKeySpec ───────────────────────────────────────────────────────────
// KeyResolver hardcodes `keys.length !== 1 / !== 2`, so a third chord segment
// parses fine and then never matches. Silent non-firing is the failure mode
// this exists to turn into an error message.
describe('validateKeySpec', () => {
  it('accepts a single key and a two-key chord', () => {
    expect(validateKeySpec('cmd+s')).toEqual({ ok: true })
    expect(validateKeySpec('cmd+k cmd+s')).toEqual({ ok: true })
  })

  it('rejects a three-segment chord the resolver would silently ignore', () => {
    const result = validateKeySpec('cmd+k cmd+s cmd+t')
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'too-many-segments', detail: '3' })
  })

  it('rejects an empty spec', () => {
    expect(validateKeySpec('')).toMatchObject({ ok: false, reason: 'empty' })
    expect(validateKeySpec('   ')).toMatchObject({ ok: false, reason: 'empty' })
  })

  it('rejects modifiers with no base key', () => {
    expect(validateKeySpec('cmd+shift')).toMatchObject({ ok: false, reason: 'modifiers-only' })
  })

  it('rejects a misspelled modifier, which would parse into a key nothing emits', () => {
    // 'cmmd+s' parses to the key 'cmmd+s' — a binding that can never fire.
    expect(validateKeySpec('cmmd+s')).toMatchObject({ ok: false, reason: 'unknown-key' })
  })

  it('accepts named keys, aliases and function keys', () => {
    for (const spec of ['escape', 'esc', 'up', 'arrowdown', 'space', 'f12', 'ctrl+tab', 'cmd+]']) {
      expect(validateKeySpec(spec), spec).toEqual({ ok: true })
    }
  })

  it('accepts every shipped default', async () => {
    const { defaults } = await import('../defaults')
    const bad = defaults.filter((r) => !validateKeySpec(r.key).ok).map((r) => r.key)
    expect(bad).toEqual([])
  })

  it('accepts anything the recorder can produce', () => {
    for (const e of [
      mkEvent('s', { metaKey: true }),
      mkEvent('Ω', { altKey: true, code: 'KeyZ' }),
      mkEvent('Process', { ctrlKey: true, code: 'Digit3' }),
      mkEvent(' ', { ctrlKey: true }),
      mkEvent('F12', {}),
    ]) {
      const spec = eventToKeyString(e)!
      expect(validateKeySpec(spec), spec).toEqual({ ok: true })
    }
  })
})
