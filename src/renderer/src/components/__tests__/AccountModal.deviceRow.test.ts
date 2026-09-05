// @vitest-environment happy-dom
// What a device row actually says, by rendering one.
//
// The rest of this modal's coverage is source-scan, on the belief that it could
// not be mounted. It takes two props. The four things reported about the
// offline row — a name clipped to "M…", a status sentence on two lines, a raw
// ISO timestamp, and six elements of equal weight on one line — are all facts
// about output, and three of the four are checkable here. The fourth (the
// clipping itself) is layout, which no DOM-less renderer can answer; what is
// checkable is that the name is no longer competing with anything for the row,
// and that is asserted below.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'

import AccountModal from '../AccountModal.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'

const here = dirname(fileURLToPath(import.meta.url))
const MODAL = readFileSync(resolve(here, '../AccountModal.vue'), 'utf8')

const NAME = 'MacBook Pro 16 吋'
const EIGHT_MINUTES = 8 * 60_000

let wrapper: VueWrapper | undefined
const original = i18n.global.locale.value

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  i18n.global.locale.value = original
  delete (window as unknown as Record<string, unknown>).agentTeam
})

function lastSeen(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString()
}

async function mountModal(locale: 'en-US' | 'zh-TW' = 'en-US', overrides: object = {}) {
  i18n.global.locale.value = locale
  ;(window as unknown as Record<string, unknown>).agentTeam = {
    trustConfirm: vi.fn().mockResolvedValue({ token: 't' }),
  }
  const mock = createMockBackend('connected')
  mock.setResponse('p2p.link.status', {
    status: { state: 'connected', accountEmail: 'a@b.c', serverUrl: 'wss://x', emailVerified: true },
  })
  mock.setResponse('p2p.network.snapshot', {
    state: 'connected',
    deviceId: 'me',
    devices: [
      { deviceId: 'me', deviceName: 'This one', isLocal: true, online: true, paneCount: 1, panes: [] },
      {
        deviceId: 'f9c30189',
        deviceName: NAME,
        isLocal: false,
        online: false,
        paneCount: 1,
        panes: [],
        trustState: 'trusted',
        lastSeenAt: lastSeen(EIGHT_MINUTES),
        ...overrides,
      },
    ],
  })
  wrapper = mount(AccountModal, {
    props: { open: true, backend: mock.backend as never },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return mock
}

const rows = () => wrapper!.findAll('.dev')
const offline = () => rows()[1]
const t = (key: string, args?: Record<string, unknown>) => i18n.global.t(key, args ?? {})

describe('the offline device row', () => {
  it('gives the name the whole line, with nothing else competing for it', async () => {
    // Reported as "M…": the name shared a row with presence, a trust pill, a
    // pane count and a button, and it was the one that gave way. The two facts
    // that used to sit beside it are now on the line below.
    await mountModal()
    const head = offline().find('.dev-head')

    expect(head.find('.dev-name').text()).toBe(NAME)
    expect(head.find('.dev-presence').exists()).toBe(false)
    expect(head.find('.dev-count').exists()).toBe(false)
    // Left in the head: the lamp, the trust pill, the one action.
    expect(head.find('.dev-tag').text()).toBe(t('settings.p2p.trust.state-trusted'))
  })

  it('says when it was last here in words, not as an ISO timestamp', async () => {
    // It printed `Last seen 2026-09-05T02:39:47.539Z`.
    await mountModal()
    const meta = offline().find('.dev-meta')

    expect(meta.text()).toBe(`${t('settings.p2p.network.device-offline')} · ${t('time.ago-minutes', { count: 8 })}`)
    expect(meta.text()).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(wrapper!.text()).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })

  it('keeps the exact moment on hover, where comparing against a log needs it', async () => {
    await mountModal()
    const title = offline().find('.dev-meta').attributes('title') ?? ''

    expect(title).toBeTruthy()
    expect(title).not.toMatch(/T\d{2}:\d{2}.*Z/)
    expect(Number.isNaN(Date.parse(title))).toBe(false)
  })

  it('says only that it is offline, not a sentence that wraps', async () => {
    // "Offline — cannot be reached" took two lines in this column. The greyed
    // text and the disabled buttons carry the rest of that meaning.
    await mountModal()
    expect(offline().text()).toContain(t('settings.p2p.network.device-offline'))
    expect(offline().text()).not.toContain('cannot be reached')
  })

  it('says nothing false when the device has never been seen', async () => {
    await mountModal('en-US', { lastSeenAt: undefined })
    expect(offline().find('.dev-meta').text()).toContain(
      t('settings.p2p.network.last-seen-unknown'),
    )
    expect(offline().find('.dev-meta').attributes('title')).toBe('')
  })

  it('reports an online device by what it is running instead', async () => {
    // A machine that is not there has no current panes to report; one that is
    // has nothing to say about when it was last seen.
    await mountModal('en-US', { online: true })
    expect(offline().find('.dev-meta').text()).toBe(t('settings.p2p.network.panes-one'))
    expect(offline().find('.dev-meta').attributes('title')).toBe('')
  })
})

describe('the device row in Chinese', () => {
  it('translates the pairing state and the time, both of which were English', async () => {
    // The pill was reported as reading "Paired" in a Chinese window. Both keys
    // exist in both locales; this is what proves the row uses them.
    await mountModal('zh-TW')

    expect(offline().find('.dev-tag').text()).toBe('已配對')
    expect(offline().find('.dev-meta').text()).toBe('離線 · 8 分鐘前')
    expect(wrapper!.text()).not.toContain('Paired')
    expect(wrapper!.text()).not.toContain('minute')
  })
})

describe('the rule that actually stops the clipping', () => {
  it('makes the name the one item that gives up space, and lets it', () => {
    // The only part of this that no renderer here can answer: happy-dom does no
    // layout, and a scoped stylesheet is not applied to a mounted component
    // either, so "was it clipped to M…" is not a question a test can ask. This
    // is a source assertion and is worth exactly what a source assertion is
    // worth — it holds the two declarations that make the difference, and
    // whether they produce the intended line is a thing to look at.
    const rule = MODAL.slice(MODAL.indexOf('.dev-name {'), MODAL.indexOf('}', MODAL.indexOf('.dev-name {')))
    // `min-width: 0` is the one that matters: a flex item's floor is its own
    // content, so without it the name pushes the row wider instead of
    // shortening, and whatever follows wraps.
    expect(rule).toMatch(/flex:\s*1 1 auto/)
    expect(rule).toMatch(/min-width:\s*0/)
    expect(rule).toMatch(/text-overflow:\s*ellipsis/)
    // And nothing else on the row may take the free space, or the name is back
    // to fighting for it.
    expect(MODAL).not.toMatch(/\.dev-trust \{[^}]*margin-left: auto/)
    expect(MODAL).toMatch(/\.dev-head \.dot \{[^}]*flex: none/)
  })
})
