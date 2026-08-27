// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseKey, parseKeySpec, matchesEvent, parsedKeyEquals, eventToParsedKey } from '../parseKey'

afterEach(() => {
  vi.unstubAllGlobals()
})

function mkEvent(
  key: string,
  opts: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string }> = {},
): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, ...opts })
}

describe('parseKey', () => {
  it('parses cmd+s', () => {
    expect(parseKey('cmd+s')).toEqual({ meta: true, ctrl: false, shift: false, alt: false, key: 's' })
  })

  it('parses ctrl+shift+f', () => {
    expect(parseKey('ctrl+shift+f')).toEqual({ meta: false, ctrl: true, shift: true, alt: false, key: 'f' })
  })

  it('resolves mod to meta on macOS', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' })
    const r = parseKey('mod+s')
    expect(r.meta).toBe(true)
    expect(r.ctrl).toBe(false)
  })

  it('resolves mod to ctrl on non-macOS platforms', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: '' })
    const r = parseKey('mod+s')
    expect(r.meta).toBe(false)
    expect(r.ctrl).toBe(true)
  })

  it('falls back to userAgent when platform is empty', () => {
    vi.stubGlobal('navigator', {
      platform: '',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
    const r = parseKey('mod+s')
    expect(r.meta).toBe(true)
    expect(r.ctrl).toBe(false)
  })

  it('normalizes alias: esc → escape', () => {
    expect(parseKey('escape').key).toBe('escape')
    expect(parseKey('esc').key).toBe('escape')
  })

  it('normalizes alias: up → arrowup', () => {
    expect(parseKey('up').key).toBe('arrowup')
  })

  it('lowercases the key part', () => {
    expect(parseKey('cmd+S').key).toBe('s')
  })
})

describe('parseKeySpec', () => {
  it('single key returns one-element array', () => {
    const keys = parseKeySpec('cmd+s')
    expect(keys).toHaveLength(1)
  })

  it('chord returns two-element array', () => {
    const keys = parseKeySpec('ctrl+k ctrl+s')
    expect(keys).toHaveLength(2)
    expect(keys[0]).toEqual({ meta: false, ctrl: true, shift: false, alt: false, key: 'k' })
    expect(keys[1]).toEqual({ meta: false, ctrl: true, shift: false, alt: false, key: 's' })
  })
})

describe('matchesEvent', () => {
  it('matches cmd+s with meta event', () => {
    const parsed = parseKey('cmd+s')
    const e = mkEvent('s', { metaKey: true })
    expect(matchesEvent(parsed, e)).toBe(true)
  })

  it('rejects when modifier differs', () => {
    const parsed = parseKey('cmd+s')
    const e = mkEvent('s') // no metaKey
    expect(matchesEvent(parsed, e)).toBe(false)
  })

  it('rejects when shift differs', () => {
    const parsed = parseKey('cmd+s')
    const e = mkEvent('S', { metaKey: true, shiftKey: true })
    expect(matchesEvent(parsed, e)).toBe(false)
  })

  it('matches shift variant', () => {
    const parsed = parseKey('cmd+shift+f')
    const e = mkEvent('F', { metaKey: true, shiftKey: true })
    expect(matchesEvent(parsed, e)).toBe(true)
  })

  it('matches escape', () => {
    const parsed = parseKey('escape')
    const e = mkEvent('Escape')
    expect(matchesEvent(parsed, e)).toBe(true)
  })

  it('matches slash by physical key when an IME reports Process', () => {
    const parsed = parseKey('cmd+/')
    const e = mkEvent('Process', { metaKey: true, code: 'Slash' })
    expect(matchesEvent(parsed, e)).toBe(true)
  })

  it('matches slash by physical key when a layout reports a localized character', () => {
    const parsed = parseKey('cmd+alt+/')
    const e = mkEvent('、', { metaKey: true, altKey: true, code: 'Slash' })
    expect(matchesEvent(parsed, e)).toBe(true)
  })

  it('does not treat another physical key as slash', () => {
    const parsed = parseKey('cmd+/')
    const e = mkEvent('Process', { metaKey: true, code: 'KeyP' })
    expect(matchesEvent(parsed, e)).toBe(false)
  })

  it('matches alt+z by physical key when macOS Option reports a special char', () => {
    const parsed = parseKey('alt+z')
    const e = mkEvent('Ω', { altKey: true, code: 'KeyZ' })
    expect(matchesEvent(parsed, e)).toBe(true)
  })

  it('does not treat another physical key as alt+z', () => {
    const parsed = parseKey('alt+z')
    const e = mkEvent('Ω', { altKey: true, code: 'KeyX' })
    expect(matchesEvent(parsed, e)).toBe(false)
  })

  it('cmd+z without alt still requires the layout key (no physical fallback)', () => {
    const parsed = parseKey('cmd+z')
    expect(matchesEvent(parsed, mkEvent('z', { metaKey: true, code: 'KeyZ' }))).toBe(true)
    expect(matchesEvent(parsed, mkEvent('y', { metaKey: true, code: 'KeyZ' }))).toBe(false)
  })
})

describe('parsedKeyEquals', () => {
  it('equal keys', () => {
    expect(parsedKeyEquals(parseKey('cmd+s'), parseKey('cmd+s'))).toBe(true)
  })

  it('different key', () => {
    expect(parsedKeyEquals(parseKey('cmd+s'), parseKey('cmd+f'))).toBe(false)
  })
})

describe('eventToParsedKey', () => {
  it('converts event to ParsedKey', () => {
    const e = mkEvent('s', { metaKey: true, shiftKey: true })
    expect(eventToParsedKey(e)).toEqual({ meta: true, ctrl: false, shift: true, alt: false, key: 's' })
  })
})
