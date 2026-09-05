// The legal pages on navide.dev, the one place their addresses are written.
//
// Main opens them from the Help menu; the renderer opens them from Settings
// and the account window through the `legal:open` IPC, so it never assembles
// a URL itself. Every address ends in a slash: the site serves each page as
// `<route>/index.html`, and nginx answers the slash-less form with a redirect.
//
// DOM-free and Electron-free on purpose — this file is compiled on both sides.

export const LEGAL_SITE = 'https://navide.dev'

// No terms of service. Navide is MIT-licensed software with a free account, so
// there is no contract for a reader to agree to — and that page was the only one
// that would have needed company details and a governing law. It is gone from
// the site too: nginx answers an unknown path with the home page and a 200, so
// a button pointing at a removed page would have taken people somewhere else
// entirely with nothing to notice.
export const LEGAL_ROUTES = [
  'privacy',
  'security',
  'code-of-conduct',
  'boundaries',
  'licenses',
  'legal',
] as const

export type LegalRoute = (typeof LEGAL_ROUTES)[number]

/** English labels, in Help-menu order. Main has no i18n; the renderer has its own. */
export const LEGAL_LABELS: Record<LegalRoute, string> = {
  privacy: 'Privacy',
  security: 'Security Policy',
  'code-of-conduct': 'Code of Conduct',
  boundaries: 'Boundaries',
  licenses: 'Licenses',
  legal: 'Legal',
}

export const LEGAL_LINKS: Record<LegalRoute, string> = Object.fromEntries(
  LEGAL_ROUTES.map((route) => [route, `${LEGAL_SITE}/${route}/`]),
) as Record<LegalRoute, string>

export function isLegalRoute(value: unknown): value is LegalRoute {
  return typeof value === 'string' && (LEGAL_ROUTES as readonly string[]).includes(value)
}
