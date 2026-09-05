import { describe, expect, it } from 'vitest'
import { LEGAL_LABELS, LEGAL_LINKS, LEGAL_ROUTES, LEGAL_SITE, isLegalRoute } from './legalLinks'

describe('legalLinks', () => {
  it('is the only place the site address is written', () => {
    // Everywhere else asks this table. A hand-written address is one that goes
    // stale silently, and for these pages a wrong one is a legal problem rather
    // than a 404 — so the constant is the assertion, not a literal repeated
    // here.
    expect(LEGAL_SITE).toMatch(/^https:\/\/[a-z0-9.-]+$/)
    expect(LEGAL_SITE.endsWith('/')).toBe(false)
  })

  it('maps every route to a site URL that ends in a slash', () => {
    for (const route of LEGAL_ROUTES) {
      expect(LEGAL_LINKS[route]).toBe(`${LEGAL_SITE}/${route}/`)
      expect(LEGAL_LABELS[route]).toBeTruthy()
    }
  })

  it('covers the five pages and the index the site serves', () => {
    expect([...LEGAL_ROUTES]).toEqual([
      'privacy',
      'security',
      'code-of-conduct',
      'boundaries',
      'licenses',
      'legal',
    ])
  })

  it('refuses anything that is not a known route', () => {
    expect(isLegalRoute('privacy')).toBe(true)
    expect(isLegalRoute('privacy/')).toBe(false)
    expect(isLegalRoute(`${LEGAL_SITE}/privacy/`)).toBe(false)
    expect(isLegalRoute(undefined)).toBe(false)
    expect(isLegalRoute(3)).toBe(false)
  })
})
