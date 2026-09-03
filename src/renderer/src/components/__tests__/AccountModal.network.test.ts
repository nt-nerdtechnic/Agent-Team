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
const APP = readFileSync(resolve(here, '../../App.vue'), 'utf8')

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

  it('has every state word the wire can carry', () => {
    // The wire vocabulary: the sidebar's own badge words (sessions.upsert
    // enforces the list), plus `disconnected` which only the directory knows,
    // plus `not-opened` which this device substitutes for a pane that was
    // restored but never opened, plus `waiting` from a machine too old to send
    // a badge word. Every one of them has to render as something.
    const WIRE = [
      'running', 'idle', 'starting', 'awaiting', 'exited', 'error', 'stopped',
      'disconnected', 'not-opened', 'waiting',
    ]
    for (const locale of LOCALES) {
      const messages = i18n.global.getLocaleMessage(locale) as Record<string, any>
      for (const state of WIRE) {
        const badge = state === 'not-opened' ? 'waiting' : state === 'waiting' ? 'idle' : state
        expect(messages.paneStatus[badge], `${locale}/paneStatus.${badge}`).toBeTruthy()
      }
    }
  })

  it('shows a word from a newer build raw rather than hiding the pane', () => {
    // A machine on a build newer than this one can report a state this one has
    // no label for. Falling back to the raw word keeps the pane visible and
    // legible; the failure this guards against is a blank pill, or worse, a
    // dotted i18n key shown to a person.
    expect(MODAL).toMatch(/const label = t\(key\)[\s\S]{0,60}label === key \? value : label/)
  })

  it('calls a pane what the sidebar calls it, by reading the same words', () => {
    // The invariant is unchanged — one pane must not be two different things in
    // two places — but it is now structural rather than kept in step by hand.
    // This used to be two vocabularies (`settings.p2p.network.status-*` here,
    // `paneStatus.*` in the sidebar) with a test asserting they matched; they
    // did not, and could not, because they were maintained separately: the
    // sidebar said "idle", this said "Waiting", for the same pane.
    expect(MODAL).toMatch(/`paneStatus\.\$\{WIRE_TO_BADGE\[value\] \?\? value\}`/)

    // The regression line. Reintroducing a private copy of the vocabulary is
    // exactly how the two drifted apart the first time, and it would pass every
    // other test in this file.
    expect(MODAL).not.toContain('settings.p2p.network.status-')
    for (const locale of LOCALES) {
      const strings = network(locale)
      const copies = Object.keys(strings).filter((k) => k.startsWith('status-'))
      expect(copies, `${locale} still carries a second status vocabulary`).toEqual([])
    }
  })

  it('reports the badge word from the same expression the sidebar renders', () => {
    // The two ends of this feature live in different processes, and the only
    // thing keeping them honest is that one function answers for both. Two
    // copies of the expression is how the sidebar came to say "running" while
    // the network view said "not opened" about the same pane.
    const uses = [...APP.matchAll(/paneDisplayStatus\(/g)].length
    expect(uses, 'paneDisplayStatus should be declared once and called twice').toBe(3)
    expect(APP).toMatch(/reportPaneBusy\(pane\.id, [^,]+, paneDisplayStatus\(pane\)\)/)
    expect(APP).toMatch(/status: paneDisplayStatus\(p\) \|\| 'waiting'/)

    // Both facts in one message: the registry must never hold this tick's flag
    // beside the last tick's word.
    expect(APP).toMatch(/'agent_msg\.set_busy', \{ pane_id: paneId, busy, status \}/)
  })

  it('translates the two wire words that are not badge words', () => {
    // `not-opened` and `waiting` are the only two that need a mapping, and both
    // are load-bearing: without the first a cold-restore placeholder renders
    // raw, and without the second a pane on an un-upgraded machine would be
    // labelled "not opened" — which is a different claim entirely.
    expect(MODAL).toContain(
      "const WIRE_TO_BADGE: Record<string, string> = { 'not-opened': 'waiting', waiting: 'idle' }",
    )
  })

  it('colours the pills by state', () => {
    expect(MODAL).toMatch(/\.pane-pill\.st-running \{[^}]*--success-fg/)
    expect(MODAL).toMatch(/\.pane-pill\.st-waiting \{[^}]*--attention-fg/)
    expect(MODAL).toMatch(/\.pane-pill\.st-disconnected \{[^}]*border-color/)
    // A pane holding a prompt open is the reason to look at another machine's
    // list at all, so it is loud rather than hollow.
    expect(MODAL).toMatch(/\.pane-pill\.st-awaiting \{[^}]*--attention-fg/)
    // A state with no rule of its own renders as the default pill, which reads
    // as "nothing to see here" — the wrong answer for a pane whose CLI died.
    for (const dead of ['error', 'stopped', 'exited']) {
      expect(MODAL, `st-${dead} has no colour rule`).toMatch(
        new RegExp(`\\.pane-pill\\.st-${dead}[^{]*\\{[^}]*--danger-fg|\\.pane-pill\\.st-${dead},`),
      )
    }
    for (const quiet of ['idle', 'starting']) {
      expect(MODAL, `st-${quiet} has no colour rule`).toMatch(
        new RegExp(`\\.pane-pill\\.st-${quiet}[,\\s]`),
      )
    }
    expect(MODAL).toMatch(/\.pane-pill\.st-not-opened \{[^}]*border-color/)
  })

  // ---- the trust surface ----------------------------------------------------

  it('shows the knock list only when something is waiting', () => {
    // An empty box here would read as a feature to configure; the absence of a
    // request is the normal state.
    expect(MODAL).toContain('v-if="signedIn && accessRequests.length"')
    expect(MODAL).toContain('v-if="signedIn && blocked.length"')
  })

  it('puts the decision above the network it is about', () => {
    // The only part of the panel waiting on the user goes first.
    const requests = MODAL.indexOf("settings.p2p.trust.requests-title")
    const net = MODAL.indexOf("settings.p2p.network.title")
    expect(requests).toBeGreaterThan(-1)
    expect(requests).toBeLessThan(net)
  })

  it('offers all three answers to a knock', () => {
    for (const action of ['approveRequest(req)', 'dismissRequest(req)', 'blockRequest(req)']) {
      expect(MODAL).toContain(action)
    }
    expect(MODAL).toContain('unblock(entry)')
  })

  it('cannot act on two knocks at once', () => {
    // Every one of these writes the whole policy document, so a second click
    // landing mid-write would be a read-modify-write race against ourselves.
    expect(MODAL).toMatch(/if \(deciding\.value\) return/)
    expect(MODAL.match(/:disabled="!!deciding"/g)?.length).toBe(4)
  })

  it('re-reads after every decision, so a row leaves only when it really did', () => {
    expect(MODAL).toMatch(/await props\.backend\.send\(type, args\)[\s\S]{0,60}await loadNetwork\(\)/)
  })

  it('reads the trust state from the snapshot it already polls', () => {
    // Not a second timer and not a subscription: one read, so the panel cannot
    // draw half of one moment and half of the next.
    expect(MODAL).toContain('network.value?.accessRequests ?? []')
    expect(MODAL).toContain('network.value?.blocked ?? []')
    expect(MODAL.match(/'p2p\.network\./g)?.length).toBe(1)
  })

  it('gives a remote agent no way to approve itself', () => {
    // The hole this closes is the one RustDesk defends against by swallowing
    // clicks in its accept window that land right after a remote-injected
    // click: a peer that can drive the UI can otherwise grant itself access.
    // Here the defence is structural rather than timing-based — the trust
    // decisions are backend messages the modal sends, never `ui.*` commands,
    // and `ui_invoke` can only reach a registered command. Registering one of
    // these would hand every CLI agent on this machine, local or relayed in,
    // the ability to approve a device on the user's behalf.
    const commands = [...APP.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1])
    expect(commands.length).toBeGreaterThan(0)
    for (const name of commands) {
      expect(name).not.toMatch(/trust|access_request|approve|unblock/i)
    }
    // ...and the modal reaches them the only way that stays out of that registry.
    for (const type of [
      'p2p.access_requests.approve',
      'p2p.access_requests.dismiss',
      'p2p.trust.block',
      'p2p.trust.unblock',
    ]) {
      expect(MODAL).toContain(type)
      expect(APP).not.toContain(type)
    }
  })

  // ---- rate limiting --------------------------------------------------------

  it('does not tell a throttled sign-in that a mail was sent', () => {
    // RATE_LIMITED now arrives from two places. The verification-resend
    // sentence ("a link was just sent") would send someone throttled for
    // repeated sign-in attempts looking through an inbox for something nobody
    // sent, so the mail wording is reachable only from the resend call site.
    expect(MODAL).toMatch(/where === 'resend'[\s\S]{0,80}verify-rate-limited/)
    expect(MODAL).toContain("explain(resp.error, resp.error?.message ?? t('account.err-generic'), 'resend')")
  })

  it('says how long the wait is, using what the server reported', () => {
    // "Try again later" with no number is the kind of message people retry
    // against pointlessly; the server already sends retryAfterMs.
    expect(MODAL).toContain('error?.details?.retryAfterMs')
    expect(MODAL).toContain("t('account.err-rate-limited', { seconds })")
    expect(MODAL).toContain("t('account.err-rate-limited-soon')")
    for (const locale of LOCALES) {
      const messages = i18n.global.getLocaleMessage(locale) as Record<string, any>
      expect(messages.account['err-rate-limited'], `${locale}/err-rate-limited`).toContain('{seconds}')
      expect(messages.account['err-rate-limited-soon'], `${locale}/soon`).toBeTruthy()
    }
  })

  // ---- the switch and what it discloses ---------------------------------------

  it('turns the link off without throwing the account away', () => {
    // Signing out was the only way to stop this machine talking to the server,
    // and it discards the credential — so "off for now" cost the user their
    // account on this device.
    expect(MODAL).toContain("'p2p.link.set_paused'")
    expect(MODAL).toContain('paused: !paused.value')
  })

  it('shows paused as its own thing, not as a connection failure', () => {
    // Pausing is something a person did. Rendering it as "unreachable" would
    // blame the network for their own switch.
    expect(MODAL).toMatch(/paused \? t\('settings\.p2p\.link\.paused'\)/)
    expect(MODAL).toContain('status.value?.paused === true')
  })

  it('reports the link state and reason the backend gave, not a summary', () => {
    expect(MODAL).toContain('settings.p2p.link.state-')
    expect(MODAL).toContain('status.detail')
    for (const locale of LOCALES) {
      const link = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.link
      for (const state of [
        'unconfigured',
        'connecting',
        'connected',
        'unreachable',
        'unauthorized',
      ]) {
        expect(link[`state-${state}`], `${locale}/state-${state}`).toBeTruthy()
      }
    }
  })

  // ---- trust notices -----------------------------------------------------------

  it('tells a first sighting apart from a changed key', () => {
    // In the data these are the same event; only the pinning makes them
    // different, and only one of them is a refusal happening right now.
    expect(MODAL).toContain("n.kind === 'device-key-changed'")
    expect(MODAL).toContain("n.kind === 'policy-unverified'")
  })

  it('offers no button on a changed key, and shows both fingerprints', () => {
    // The backend refuses to dismiss these, so a button here would always fail
    // and read as a bug rather than as a rule. Comparing the two fingerprints
    // out of band is the only real answer, so both are on screen.
    const changed = MODAL.slice(
      MODAL.indexOf("n.kind === 'device-key-changed'"),
      MODAL.indexOf("n.kind === 'policy-unverified'"),
    )
    expect(changed).toContain('n.pinnedFingerprint')
    expect(changed).toContain('n.offeredFingerprint')
    expect(changed).not.toContain('dismissNotice')
  })

  it('flags a new device that landed in the own-machines ring', () => {
    // That ring skips the rules entirely, so it is the one first sighting that
    // is not merely informational.
    expect(MODAL).toContain('n.own')
    expect(MODAL).toContain('settings.p2p.trust.first-seen-own')
  })

  it('asks someone to vouch for a first-seen device before it skips the rules', () => {
    // The device is pinned either way; what approval releases is the own-machine
    // ring, which consults no policy. So the panel has to offer the act, and it
    // has to show the fingerprint next to it — that is the one part of the
    // question a server cannot answer for you.
    const start = MODAL.indexOf('settings.p2p.trust.pending-title')
    expect(start).toBeGreaterThan(-1)
    const section = MODAL.slice(start, MODAL.indexOf('</section>', start))
    expect(section).toContain('row.fingerprint')
    expect(section).toContain('approveDevice(row)')
    expect(MODAL).toContain("'p2p.trust.device.approve'")
  })

  it('keeps pending approvals out of the notice list', () => {
    // A notice records that something happened and can be acknowledged away. A
    // pending approval is a question that is still open, and acknowledging the
    // first-sighting notice must not be able to answer it — so it reads from
    // its own field rather than filtering the notices.
    expect(MODAL).toContain('network.value?.trustPending')
    const start = MODAL.indexOf('settings.p2p.trust.pending-title')
    const section = MODAL.slice(start, MODAL.indexOf('</section>', start))
    expect(section).not.toContain('dismissNotice')
    expect(section).not.toContain('trustNotices')
  })

  it('no longer tells the reader that an own first sighting skips the rules', () => {
    // It used to, and it was true then. Approval made it false, and copy that
    // describes a defence the code stopped providing is worse than no copy: it
    // reads as reassurance at exactly the moment someone is deciding whether to
    // ask about a machine they did not add.
    for (const locale of LOCALES) {
      const trust = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p
        .trust as Record<string, string>
      expect(trust['first-seen-own-body']).toBeTruthy()
      expect(trust['first-seen-own-body']).not.toMatch(/skip your rules entirely\./)
      expect(trust['first-seen-own-body']).not.toMatch(/完全不經過你的規則。/)
    }
  })

  it('gives no way to clear a trust lock', () => {
    // Starting over is precisely what deleting that state was meant to achieve.
    // Sliced from the section's own markup, not from the first mention of
    // `trustLocked` — that is the type declaration, and a slice starting there
    // sweeps in every button between it and the template.
    const start = MODAL.indexOf('settings.p2p.trust.locked-title')
    expect(start).toBeGreaterThan(-1)
    const locked = MODAL.slice(start, MODAL.indexOf('</section>', start))
    expect(locked).toContain('settings.p2p.trust.locked-body')
    expect(locked).not.toMatch(/<button/)
  })

  it('has every link string it shows, in both locales', () => {
    const keys = new Set<string>()
    for (const m of MODAL.matchAll(/[$]?t\(\s*'settings\.p2p\.link\.([a-z0-9]+(?:-[a-z0-9]+)*)'/g)) {
      keys.add(m[1])
    }
    expect(keys.size).toBeGreaterThan(0)
    for (const locale of LOCALES) {
      const link = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.link
      for (const key of keys) expect(link?.[key], `${locale}/link.${key}`).toBeTruthy()
    }
  })

  it('has every trust string it shows, in both locales', () => {
    const keys = new Set<string>()
    const re = /[$]?t\(\s*'settings\.p2p\.trust\.([a-z0-9]+(?:-[a-z0-9]+)*)'/g
    for (const m of MODAL.matchAll(re)) keys.add(m[1])
    expect(keys.size).toBeGreaterThan(0)
    for (const locale of LOCALES) {
      const messages = i18n.global.getLocaleMessage(locale) as Record<string, any>
      const trust = messages?.settings?.p2p?.trust as Record<string, string>
      for (const key of keys) {
        expect(trust?.[key], `${locale}/settings.p2p.trust.${key}`).toBeTruthy()
      }
    }
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
