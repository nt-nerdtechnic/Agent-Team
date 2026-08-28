// @vitest-environment happy-dom
// Settings → Cross-device messaging → account sign-in.
//
// Registering creates this user's own tenant (a private network of their own
// machines) plus its first admin; signing in exchanges the password for the
// long-lived device token that the card previously made people paste by hand.
//
// The parts worth pinning down live in the renderer: that the password never
// becomes a stored value, that "paste a token" survives as a peer of the two
// account tabs (machines with no account — CI, servers — still need it), and
// that every string the card shows exists in both locales.
//
// The card is not mounted: SettingsModal takes six composable APIs as props and
// pulls in the analyzer, the updater and the MCP catalog, none of which this
// behaviour touches. Same approach as SettingsModal.teamMembers.test.ts.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

const LOCALES = ['en-US', 'zh-TW'] as const
const MODES = ['login', 'register', 'token'] as const

const SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../SettingsModal.vue'),
  'utf8'
)

function block(locale: (typeof LOCALES)[number]): Record<string, string> {
  const messages = i18n.global.getLocaleMessage(locale) as Record<string, any>
  return messages.settings?.p2p?.account
}

/** Every literal `settings.p2p.account.*` key the card asks for, scanned from
 *  the source so a key added without a translation fails here rather than
 *  rendering as its own dotted path. Composed keys (`'…tab-' + mode`) end at a
 *  dash and are covered by the tab test instead. */
function literalKeys(): string[] {
  const found = new Set<string>()
  for (const m of SOURCE.matchAll(/settings\.p2p\.account\.([a-z0-9]+(?:-[a-z0-9]+)*)['"]/g)) {
    found.add(m[1])
  }
  return [...found]
}

describe('Settings — account sign-in', () => {
  it('asks for keys at all', () => {
    // Guards the scan: a regex that stopped matching would make the locale
    // assertions below vacuously true.
    expect(literalKeys().length).toBeGreaterThan(5)
  })

  it('has every string the card shows, in both locales', () => {
    for (const locale of LOCALES) {
      const strings = block(locale)
      expect(strings, locale).toBeTruthy()
      for (const key of literalKeys()) {
        expect(strings[key], `${locale}/${key}`).toBeTruthy()
      }
    }
  })

  it('labels all three modes in both locales', () => {
    for (const locale of LOCALES) {
      const strings = block(locale)
      for (const mode of MODES) {
        expect(strings[`tab-${mode}`], `${locale}/tab-${mode}`).toBeTruthy()
      }
    }
  })

  it('keeps "paste a token" as a peer of the account tabs', () => {
    // Not a fallback to be tidied away later: machines with no account (CI,
    // servers) and everyone already holding a token depend on this path.
    expect(SOURCE).toContain("'login', 'register', 'token'")
    expect(SOURCE).toContain('p2p.link.configure')
  })

  it('calls the three account commands', () => {
    expect(SOURCE).toContain('p2p.account.${verb}')
    expect(SOURCE).toContain("'p2p.account.logout'")
    // The verb is one of exactly two; a third would reach an unregistered handler.
    expect(SOURCE).toContain("verb: 'login' | 'register'")
  })

  it('never keeps the password around', () => {
    // It is sent once and exchanged for a token. Anything that outlives the
    // request is a credential sitting in a renderer process.
    expect(SOURCE).toContain('function resetP2pAccountForm')
    expect(SOURCE).toMatch(/resetP2pAccountForm\(\)[\s\S]{0,400}p2pStatus\.value = resp\.payload\.status/)
    expect(SOURCE).toContain("p2pPassword.value = ''")
  })

  it('masks the password field', () => {
    expect(SOURCE).toMatch(/id="p2p-password"[\s\S]{0,200}type="password"/)
  })

  it('distinguishes signing in as an account from holding a pasted token', () => {
    // hasToken is true for both; only an email says *which* account this is.
    expect(SOURCE).toContain("const p2pSignedIn = computed(() => Boolean(p2pStatus.value?.accountEmail))")
  })

  it('locks the server address while signed in', () => {
    // Pointing a live session at a different server would leave the stored
    // token describing an account that server has never heard of.
    expect(SOURCE).toMatch(/id="p2p-server-url"[\s\S]{0,300}p2pBusy \|\| p2pSignedIn/)
  })

  it('offers sign-out only when signed in', () => {
    expect(SOURCE).toMatch(/v-if="p2pSignedIn"[\s\S]{0,1200}@click="p2pLogout"/)
  })

  it('asks for the optional names only when registering', () => {
    expect(SOURCE).toMatch(/v-if="p2pMode === 'register'"[\s\S]{0,900}p2p-tenant-name/)
  })

  it('submits on Enter from the password field', () => {
    expect(SOURCE).toMatch(/@keyup\.enter="submitP2pAccount\(/)
  })
})
