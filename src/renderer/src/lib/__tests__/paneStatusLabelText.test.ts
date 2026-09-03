// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

// The override source is mocked rather than driven through settings: what this
// file is about is the precedence rule and the locale split, not persistence
// (useStatusBadgePrefs.test.ts covers that).
const h = vi.hoisted(() => ({
  overrides: {} as Record<string, { zh?: string; en?: string }>,
}))

vi.mock('../../composables/useStatusBadgePrefs', () => ({
  statusBadgeLabelOverride: (status: string, locale: string) => {
    const entry = h.overrides[status]
    if (!entry) return ''
    return (locale.startsWith('zh') ? entry.zh : entry.en) ?? ''
  },
}))

import { i18n } from '@navide/plugin-ui/foundation'

import { paneStatusLabelKey, paneStatusLabelText } from '../paneStatusLabel'
import { PANE_STATUS_ORDER } from '../statusBadgePalette'

function withLocale<T>(locale: 'zh-TW' | 'en-US', fn: () => T): T {
  const prev = i18n.global.locale.value
  i18n.global.locale.value = locale
  try {
    return fn()
  } finally {
    i18n.global.locale.value = prev
  }
}

describe('paneStatusLabelText', () => {
  it('translates every status in both locales', () => {
    // A missing key would print `paneStatus.idle` on the badge — vue-i18n's
    // fallback is the key itself, which reads as a bug but throws nothing.
    for (const locale of ['zh-TW', 'en-US'] as const) {
      for (const status of PANE_STATUS_ORDER) {
        const key = paneStatusLabelKey(status)
        const text = withLocale(locale, () => paneStatusLabelText(status))
        expect(text, `${key} missing in ${locale}`).not.toBe(key)
        expect(text.trim(), `${key} blank in ${locale}`).not.toBe('')
      }
    }
  })

  it('prefers the user label over the translation, per locale', () => {
    h.overrides = { idle: { zh: '待命', en: 'Ready' } }
    expect(withLocale('zh-TW', () => paneStatusLabelText('idle'))).toBe('待命')
    expect(withLocale('en-US', () => paneStatusLabelText('idle'))).toBe('Ready')
    h.overrides = {}
  })

  it('falls back to the translation for a locale the user did not customize', () => {
    h.overrides = { idle: { zh: '待命' } }
    expect(withLocale('zh-TW', () => paneStatusLabelText('idle'))).toBe('待命')
    expect(withLocale('en-US', () => paneStatusLabelText('idle'))).toBe(
      i18n.global.t('paneStatus.idle', {}, { locale: 'en-US' })
    )
    h.overrides = {}
  })

  it('still keys off the shared key, so a rename reaches every surface', () => {
    expect(paneStatusLabelKey('awaiting')).toBe('paneStatus.awaiting')
  })
})
