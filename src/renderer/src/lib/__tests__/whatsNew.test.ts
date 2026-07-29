import { describe, it, expect } from 'vitest'
import {
  pickWhatsNew,
  pickText,
  whatsNewFor,
  cmpSemver,
  type WhatsNewText,
} from '../whatsNew'

describe('cmpSemver', () => {
  it('orders X.Y.Z versions', () => {
    expect(cmpSemver('0.1.65', '0.1.64')).toBe(1)
    expect(cmpSemver('0.1.64', '0.1.65')).toBe(-1)
    expect(cmpSemver('0.2.0', '0.1.99')).toBe(1)
    expect(cmpSemver('1.0.0', '1.0.0')).toBe(0)
  })

  it('treats a blank string as the oldest version', () => {
    expect(cmpSemver('0.1.65', '')).toBe(1)
    expect(cmpSemver('', '0.0.1')).toBe(-1)
  })
})

describe('pickWhatsNew', () => {
  it('returns the entry when the current version has one and it is unseen', () => {
    expect(pickWhatsNew('0.1.65', '')?.version).toBe('0.1.65')
  })

  it('returns null when everything up to the current version was seen', () => {
    expect(pickWhatsNew('0.1.65', '0.1.65')).toBeNull()
  })

  it('still fires for a later version whose update jumped past the entry', () => {
    // The module ships from a later release, so an entry authored under an
    // already-shipped version must still show to anyone updating past it.
    expect(pickWhatsNew('0.1.66', '')?.version).toBe('0.1.65')
  })

  it('does not show an announcement for a version not yet running', () => {
    expect(pickWhatsNew('0.1.64', '')).toBeNull()
  })

  it('returns null when the current version is empty', () => {
    expect(pickWhatsNew('', '0.1.60')).toBeNull()
  })

  it('agrees with whatsNewFor for a known version', () => {
    expect(pickWhatsNew('0.1.65', '0.1.64')).toEqual(whatsNewFor('0.1.65'))
  })
})

describe('pickText', () => {
  const text: WhatsNewText = { 'zh-TW': '你好', 'en-US': 'hi' }

  it('selects the requested locale', () => {
    expect(pickText(text, 'en-US')).toBe('hi')
    expect(pickText(text, 'zh-TW')).toBe('你好')
  })

  it('falls back to zh-TW for an unknown locale', () => {
    expect(pickText(text, 'ja-JP')).toBe('你好')
  })
})
