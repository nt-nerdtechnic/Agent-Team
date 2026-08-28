// @vitest-environment happy-dom
// Settings → Cross-device messaging → Team members.
//
// The card is a thin view over the server: the roster, the role and whether
// this device may act on either all arrive in the `p2p.members.list` payload,
// and the server refuses anything an admin did not send. What this file pins
// down is the half that lives only in the renderer — that every string the card
// shows exists in both locales, that the roles it offers are the three
// membership roles and not the session's `driver`, and that the strings which
// carry the two facts a user cannot recover from (a one-time token, a revoke
// that drops live connections) actually say so.
//
// The card itself is not mounted: SettingsModal takes six composable APIs as
// props and pulls in the analyzer, the updater and the MCP catalog, none of
// which this behaviour touches.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

const LOCALES = ['en-US', 'zh-TW'] as const

/** The server's membership enum. `driver` is a session role and must never
 *  appear here — a member cannot be given it and the server would refuse. */
const MEMBER_ROLES = ['admin', 'member', 'observer'] as const

const SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../SettingsModal.vue'),
  'utf8'
)

function block(locale: (typeof LOCALES)[number]): Record<string, string> {
  const messages = i18n.global.getLocaleMessage(locale) as Record<string, any>
  return messages.settings?.p2p?.members
}

/** Every literal `settings.p2p.members.*` key the card asks for. Scanned from
 *  the source rather than hand-listed so a key added to the template without a
 *  translation fails here instead of rendering as its own path.
 *
 *  Keys the card composes at render time (`'…role-' + member.role`) end at a
 *  dash and are deliberately not matched — the role test below covers those. */
function literalKeys(): string[] {
  const found = new Set<string>()
  for (const match of SOURCE.matchAll(/settings\.p2p\.members\.([a-z0-9]+(?:-[a-z0-9]+)*)['"]/g)) {
    found.add(match[1])
  }
  return [...found]
}

describe('Settings — team members', () => {
  it('asks for keys at all', () => {
    // Guards the scan itself: a regex that silently stops matching would make
    // every assertion below vacuously true.
    expect(literalKeys().length).toBeGreaterThan(15)
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

  it('labels exactly the three membership roles', () => {
    for (const locale of LOCALES) {
      const strings = block(locale)
      for (const role of MEMBER_ROLES) {
        expect(strings[`role-${role}`], `${locale}/role-${role}`).toBeTruthy()
      }
      // `driver` is the session's role, not a membership one.
      expect(strings['role-driver'], locale).toBeUndefined()
    }
  })

  it('offers the three roles in the markup and nothing else', () => {
    const declared = SOURCE.match(/const MEMBER_ROLES = \[(.+?)\] as const/)?.[1]
    expect(declared).toBeTruthy()
    expect(declared).toBe("'admin', 'member', 'observer'")
  })

  it('warns that the invite token is shown once, in both locales', () => {
    for (const locale of LOCALES) {
      const strings = block(locale)
      // The one step of the flow that cannot be undone: the server strips the
      // token from every later read, so a card that did not say so would lose
      // it silently.
      expect(strings['token-once'], locale).toBeTruthy()
      expect(strings['token-once'].length, locale).toBeGreaterThan(40)
      expect(strings['token-copy'], locale).toBeTruthy()
      expect(strings['token-title'], locale).toContain('{name}')
    }
  })

  it('says the confirmation drops live connections, and reports how many', () => {
    for (const locale of LOCALES) {
      const strings = block(locale)
      expect(strings['revoke-confirm'], locale).toContain('{name}')
      expect(strings['revoke-cancel'], locale).toBeTruthy()
      expect(strings['revoke-do'], locale).toBeTruthy()
      // droppedConnections is the whole reason revoke is not just a flag flip.
      expect(strings['revoked'], locale).toContain('{count}')
    }
  })

  it('separates "you are not an admin" from "the link is down"', () => {
    // Two different reasons the actions are missing, and two different things
    // to do about them.
    for (const locale of LOCALES) {
      const strings = block(locale)
      expect(strings['readonly-role'], locale).toBeTruthy()
      expect(strings['readonly-offline'], locale).toBeTruthy()
      expect(strings['readonly-role']).not.toBe(strings['readonly-offline'])
    }
  })

  it('gates the actions on the backend\'s canManage, never on a local guess', () => {
    // A renderer that derived this from `role` would show buttons to a member
    // whose every request the server refuses, and would keep showing them after
    // the link dropped.
    expect(SOURCE).toContain("p2pMembers.value?.canManage === true")
    expect(SOURCE).not.toMatch(/role\s*===\s*'admin'/)
  })

  it('never offers a delete: revoke disables and the row stays', () => {
    expect(SOURCE).not.toContain('p2p.members.delete')
    expect(SOURCE).toContain('p2p.members.revoke')
  })
})
