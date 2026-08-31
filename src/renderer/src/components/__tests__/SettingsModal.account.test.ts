// @vitest-environment happy-dom
// Account sign-in, across the two places it now lives.
//
// The form lives in AccountModal.vue, opened from the titlebar "Sign in"
// button: signing in is the *first* thing a new user does, and burying it in
// Settings meant it could only be found by someone who already knew it was
// there. It is an in-app modal (like Settings), not a separate OS window.
//
// So the split this file pins down is:
//   - AccountModal.vue owns the form — sign in, create account, paste a token
//     (and must not leak the password)
//   - SettingsModal.vue shows read-only link status plus a hint pointing at
//     the titlebar — not a door, not a token form, not a second copy
//   - neither offers a server address: it is built into the app
//
// Neither component is mounted: SettingsModal takes six composable APIs as
// props and pulls in the analyzer, updater and MCP catalog. Same source-scan
// approach as SettingsModal.teamMembers.test.ts.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

const LOCALES = ['en-US', 'zh-TW'] as const
const here = dirname(fileURLToPath(import.meta.url))
const SETTINGS = readFileSync(resolve(here, '../SettingsModal.vue'), 'utf8')
const MODAL = readFileSync(resolve(here, '../AccountModal.vue'), 'utf8')
const MAIN = readFileSync(resolve(here, '../../main.ts'), 'utf8')

function block(locale: (typeof LOCALES)[number], path: string[]): Record<string, string> {
  let node = i18n.global.getLocaleMessage(locale) as Record<string, any>
  for (const key of path) node = node?.[key]
  return node as Record<string, string>
}

/** Literal i18n keys a source file asks for under one prefix.
 *  Anchored on the translate call so a WS command name that happens to contain
 *  the same word (`p2p.account.logout`) is not mistaken for a translation key. */
function keysUnder(source: string, prefix: string): string[] {
  const found = new Set<string>()
  const esc = prefix.replace(/\./g, '\\.')
  const re = new RegExp(`[$]?t\\(\\s*'${esc}\\.([a-z0-9]+(?:-[a-z0-9]+)*)'`, 'g')
  for (const m of source.matchAll(re)) found.add(m[1])
  return [...found]
}

