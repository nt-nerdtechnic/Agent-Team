// @vitest-environment happy-dom
// Key-cap rendering for the Settings editor. Display-only: nothing here feeds
// the matcher, so the thing worth pinning is that every shipped default renders
// to something a person can read, and that chords stay visibly two-part.
import { describe, it, expect } from 'vitest'
import { formatKeySpec, keySpecToTokens, segmentToTokens } from '../keyDisplay'
import { parseKey } from '../parseKey'
import { defaults } from '../defaults'

describe('segmentToTokens', () => {
  it('orders macOS modifiers the way the platform prints them', () => {
    expect(segmentToTokens(parseKey('cmd+ctrl+alt+shift+p'), true)).toEqual(['⌘', '⌃', '⌥', '⇧', 'P'])
  })

  it('spells modifiers out on non-mac', () => {
    expect(segmentToTokens(parseKey('ctrl+shift+f'), false)).toEqual(['Ctrl', 'Shift', 'F'])
  })

  it('uses glyphs for arrows and editing keys', () => {
    expect(segmentToTokens(parseKey('alt+up'), true)).toEqual(['⌥', '↑'])
    expect(segmentToTokens(parseKey('cmd+backspace'), true)).toEqual(['⌘', '⌫'])
    expect(segmentToTokens(parseKey('escape'), true)).toEqual(['Esc'])
  })

  it('renders the space alias as a word', () => {
    expect(segmentToTokens(parseKey('ctrl+space'), true)).toEqual(['⌃', 'Space'])
  })

  it('keeps function keys uppercase', () => {
    expect(segmentToTokens(parseKey('shift+f12'), true)).toEqual(['⇧', 'F12'])
  })

  it('passes punctuation through untouched', () => {
    expect(segmentToTokens(parseKey('cmd+/'), true)).toEqual(['⌘', '/'])
    expect(segmentToTokens(parseKey('cmd+['), true)).toEqual(['⌘', '['])
  })
})

describe('keySpecToTokens', () => {
  it('returns one token list per chord segment', () => {
    expect(keySpecToTokens('cmd+k cmd+s', true)).toEqual([['⌘', 'K'], ['⌘', 'S']])
  })

  it('returns an empty list for an empty spec', () => {
    expect(keySpecToTokens('  ', true)).toEqual([])
  })
})

describe('formatKeySpec', () => {
  it('joins a chord with a space so the two halves stay distinct', () => {
    expect(formatKeySpec('cmd+k cmd+s', true)).toBe('⌘K ⌘S')
  })

  it('uses + between spelled-out modifiers on non-mac', () => {
    expect(formatKeySpec('ctrl+shift+f', false)).toBe('Ctrl+Shift+F')
  })
})

describe('every shipped default renders', () => {
  it('produces a non-empty label with no leftover raw modifier words', () => {
    for (const rule of defaults) {
      const text = formatKeySpec(rule.key, true)
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toMatch(/\b(cmd|ctrl|alt|shift|meta|mod)\b/)
    }
  })
})
