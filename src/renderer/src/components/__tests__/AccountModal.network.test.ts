// @vitest-environment happy-dom
// "Your network": the devices signed in to this team space and the CLI panes
// running on each, shown inside the account modal.
//
// Source-scan, like SettingsModal.account.test.ts beside it: AccountModal takes
// the whole backend composable as a prop, so mounting it would mean faking a
// WebSocket to assert on markup that is already right there in the file.
//
// What these pin down is the part that is easy to get subtly wrong later:
//   - it is one call, on the timer that was already running
//   - one device is a normal state with something to say, not a blank box
//   - the box does not grow under the pointer when the first snapshot lands
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

const LOCALES = ['en-US', 'zh-TW'] as const
const here = dirname(fileURLToPath(import.meta.url))
const MODAL = readFileSync(resolve(here, '../AccountModal.vue'), 'utf8')

function network(locale: (typeof LOCALES)[number]): Record<string, string> {
  const messages = i18n.global.getLocaleMessage(locale) as Record<string, any>
  return messages?.settings?.p2p?.network as Record<string, string>
}

/** Literal i18n keys the file asks for under `settings.p2p.network`. */
function networkKeys(): string[] {
  const found = new Set<string>()
  const re = /[$]?t\(\s*'settings\.p2p\.network\.([a-z0-9]+(?:-[a-z0-9]+)*)'/g
  for (const m of MODAL.matchAll(re)) found.add(m[1])
  return [...found]
}

describe('account modal — your network', () => {
  it('asks the backend for the whole network in one call', () => {
    // Devices, presence and panes in one read: three round trips per poll tick
    // would be three chances to render a half-updated picture.
    expect(MODAL).toContain("'p2p.network.snapshot'")
    expect(MODAL.match(/'p2p\.network\./g)?.length).toBe(1)
  })

  it('rides the status poll instead of starting a second timer', () => {
    // The backend keeps its copy current from the server's sessions.changed and
    // presence.changed pushes, so this is a cache read, not server traffic.
    expect(MODAL).toMatch(/async function refresh\(\)[\s\S]{0,200}loadStatus\(\)[\s\S]{0,80}loadNetwork\(\)/)
    expect(MODAL).toContain('timer = setInterval(() => void refresh(), 3000)')
    expect(MODAL.match(/setInterval\(/g)?.length).toBe(1)
    // Both events are named where the reason for reading a cache is explained,
    // because dropping either one silently stops the view updating.
    expect(MODAL).toContain('sessions.changed')
    expect(MODAL).toContain('presence.changed')
  })

  it('renders a row per device with an online dot and a pane count', () => {
    expect(MODAL).toMatch(/v-for="device in devices"[\s\S]{0,600}deviceLabel\(device\)/)
    expect(MODAL).toMatch(/class="dot"\s*:class="device\.online \? 'ok' : 'idle'"/)
    expect(MODAL).toContain('paneCountLabel(device.paneCount)')
    // The label falls back to the id, shortened — a server that sends no
    // deviceName must still produce something a person can tell apart.
    expect(MODAL).toMatch(/deviceName\) return device\.deviceName/)
    expect(MODAL).toMatch(/device\.deviceId\.slice\(0, 12\)/)
  })

  it('badges the machine the user is sitting at', () => {
    expect(MODAL).toMatch(/v-if="device\.isLocal"[\s\S]{0,160}settings\.p2p\.network\.this-device/)
  })

  it('renders the panes under each device with a status pill', () => {
    expect(MODAL).toMatch(/v-for="pane in device\.panes"[\s\S]{0,700}pane\.agentKey/)
    expect(MODAL).toMatch(/pane-name">\{\{ pane\.title \}\}/)
    expect(MODAL).toMatch(/pane-ws">\{\{ pane\.workspace \}\}/)
    expect(MODAL).toMatch(/class="pane-pill" :class="'st-' \+ pane\.status"/)
    expect(MODAL).toContain('statusLabel(pane.status)')
  })

  it('translates the states it knows and shows anything else raw', () => {
    // Four of them are the server's vocabulary (sessions.upsert enforces it);
    // 'not-opened' is substituted by this device's own backend for a pane that
    // was restored but never opened, which only this machine can know. A value
    // a newer server invents is still passed through, never hidden.
    expect(MODAL).toContain(
      "const KNOWN_STATUSES = ['running', 'waiting', 'exited', 'disconnected', 'not-opened']",
    )
    expect(MODAL).toMatch(/KNOWN_STATUSES\.includes\(value\)[\s\S]{0,90}: value/)
    for (const locale of LOCALES) {
      const strings = network(locale)
      for (const state of ['running', 'waiting', 'exited', 'disconnected', 'not-opened']) {
        expect(strings[`status-${state}`], `${locale}/status-${state}`).toBeTruthy()
      }
    }
  })

  it('calls an unopened pane what the sidebar calls it', () => {
    // The same pane must not be two different things in two places: the
    // sidebar's paneStatus.waiting is the wording this has to match.
    for (const locale of LOCALES) {
      const messages = i18n.global.getLocaleMessage(locale) as Record<string, any>
      expect(network(locale)['status-not-opened']).toBe(messages.paneStatus.waiting)
    }
  })

  it('colours the pills by state', () => {
    expect(MODAL).toMatch(/\.pane-pill\.st-running \{[^}]*--success-fg/)
    expect(MODAL).toMatch(/\.pane-pill\.st-waiting \{[^}]*--attention-fg/)
    expect(MODAL).toMatch(/\.pane-pill\.st-disconnected \{[^}]*border-color/)
    expect(MODAL).toMatch(/\.pane-pill\.st-not-opened \{[^}]*border-color/)
  })

  it('says something useful with only one machine signed in', () => {
    // The user's normal state, and the one a blank box would fail.
    expect(MODAL).toMatch(/soloDevice = computed\([\s\S]{0,120}devices\.value\[0\]\.isLocal/)
    expect(MODAL).toMatch(/v-if="soloDevice"[\s\S]{0,120}settings\.p2p\.network\.solo/)
    // A device with no panes is not an empty section either.
    expect(MODAL).toMatch(/v-else class="hint net-note">\{\{ t\('settings\.p2p\.network\.no-panes'\)/)
  })

  it('has a waiting state and a not-linked state, not a blank box', () => {
    expect(MODAL).toMatch(/v-if="networkUnavailable"[\s\S]{0,160}settings\.p2p\.network\.unavailable/)
    expect(MODAL).toMatch(/v-else-if="!network"[\s\S]{0,160}settings\.p2p\.network\.loading/)
    expect(MODAL).toContain("resp.error?.code === 'P2P_NOT_CONFIGURED'")
  })

  it('reserves the section height so the modal does not jump', () => {
    expect(MODAL).toMatch(/\.net-card \{[^}]*min-height/)
  })

  it('shows the last picture with a caveat when the link is down', () => {
    // Refusing would read as "you have no network"; the machines did not stop
    // existing because the socket blinked.
    expect(MODAL).toMatch(/networkStale = computed\([\s\S]{0,160}state !== 'connected'/)
    expect(MODAL).toMatch(/v-if="networkStale"[\s\S]{0,120}settings\.p2p\.network\.link-offline/)
  })

  it('drops the network when the account signs out', () => {
    // It belonged to that account; whoever signs in next must not be shown
    // someone else's machines.
    expect(MODAL).toMatch(/resent\.value = false\s*\n[\s\S]{0,320}network\.value = null/)
  })

  it('sits between the account card and sign out, in the same visual language', () => {
    const section = MODAL.indexOf('<section v-if="signedIn" class="net">')
    expect(section).toBeGreaterThan(MODAL.indexOf('<div class="card">'))
    expect(section).toBeLessThan(MODAL.indexOf('@click="signOut"'))
    expect(MODAL).toContain('<div class="card net-card">')
    expect(MODAL).toMatch(/class="hint net-note"/)
  })

  it('has every string it shows, in both locales', () => {
    const keys = networkKeys()
    expect(keys.length).toBeGreaterThan(6)
    for (const locale of LOCALES) {
      const strings = network(locale)
      expect(strings, locale).toBeTruthy()
      for (const key of keys) expect(strings[key], `${locale}/${key}`).toBeTruthy()
      // The count label is three fixed keys rather than a plural rule, so all
      // three have to exist even though only one is asked for literally.
      for (const key of ['panes', 'panes-one', 'panes-none']) {
        expect(strings[key], `${locale}/${key}`).toBeTruthy()
      }
      expect(strings['panes'], locale).toContain('{count}')
    }
  })
})