describe('account modal', () => {
  it('is a modal, not a window type', () => {
    expect(MAIN).not.toContain("case 'account'")
    expect(MAIN).not.toContain('AccountWindow' + 'App')
    expect(MODAL).toMatch(/class="s-overlay[^"]*"[^>]*@click\.self="emit\('close'\)"/)
    expect(MODAL).toContain("e.key === 'Escape'")
  })

  it('offers the three modes', () => {
    expect(MODAL).toContain("'login', 'register', 'token'")
    expect(MODAL).toMatch(/id="acct-password"[\s\S]{0,240}type="password"/)
    expect(MODAL).toMatch(/id="acct-token"[\s\S]{0,240}type="password"/)
  })

  it('talks to the existing backend calls', () => {
    expect(MODAL).toContain('p2p.account.${mode.value}')
    expect(MODAL).toContain("'p2p.link.configure', { token: token.value }")
    expect(MODAL).toContain("'p2p.account.logout'")
    expect(MODAL).toContain("'p2p.link.status'")
  })

  it('never keeps the password around', () => {
    // Sent once and exchanged for a token; anything that outlives the request
    // is a credential sitting in a renderer process.
    expect(MODAL).toMatch(/password\.value = ''/)
    expect(MODAL).toMatch(/password\.value = ''[\s\S]{0,300}status\.value = resp\.payload\.status/)
  })

  // Registering asks for email and password only. The server derives the
  // display name and the network name from the email, and neither can be
  // changed afterwards, so offering fields here would be a one-way decision
  // taken by someone who has no way to judge it yet.
  it('does not ask for a display name or a network name', () => {
    expect(MODAL).not.toContain('acct-display')
    expect(MODAL).not.toMatch(/payload\.displayName\s*=/)
  })

  it('submits on Enter from the password and token fields', () => {
    expect(MODAL.match(/@keyup\.enter="submit"/g)?.length).toBe(2)
  })

  it('shows the account and offers sign-out once signed in', () => {
    expect(MODAL).toMatch(/v-if="signedIn"[\s\S]{0,1200}status\.role/)
    expect(MODAL).toMatch(/@click="signOut"/)
    expect(MODAL).toContain("emit('changed')")
  })

  it('translates a server that predates accounts instead of showing its code', () => {
    expect(MODAL).toContain("'UNKNOWN_TYPE'")
    expect(MODAL).toContain('account.err-unsupported')
  })

  it('has every string it shows, in both locales', () => {
    const keys = keysUnder(MODAL, 'account')
    expect(keys.length).toBeGreaterThan(4)
    const nested = keysUnder(MODAL, 'settings.p2p.account')
    expect(nested.length).toBeGreaterThan(3)
    for (const locale of LOCALES) {
      const strings = block(locale, ['account'])
      expect(strings, locale).toBeTruthy()
      for (const key of keys) expect(strings[key], `${locale}/${key}`).toBeTruthy()
      const acct = block(locale, ['settings', 'p2p', 'account'])
      for (const key of nested) expect(acct[key], `${locale}/${key}`).toBeTruthy()
      for (const mode of ['login', 'register', 'token']) {
        expect(acct[`tab-${mode}`], `${locale}/tab-${mode}`).toBeTruthy()
        expect(acct[`submit-${mode}`], `${locale}/submit-${mode}`).toBeTruthy()
      }
    }
  })

  // Soft gate: an unverified account signs in and works. What the modal owes
  // the user is a way to notice and a way to act, not a wall.
  it('shows the verification notice with a resend button while unverified', () => {
    expect(MODAL).toContain("'p2p.account.resend_verification'")
    expect(MODAL).toMatch(/v-if="signedIn && verifyPending"[\s\S]{0,400}account\.verify-sent/)
    expect(MODAL).toMatch(/account\.verify-resend[\s\S]{0,120}<\/button>/)
    expect(MODAL).toMatch(/:disabled="resending"[\s\S]{0,200}resendVerification/)
  })

  it('only ticks an email the server actually confirmed', () => {
    // "Unknown" is not "confirmed": a reconnecting link reports no flag, and a
    // tick shown then would tell an unverified user they are done.
    expect(MODAL).toContain("status.value?.emailVerified === true")
    expect(MODAL).toMatch(/v-if="verified"[\s\S]{0,120}account\.verified/)
  })

  it('seeds the notice from the registration reply, not from the next poll', () => {
    // The link has only just been told to reconnect; waiting for its auth.hello
    // would leave a new account with no sign that a mail was sent at all.
    expect(MODAL).toMatch(/account\.emailVerified !== true/)
    // And the poll only trusts a connected link.
    expect(MODAL).toMatch(/state === 'connected'[\s\S]{0,160}emailVerified === false/)
  })

  it('translates the verification codes instead of showing them raw', () => {
    expect(MODAL).toMatch(/'RATE_LIMITED'[\s\S]{0,120}verify-rate-limited/)
    expect(MODAL).toMatch(/'EMAIL_UNVERIFIED'[\s\S]{0,120}verify-required/)
  })

  it('shows no server address field', () => {
    // The address is built into the app; a typo'd one produced a link that
    // silently never dialled, with no correct value a user could discover.
    // (`serverUrl` still appears once, as a field of the status payload type.)
    expect(MODAL).not.toMatch(/<input[^>]*server/i)
    expect(MODAL).not.toMatch(/v-model="[^"]*[sS]erverUrl"/)
    expect(MODAL).not.toContain('serverUrl:'.concat(' ref'))
  })
})

describe('settings — read-only link status', () => {
  it('neither opens a window nor duplicates the form', () => {
    expect(SETTINGS).not.toContain('openAccount' + 'Window')
    expect(SETTINGS).not.toContain('submitP2pAccount')
    expect(SETTINGS).not.toMatch(/id="p2p-password"/)
    expect(SETTINGS).not.toMatch(/id="p2p-token"/)
    expect(SETTINGS).not.toContain('p2p-advanced')
    expect(SETTINGS).not.toContain('p2p.link.configure')
    expect(SETTINGS).not.toContain('p2p.account.logout')
  })

  it('no longer offers a server address', () => {
    expect(SETTINGS).not.toContain('p2pServerUrl')
    expect(SETTINGS).not.toMatch(/id="p2p-server-url"/)
  })

  it('keeps the status block and points at the titlebar', () => {
    expect(SETTINGS).toContain("'p2p.link.status'")
    expect(SETTINGS).toMatch(/data-settings-section="general-p2p"[\s\S]{0,1600}settings\.p2p\.account\.hint-titlebar/)
    expect(SETTINGS).toContain('data-settings-section="general-p2p-policy"')
  })

  it('has every string it shows, in both locales', () => {
    const keys = keysUnder(SETTINGS, 'settings.p2p.account')
    expect(keys.length).toBeGreaterThan(0)
    for (const locale of LOCALES) {
      const strings = block(locale, ['settings', 'p2p', 'account'])
      for (const key of keys) expect(strings[key], `${locale}/${key}`).toBeTruthy()
      // Orphans of the removed form must not linger.
      const p2p = block(locale, ['settings', 'p2p'])
      for (const gone of ['server-url', 'server-url-placeholder']) expect(p2p[gone], `${locale}/${gone}`).toBeUndefined()
    }
  })
})
