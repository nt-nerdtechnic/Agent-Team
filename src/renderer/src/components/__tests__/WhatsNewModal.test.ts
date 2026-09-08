// @vitest-environment happy-dom
// The release announcement, and the celebratory chrome a major release gets.
//
// The spotlight panel is the thing worth pinning here. It is gated on `major`
// so the signal keeps its meaning, and a gate that silently stops gating looks
// exactly like a gate that works — every release would simply start arriving
// with a hero panel and nobody would file a bug about it.
//
// The modal renders through <Teleport to="body">, so nothing it draws is
// inside the wrapper's element. Asserting on the wrapper passes whatever the
// component does — the first draft of this file "proved" the gate that way,
// against a wrapper that was empty in every case. Every query below goes to
// document.body for that reason.
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import WhatsNewModal from '../WhatsNewModal.vue'
import { WHATS_NEW_CHROME, pickText, whatsNewFor, type WhatsNewEntry } from '../../lib/whatsNew'

const BASE: WhatsNewEntry = {
  version: '9.9.9',
  title: { 'zh-TW': '標題', 'en-US': 'Title' },
  highlights: [{ 'zh-TW': '一般更新', 'en-US': 'An ordinary change' }],
}

const SPOTLIGHT: NonNullable<WhatsNewEntry['spotlight']> = {
  name: 'Test Product',
  tagline: { 'zh-TW': '一句話', 'en-US': 'One line' },
  points: [{ 'zh-TW': '能力一', 'en-US': 'Capability one' }],
}

const chrome = (key: keyof typeof WHATS_NEW_CHROME): string =>
  pickText(WHATS_NEW_CHROME[key], i18n.global.locale.value)

let mounted: ReturnType<typeof mount> | null = null

/** Mount and hand back the teleported card, which is the only thing on screen. */
function render(entry: WhatsNewEntry): HTMLElement {
  mounted = mount(WhatsNewModal, { props: { entry }, global: { plugins: [i18n] } })
  const card = document.body.querySelector<HTMLElement>('.card')
  if (!card) throw new Error('the modal rendered nothing into document.body')
  return card
}

afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.replaceChildren()
})

describe('WhatsNewModal', () => {
  it('shows the ordinary header and no spotlight for a routine release', () => {
    const card = render(BASE)
    expect(card.classList.contains('major')).toBe(false)
    expect(card.querySelector('.spotlight')).toBeNull()
    expect(card.textContent).toContain(chrome('header'))
  })

  it('swaps the header wording and the chrome on a major release', () => {
    const card = render({ ...BASE, major: true })
    expect(card.classList.contains('major')).toBe(true)
    expect(card.textContent).toContain(chrome('majorHeader'))
    expect(card.textContent).not.toContain(chrome('header'))
  })

  it('draws the spotlight, its name and its points on a major release', () => {
    const card = render({ ...BASE, major: true, spotlight: SPOTLIGHT })
    expect(card.querySelector('.spotlight')).not.toBeNull()
    expect(card.querySelector('.sp-name')?.textContent).toBe('Test Product')
    expect(card.querySelectorAll('.sp-points li')).toHaveLength(1)
    // The bullet list keeps its own heading once something sits above it.
    expect(card.textContent).toContain(chrome('alsoIn'))
  })

  it('refuses a spotlight on a release that is not marked major', () => {
    // Without this the panel is available to every release, which is the one
    // way the "major" signal gets spent without anybody deciding to spend it.
    const card = render({ ...BASE, spotlight: SPOTLIGHT })
    expect(card.querySelector('.spotlight')).toBeNull()
    expect(card.textContent).not.toContain('Test Product')
    // Proves the query above can see content at all, so the two assertions are
    // reading an absent panel rather than an absent card.
    expect(card.textContent).toContain('An ordinary change')
  })

  it('keeps the bullet list unheaded when there is no spotlight', () => {
    const card = render({ ...BASE, major: true })
    expect(card.querySelector('.also-in')).toBeNull()
    expect(card.querySelectorAll('.highlights li')).toHaveLength(1)
  })
})

describe('the 0.2.0 announcement', () => {
  const entry = whatsNewFor('0.2.0')

  it('exists and is marked as the major release', () => {
    expect(entry).toBeDefined()
    expect(entry?.major).toBe(true)
  })

  it('introduces Navide Cloud in the spotlight', () => {
    expect(entry?.spotlight?.name).toBe('Navide Cloud')
    expect(entry?.spotlight?.points.length).toBeGreaterThanOrEqual(3)
  })

  it('carries both locales for every line it will show', () => {
    const texts = [
      entry!.title,
      ...entry!.highlights,
      entry!.note!,
      entry!.spotlight!.tagline,
      ...entry!.spotlight!.points,
    ]
    for (const text of texts) {
      expect(text['zh-TW'].length).toBeGreaterThan(0)
      expect(text['en-US'].length).toBeGreaterThan(0)
    }
  })

  it('tells somebody how to start, since the feature does nothing until they do', () => {
    // Navide Cloud is the first feature that is inert until the user signs in
    // on two machines. An announcement that only lists what it can do leaves
    // them with no first step.
    expect(entry?.note?.['zh-TW']).toContain('配對')
    expect(entry?.note?.['en-US']).toContain('Pair')
  })
})
