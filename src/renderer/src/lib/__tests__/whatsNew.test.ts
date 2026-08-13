import { describe, it, expect } from 'vitest'
import {
  WHATS_NEW,
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

describe('WHATS_NEW', () => {
  // v0.1.78's announcement was once lost by writing the next release's notes
  // over the existing entry instead of prepending a new one. Ordering and
  // uniqueness both survive that mistake — only a gap check catches it.
  it('announces every version with no gaps', () => {
    const versions = WHATS_NEW.map((entry) => entry.version).sort(cmpSemver)
    const missing: string[] = []
    for (let i = 1; i < versions.length; i++) {
      const [prevMajor, prevMinor, prevPatch] = versions[i - 1].split('.').map(Number)
      const [major, minor, patch] = versions[i].split('.').map(Number)
      // A minor or major bump restarts patch numbering, so the last patch of
      // the previous line is unknowable here — only same-line pairs can gap.
      if (major !== prevMajor || minor !== prevMinor) continue
      for (let p = prevPatch + 1; p < patch; p++) missing.push(`${major}.${minor}.${p}`)
    }
    expect(missing).toEqual([])
  })

  it('has no duplicate versions', () => {
    // The sibling of the gap above: an in-place edit can also leave two entries
    // claiming the same version, which the gap check cannot see.
    const versions = WHATS_NEW.map((entry) => entry.version)
    expect(versions).toHaveLength(new Set(versions).size)
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
    // Read the newest entry rather than naming a version: the list is now
    // contiguous, so any hard-coded gap would close on the next release.
    const newest = WHATS_NEW.reduce((a, b) => (cmpSemver(b.version, a.version) > 0 ? b : a))
    expect(pickWhatsNew('9.9.9', '')?.version).toBe(newest.version)
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
