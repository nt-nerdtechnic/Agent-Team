// The prompt that appears when a machine asks to pair.
//
// Source-scan, like the other two connection surfaces in this directory (they
// need six composable APIs as props to mount). Where that is not enough to
// prove a behaviour, the behaviour lives in a pure module with its own test —
// here that is usePairingState.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

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
    expect(PROMPT).toContain('answer(row, true)')
    expect(PROMPT).toContain('answer(row, false)')
    // "Later" hides the prompt; the card in the account window keeps it until
    // it expires, so it decides nothing and is sent nowhere.
    expect(PROMPT).toMatch(/function later\([\s\S]{0,120}state\.dismiss\(row\)/)
    expect(PROMPT).not.toMatch(/function later\([\s\S]{0,200}backend\.send/)
  })

  it('carries a confirmation token for both answers', () => {
    expect(PROMPT).toContain("trustConfirm('p2p.pair.confirm', row.deviceId)")
  })

  it('sits above the content and below anything modal', () => {
    // It must not cover a dialog somebody is already answering, and it must not
    // invent a stacking level.
    expect(PROMPT).toContain('z-index: var(--z-popover)')
    expect(PROMPT).toContain('position: fixed')
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
