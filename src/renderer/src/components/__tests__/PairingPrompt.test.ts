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

describe('both ends confirm, and the card says whose turn it is', () => {
  const CARD = MODAL.slice(
    MODAL.indexOf('settings.p2p.pair.title'),
    MODAL.indexOf('settings.p2p.trust.needs-you'),
  )

  it('offers the same two answers whichever end you are', () => {
    // The initiator used to have only "Cancel request" here, on the reasoning
    // that comparing digits is one act by one person at two screens. That holds
    // only when there is another machine and another person: a relay can answer
    // with its own key without forwarding anything, and this side would pin it
    // having compared nothing. The digits cannot be the check either — a relay
    // knows them — so the button is the only place the property lives.
    expect(CARD).not.toMatch(/v-if="row\.role === 'initiator'"/)
    expect(CARD).toContain('settings.p2p.pair.match')
    expect(CARD).toContain('settings.p2p.pair.mismatch')
    expect(CARD).toContain('answerPairing(row, true)')
    // And the branch that shows them is reached by role and state alike: the
    // only thing gating it is whether this side has already answered.
    expect(CARD).toMatch(/v-if="row\.state === 'awaiting-remote'"/)
  })

  it('says the wait is on the person, not on the other machine', () => {
    // The heading still reads "waiting for them" from before they answered.
    // Left as the only status, somebody would wait for a machine that is
    // waiting for them.
    expect(CARD).toMatch(/pair\.step-your-turn[\s\S]{0,200}pair\.your-turn/)
    expect(CARD).toMatch(/pair\.your-turn[\s\S]{0,400}answerPairing\(row, true\)/)
  })

  for (const locale of LOCALES) {
    it(`never calls an unconfirmed exchange paired in ${locale}`, () => {
      const pair = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.pair
      for (const key of ['your-turn', 'step-your-turn', 'waiting-remote']) {
        expect(pair[key]).toBeTruthy()
        expect(pair[key]).not.toMatch(/Paired|已配對/)
      }
    })
  }
})
