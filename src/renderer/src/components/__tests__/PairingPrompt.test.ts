// @vitest-environment happy-dom
// The prompt that appears when a machine asks to pair.
//
// Two halves. The first is source-scan — where it is mounted, which state it
// reads, which stacking level it uses. The second mounts it for real, because
// what a person pressing Allow sees cannot be established by finding a string
// in a file: the failure it was reported for (button dims, nothing else ever
// happens) would have passed every scan in the first half.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'

import PairingPrompt from '../PairingPrompt.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { _resetForTest } from '../../composables/usePairingState'

const here = dirname(fileURLToPath(import.meta.url))
const PROMPT = readFileSync(resolve(here, '../PairingPrompt.vue'), 'utf8')
const APP = readFileSync(resolve(here, '../../App.vue'), 'utf8')
const MODAL = readFileSync(resolve(here, '../AccountModal.vue'), 'utf8')
const LOCALES = ['en-US', 'zh-TW'] as const

describe('PairingPrompt', () => {
  it('is mounted at the app root, not inside the account window', () => {
    // A request expires in five minutes; it cannot wait for somebody to open a
    // window and scroll five sections down.
    expect(APP).toContain('<PairingPrompt :backend="backend" />')
    expect(APP).toContain("import PairingPrompt from './components/PairingPrompt.vue'")
    // Not lazy: it has to be listening before anybody asks.
    expect(APP).not.toMatch(/defineAsyncComponent\(\(\) => import\('\.\/components\/PairingPrompt/)
  })

  it('reads the same state the account window does', () => {
    // Two copies would drift by exactly one poll — long enough for the card to
    // answer a question this is still asking.
    expect(PROMPT).toContain("from '../composables/usePairingState'")
    expect(MODAL).toContain("from '../composables/usePairingState'")
    expect(PROMPT).toContain('state.prompts.value')
    expect(MODAL).toContain('pairingState.pairings.value')
  })

  it('only asks the side that has something to decide', () => {
    // Interrupting the initiator with a prompt about their own request would be
    // telling somebody what they just did. The filter lives in the composable,
    // so this checks the component asks for the filtered list and the
    // composable is the thing that filters.
    expect(PROMPT).toContain('state.prompts.value')
    const composable = readFileSync(
      resolve(here, '../../composables/usePairingState.ts'), 'utf8',
    )
    expect(composable).toContain("row.role === 'responder'")
  })

  it('shows nothing until there are digits to compare', () => {
    expect(PROMPT).toMatch(/filter\(\(row\) => Boolean\(row\.code\)\)/)
  })

  it('offers allow, refuse and later — and only the first two decide', () => {
    expect(PROMPT).toContain('settings.p2p.pair.allow')
    expect(PROMPT).toContain('settings.p2p.pair.mismatch')
    expect(PROMPT).toContain('settings.p2p.pair.later')
    expect(PROMPT).toContain('answer(card.row, true)')
    expect(PROMPT).toContain('answer(card.row, false)')
    // "Later" hides the prompt; the card in the account window keeps it until
    // it expires, so it decides nothing and is sent nowhere.
    expect(PROMPT).toMatch(/function later\([\s\S]{0,120}state\.dismiss\(row\)/)
    expect(PROMPT).not.toMatch(/function later\([\s\S]{0,200}backend\.send/)
  })

  it('carries a confirmation token for both answers', () => {
    expect(PROMPT).toContain("trustConfirm('p2p.pair.confirm', row.deviceId)")
  })

  it('sits at the notification level, above modals', () => {
    // Reported: the account and settings windows covered it. A question that
    // expires in five minutes and is covered has not appeared at all — and the
    // level for that already exists, so nothing new is invented.
    expect(PROMPT).toContain('z-index: var(--z-toast)')
    expect(PROMPT).not.toContain('var(--z-popover)')
    expect(PROMPT).toContain('position: fixed')
    const tokens = readFileSync(
      resolve(here, '../../../../../packages/plugin-ui/src/foundation/styles/tokens/semantic.css'),
      'utf8',
    )
    // The band this belongs to, and that it really is the top one.
    expect(tokens).toMatch(/--z-toast: (\d+)/)
    const level = (name: string) => Number(tokens.match(new RegExp(`--z-${name}: (\\d+)`))![1])
    expect(level('toast')).toBeGreaterThan(level('modal'))
  })

  it('respects a request for less motion', () => {
    expect(PROMPT).toMatch(/prefers-reduced-motion: reduce[\s\S]{0,80}animation: none/)
  })

  it('does not steal the keyboard', () => {
    // A notification, not a modal: somebody mid-sentence keeps typing.
    expect(PROMPT).toContain('role="status"')
    expect(PROMPT).not.toContain('autofocus')
  })

  for (const locale of LOCALES) {
    it(`names its two answers in ${locale}`, () => {
      const pair = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.pair
      expect(pair.allow).toBeTruthy()
      expect(pair['cancel-request']).toBeTruthy()
    })
  }
})

describe('the initiator no longer confirms', () => {
  const CARD = MODAL.slice(
    MODAL.indexOf('settings.p2p.pair.title'),
    MODAL.indexOf('settings.p2p.trust.needs-you'),
  )

  it('offers withdrawing instead of confirming', () => {
    // Pressing "Pair with…" already said what this side wants; a second button
    // asked the same person the same question twice.
    expect(CARD).toMatch(/v-if="row\.role === 'initiator'"/)
    expect(CARD).toMatch(
      /row\.role === 'initiator'[\s\S]{0,600}settings\.p2p\.pair\.cancel-request/,
    )
    const branch = CARD.slice(
      CARD.indexOf("row.role === 'initiator'"),
      CARD.indexOf("row.state === 'awaiting-remote'"),
    )
    expect(branch).not.toContain('settings.p2p.pair.match')
    expect(branch).toContain('answerPairing(row, false)')
  })

  it('still asks the responder', () => {
    expect(CARD).toContain('settings.p2p.pair.match')
    expect(CARD).toContain('answerPairing(row, true)')
  })
})

// ---- mounted, because pressing a button is what was broken -------------------
//
// The bug: `answer()` sent the confirmation and ignored the reply. A reply of
// `{ok: false}` is not an exception, so the catch never ran, the error was
// never shown, and the same unanswered question was re-rendered — indis-
// tinguishable from a button that does nothing. A successful answer was barely
// better: the card left only when a later poll happened to stop listing it.

const RESPONDER = {
  deviceId: 'dev-asking',
  deviceName: 'M4',
  role: 'responder',
  state: 'awaiting-local',
  code: '482 913',
  fingerprint: '8fe21661 6449c594',
  startedAt: 1_000,
}

/** Long enough to outlast the settled card, whatever its exact duration. */
const AFTER_SETTLED_MS = 10_000

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  _resetForTest()
  vi.useRealTimers()
  delete (window as unknown as Record<string, unknown>).agentTeam
})

async function mountPrompt(pairings: unknown[] = [RESPONDER]) {
  ;(window as unknown as Record<string, unknown>).agentTeam = {
    trustConfirm: vi.fn().mockResolvedValue({ token: 't', issuedAt: 1 }),
  }
  const mock = createMockBackend('connected')
  mock.setResponse('p2p.network.snapshot', { pairings })
  wrapper = mount(PairingPrompt, {
    props: { backend: mock.backend as never },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return mock
}

const t = (key: string, args?: Record<string, unknown>): string => i18n.global.t(key, args ?? {})
const buttons = () => wrapper!.findAll('.pp-btn')
const allow = () => buttons().find((b) => b.classes('pp-primary'))!

describe('PairingPrompt — answering', () => {
  it('draws the question with the digits to compare', async () => {
    await mountPrompt()
    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(1)
    expect(wrapper!.find('.pp-code').text()).toBe('482 913')
  })

  it('replaces the question with the outcome, then takes it away by itself', async () => {
    // The reported failure: pressing Allow paired the devices and left the same
    // card on screen. Nothing about the press was visible.
    vi.useFakeTimers()
    const mock = await mountPrompt()
    mock.setResponse('p2p.pair.confirm', { state: 'confirmed' })

    await allow().trigger('click')
    await flushPromises()
    // The backend has already dropped the pairing by the time it answers, so
    // the card cannot be driven by the list any more.
    mock.setResponse('p2p.network.snapshot', { pairings: [] })
    await flushPromises()

    expect(wrapper!.text()).toContain(t('settings.p2p.pair.paired', { device: 'M4' }))
    expect(buttons()).toHaveLength(0)

    vi.advanceTimersByTime(AFTER_SETTLED_MS)
    await flushPromises()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(0)
  })

  it('says so when the answer was refused, rather than looking the same as allowing', async () => {
    vi.useFakeTimers()
    const mock = await mountPrompt()
    mock.setResponse('p2p.pair.confirm', { state: 'rejected' })

    await buttons().find((b) => b.classes('pp-danger'))!.trigger('click')
    await flushPromises()

    expect(wrapper!.text()).toContain(t('settings.p2p.pair.done-refused'))
    expect(wrapper!.text()).not.toContain(t('settings.p2p.pair.paired', { device: 'M4' }))
  })

  it('shows the backend’s refusal verbatim and keeps the question open', async () => {
    // `{ok: false}` is a resolved promise. Nothing here used to look at it.
    const mock = await mountPrompt()
    mock.setResponse('p2p.pair.confirm', null, {
      ok: false,
      error: { code: 'CONFIRMATION_REQUIRED', message: 'this action needs a confirmation token' },
    })

    await allow().trigger('click')
    await flushPromises()

    expect(wrapper!.find('.pp-err').text()).toBe('this action needs a confirmation token')
    // Still answerable: a refusal that removed the card would lose the request.
    expect(wrapper!.find('.pp-code').exists()).toBe(true)
    expect(allow().attributes('disabled')).toBeUndefined()
  })

  it('shows a dropped connection too, not just a refusal', async () => {
    const mock = await mountPrompt()
    mock.setRejection('p2p.pair.confirm', 'ws not open')

    await allow().trigger('click')
    await flushPromises()

    expect(wrapper!.find('.pp-err').text()).toContain('ws not open')
  })

  it('says it is working while the answer is in flight, and locks the row', async () => {
    // The whole round trip is an IPC for the token plus a socket call. Without
    // this there is nothing between the press and the outcome.
    const mock = await mountPrompt()
    let release!: () => void
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      trustConfirm: vi.fn(() => new Promise((resolve) => { release = () => resolve({ token: 't' }) })),
    }
    mock.setResponse('p2p.pair.confirm', { state: 'confirmed' })

    await allow().trigger('click')
    await flushPromises()

    expect(allow().text()).toBe(t('settings.p2p.pair.sending'))
    for (const button of buttons()) expect(button.attributes('disabled')).toBeDefined()

    release()
    await flushPromises()
    expect(wrapper!.text()).toContain(t('settings.p2p.pair.paired', { device: 'M4' }))
  })

  it('does not answer for the person when they only asked for it later', async () => {
    const mock = await mountPrompt()

    await buttons().find((b) => b.classes('pp-quiet'))!.trigger('click')
    await flushPromises()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(0)
    expect(mock.sent.some((s) => s.type === 'p2p.pair.confirm')).toBe(false)
  })
})
