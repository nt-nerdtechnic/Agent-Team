import type { ParsedKey } from './types'

const ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  bs: 'backspace',
  pgup: 'pageup',
  pgdown: 'pagedown',
}

// 'mod' is the platform-primary modifier: Cmd (meta) on macOS, Ctrl elsewhere.
// Resolved at parse time so rules written with 'mod' work on every platform.
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform || ''
  if (platform) return /mac|iphone|ipad|ipod/i.test(platform)
  return /mac os x|macintosh/i.test(navigator.userAgent || '')
}

export function parseKey(segment: string): ParsedKey {
  const parts = segment.toLowerCase().split('+')
  let meta = false, ctrl = false, shift = false, alt = false
  const keyParts: string[] = []
  for (const p of parts) {
    if (p === 'cmd' || p === 'meta') meta = true
    else if (p === 'mod') { if (isMacPlatform()) meta = true; else ctrl = true }
    else if (p === 'ctrl' || p === 'control') ctrl = true
    else if (p === 'shift') shift = true
    else if (p === 'alt' || p === 'option') alt = true
    else keyParts.push(p)
  }
  const raw = keyParts.join('+')
  return { meta, ctrl, shift, alt, key: ALIASES[raw] ?? raw }
}

// Supports single key ("cmd+s") and chords ("ctrl+k ctrl+s").
export function parseKeySpec(spec: string): ParsedKey[] {
  return spec.trim().split(/\s+/).map(parseKey)
}

export function eventToParsedKey(e: KeyboardEvent): ParsedKey {
  return {
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    key: e.key.toLowerCase(),
  }
}

export function parsedKeyEquals(a: ParsedKey, b: ParsedKey): boolean {
  return a.meta === b.meta && a.ctrl === b.ctrl && a.shift === b.shift &&
    a.alt === b.alt && a.key === b.key
}

function eventKeyMatches(expectedKey: string, e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() === expectedKey) return true

  // `KeyboardEvent.key` is layout/IME-dependent. With Chinese input methods
  // the physical slash key may be reported as `Process`, `Unidentified`, or a
  // localized character, which made Cmd+/ silently miss its binding. Use the
  // physical key as a fallback for slash shortcuts while retaining `key` as
  // the primary match for user-facing keybinding semantics.
  if (expectedKey === '/') {
    return e.code === 'Slash' || e.code === 'NumpadDivide'
  }

  // On macOS, Option+letter types a special character (e.g. Option+Z → 'Ω'),
  // so `e.key` never reports the plain letter for alt-modified letter
  // shortcuts like Alt+Z. Fall back to the physical letter key when Alt is
  // held; without Alt, `e.key` remains the authoritative layout-aware match.
  if (e.altKey && /^[a-z]$/.test(expectedKey)) {
    return e.code === `Key${expectedKey.toUpperCase()}`
  }

  // Same layout/IME problem for digit shortcuts (Ctrl+1..9 CLI quick-select):
  // with a Chinese IME active `e.key` may be `Process`/`Unidentified`, so the
  // binding silently missed and the keystroke leaked into the focused terminal.
  // Fall back to the physical digit key from the main row or the numpad.
  if (/^[0-9]$/.test(expectedKey)) {
    return e.code === `Digit${expectedKey}` || e.code === `Numpad${expectedKey}`
  }

  return false
}

// ── Reverse direction: KeyboardEvent → rule string ────────────────────────────
// Used by the Settings shortcut recorder. The base key it emits must be the one
// `eventKeyMatches` above would accept, so the three physical-key fallbacks are
// mirrored here: a recorded Option+Z has to become 'alt+z' (never 'alt+Ω'), and
// a digit recorded under an IME has to become the digit (never 'Process').

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt'])
// e.key values that carry no usable character; the physical code is the only
// signal left.
const OPAQUE_KEYS = new Set(['process', 'unidentified', 'dead'])

function baseKeyFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null

  // Digits: always prefer the physical key so IME-intercepted and shifted
  // presses (Shift+3 → '#') both record as the digit the matcher looks for.
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code || '')
  if (digit) return digit[1]

  if (e.code === 'Slash' || e.code === 'NumpadDivide') return '/'

  // Option+letter types a special character on macOS; the matcher falls back to
  // the physical letter, so the recorder must too.
  const letter = /^Key([A-Z])$/.exec(e.code || '')
  if (e.altKey && letter) return letter[1].toLowerCase()

  const key = (e.key || '').toLowerCase()
  if (!key || OPAQUE_KEYS.has(key)) return letter ? letter[1].toLowerCase() : null
  // A literal space would split the chord spec in two; use its alias instead.
  if (key === ' ') return 'space'
  return key
}

// Canonical modifier order so two spellings of the same combo compare equal.
export function formatParsedKey(pk: ParsedKey): string {
  const parts: string[] = []
  if (pk.meta) parts.push('cmd')
  if (pk.ctrl) parts.push('ctrl')
  if (pk.alt) parts.push('alt')
  if (pk.shift) parts.push('shift')
  parts.push(pk.key === ' ' ? 'space' : pk.key)
  return parts.join('+')
}

// Rewrites a spec into canonical form ('shift+cmd+s' → 'cmd+shift+s') so
// conflict detection is not fooled by ordering or aliases.
export function canonicalizeKeySpec(spec: string): string {
  return parseKeySpec(spec).map(formatParsedKey).join(' ')
}

export interface KeySpecError {
  ok: false
  /** Machine-readable reason; the UI maps it to an i18n message. */
  reason: 'empty' | 'too-many-segments' | 'modifiers-only' | 'unknown-key'
  detail?: string
}

const MAX_CHORD_SEGMENTS = 2

/**
 * Rejects specs the resolver cannot honour. The important one is a third chord
 * segment: `parseKeySpec` happily returns three, but `KeyResolver` only ever
 * compares one or two, so a `cmd+k cmd+s cmd+t` rule parses cleanly and then
 * never fires — silently, which is the worst way to be wrong.
 */
export function validateKeySpec(spec: string): { ok: true } | KeySpecError {
  const trimmed = spec.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }

  const segments = trimmed.split(/\s+/)
  if (segments.length > MAX_CHORD_SEGMENTS) {
    return { ok: false, reason: 'too-many-segments', detail: String(segments.length) }
  }

  for (const segment of segments) {
    const parsed = parseKey(segment)
    if (!parsed.key) return { ok: false, reason: 'modifiers-only', detail: segment }
    // A base key is a single character, a known named key, or f1..f24. Anything
    // else is a typo like 'cmmd+s', which would parse into a key nothing emits.
    const named = /^(escape|enter|tab|backspace|delete|space|home|end|pageup|pagedown|arrow(up|down|left|right)|f([1-9]|1[0-9]|2[0-4]))$/
    if (parsed.key.length !== 1 && !named.test(parsed.key) && parsed.key !== ' ') {
      return { ok: false, reason: 'unknown-key', detail: parsed.key }
    }
  }
  return { ok: true }
}

// Returns null while the user is still holding only modifiers, or when the
// event carries no identifiable key at all.
export function eventToKeyString(e: KeyboardEvent): string | null {
  const base = baseKeyFromEvent(e)
  if (base === null) return null
  const parts: string[] = []
  if (e.metaKey) parts.push('cmd')
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(base)
  return parts.join('+')
}

export function matchesEvent(parsed: ParsedKey, e: KeyboardEvent): boolean {
  if (parsed.meta !== e.metaKey) return false
  if (parsed.ctrl !== e.ctrlKey) return false
  if (parsed.shift !== e.shiftKey) return false
  if (parsed.alt !== e.altKey) return false
  return eventKeyMatches(parsed.key, e)
}
