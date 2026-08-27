// Turns a rule key spec ("cmd+k cmd+s") into the glyph tokens the Settings UI
// renders as <kbd> caps. Display-only — nothing here feeds the matcher.
import { parseKeySpec, isMacPlatform } from './parseKey'
import type { ParsedKey } from './types'

const MAC_MODIFIERS = { meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
const PC_MODIFIERS = { meta: 'Win', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }

const KEY_GLYPHS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↵',
  escape: 'Esc',
  backspace: '⌫',
  delete: '⌦',
  tab: 'Tab',
  ' ': 'Space',
  space: 'Space',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
}

function displayKey(key: string): string {
  const glyph = KEY_GLYPHS[key]
  if (glyph) return glyph
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase()
  if (key.length === 1) return key.toUpperCase()
  return key.charAt(0).toUpperCase() + key.slice(1)
}

// One chord segment → its ordered cap labels, e.g. ['⌘', '⇧', 'P'].
export function segmentToTokens(pk: ParsedKey, mac = isMacPlatform()): string[] {
  const mods = mac ? MAC_MODIFIERS : PC_MODIFIERS
  const tokens: string[] = []
  if (pk.meta) tokens.push(mods.meta)
  if (pk.ctrl) tokens.push(mods.ctrl)
  if (pk.alt) tokens.push(mods.alt)
  if (pk.shift) tokens.push(mods.shift)
  tokens.push(displayKey(pk.key))
  return tokens
}

// Full spec → one token list per chord segment. Callers join segments with a
// visible separator so "⌘ K" and "⌘ S" don't read as one seven-cap blob.
export function keySpecToTokens(spec: string, mac = isMacPlatform()): string[][] {
  if (!spec.trim()) return []
  return parseKeySpec(spec).map((pk) => segmentToTokens(pk, mac))
}

// Flat single-line form for tooltips, search text and test assertions.
export function formatKeySpec(spec: string, mac = isMacPlatform()): string {
  return keySpecToTokens(spec, mac)
    .map((tokens) => tokens.join(mac ? '' : '+'))
    .join(' ')
}
