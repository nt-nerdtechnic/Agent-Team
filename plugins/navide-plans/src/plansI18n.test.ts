import { createI18n } from 'vue-i18n'
import { describe, expect, it, vi } from 'vitest'
import {
  installPlansMessages,
  parsePlansLocaleFromQuery,
  extractLocaleFromSettingsEvent,
  bindPlansLocale,
  bootstrapPlansI18n,
} from './plansI18n'
import enUS from './locales/en-US.json'
import zhTW from './locales/zh-TW.json'

function collectLeafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...collectLeafKeys(value as Record<string, unknown>, fullKey))
    } else {
      keys.push(fullKey)
    }
  }
  return keys
}

describe('Plans i18n bootstrap', () => {
  it('adds package-owned messages without replacing shared messages', () => {
    const i18n = createI18n({
      legacy: false,
      locale: 'en-US',
      fallbackLocale: 'zh-TW',
      messages: {
        'en-US': {
          action: { cancel: 'Cancel' },
          'ai-cli': { start: 'Start' },
          pane: { git: { title: 'SOURCE CONTROL' } },
        },
        'zh-TW': {
          action: { cancel: '取消' },
          'ai-cli': { start: '啟動' },
          pane: { git: { title: '原始碼控制' } },
        },
      },
    })

    installPlansMessages((locale, messages) => {
      i18n.global.mergeLocaleMessage(locale, messages)
    })

    expect(i18n.global.t('pane.plans.title')).toBe('Plans')
    expect(i18n.global.t('pane.git.title')).toBe('SOURCE CONTROL')
    expect(i18n.global.t('action.cancel')).toBe('Cancel')
    expect(i18n.global.t('ai-cli.start')).toBe('Start')
    i18n.global.locale.value = 'zh-TW'
    expect(i18n.global.t('pane.plans.title')).toBe('計畫')
    expect(i18n.global.t('pane.git.title')).toBe('原始碼控制')
    expect(i18n.global.t('action.cancel')).toBe('取消')
    expect(i18n.global.t('ai-cli.start')).toBe('啟動')
  })

  it('bootstraps locale from query before mount without reading localStorage', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    let localStorageGetterAccessed = false
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        localStorageGetterAccessed = true
        throw new Error('localStorage must not be accessed during bootstrap')
      },
    })

    try {
      const i18n = createI18n({
        legacy: false,
        locale: 'en-US',
        fallbackLocale: 'zh-TW',
        messages: { 'en-US': {}, 'zh-TW': {} },
      })

      // Query contains zh-TW -> initial locale set to zh-TW
      const bootstrapZh = bootstrapPlansI18n(i18n, '?workspace_path=%2Fworkspace&locale=zh-TW&contribution=left')
      expect(bootstrapZh).toBe('zh-TW')
      expect(i18n.global.locale.value).toBe('zh-TW')

      // Query contains en-US -> initial locale set to en-US
      const bootstrapEn = bootstrapPlansI18n(i18n, '?workspace_path=%2Fworkspace&locale=en-US&contribution=window')
      expect(bootstrapEn).toBe('en-US')
      expect(i18n.global.locale.value).toBe('en-US')

      // Invalid or missing query fails closed to zh-TW
      expect(parsePlansLocaleFromQuery('?workspace_path=%2Fworkspace&locale=fr-FR')).toBe('zh-TW')
      expect(parsePlansLocaleFromQuery('?workspace_path=%2Fworkspace')).toBe('zh-TW')
      expect(parsePlansLocaleFromQuery('')).toBe('zh-TW')

      expect(localStorageGetterAccessed).toBe(false)
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
      } else {
        // @ts-expect-error cleanup injected property
        delete globalThis.localStorage
      }
    }
  })

  it('switches mounted contribution locale in response to Host-owned ui.settings_changed event', () => {
    const i18n = createI18n({
      legacy: false,
      locale: 'en-US',
      fallbackLocale: 'zh-TW',
      messages: { 'en-US': {}, 'zh-TW': {} },
    })

    let listener: ((payload: unknown) => void) | null = null
    const unsubscribe = vi.fn()
    const subscribeMock = vi.fn((event: string, cb: (payload: unknown) => void) => {
      expect(event).toBe('ui.settings_changed')
      listener = cb
      return unsubscribe
    })

    const dispose = bindPlansLocale(i18n, subscribeMock)
    expect(subscribeMock).toHaveBeenCalledWith('ui.settings_changed', expect.any(Function))
    expect(listener).not.toBeNull()

    // Host broadcast switches locale to zh-TW
    listener!({
      source: 'host',
      settings: {
        'agent-team:language': 'zh-TW',
      },
    })
    expect(i18n.global.locale.value).toBe('zh-TW')

    // Host broadcast switches locale back to en-US
    listener!({
      source: 'host',
      settings: {
        'agent-team:language': 'en-US',
      },
    })
    expect(i18n.global.locale.value).toBe('en-US')

    // Non-Host source is ignored
    listener!({
      source: 'plugin-storage',
      settings: {
        'agent-team:language': 'zh-TW',
      },
    })
    expect(i18n.global.locale.value).toBe('en-US')

    // Missing source is ignored
    listener!({
      settings: {
        'agent-team:language': 'zh-TW',
      },
    })
    expect(i18n.global.locale.value).toBe('en-US')

    // Invalid locale value is ignored
    listener!({
      source: 'host',
      settings: {
        'agent-team:language': 'invalid-locale',
      },
    })
    expect(i18n.global.locale.value).toBe('en-US')

    // Dispose cleans up listener
    dispose()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('extracts locale safely from Host-owned settings event', () => {
    expect(extractLocaleFromSettingsEvent({
      source: 'host',
      settings: { 'agent-team:language': 'zh-TW' },
    })).toBe('zh-TW')

    expect(extractLocaleFromSettingsEvent({
      source: 'host',
      settings: { 'agent-team:language': 'en-US' },
    })).toBe('en-US')

    expect(extractLocaleFromSettingsEvent({
      source: 'plugin-storage',
      settings: { 'agent-team:language': 'zh-TW' },
    })).toBeNull()

    expect(extractLocaleFromSettingsEvent({
      settings: { 'agent-team:language': 'zh-TW' },
    })).toBeNull()

    expect(extractLocaleFromSettingsEvent({
      source: 'host',
      settings: { 'agent-team:language': 'ja-JP' },
    })).toBeNull()

    expect(extractLocaleFromSettingsEvent(null)).toBeNull()
    expect(extractLocaleFromSettingsEvent({})).toBeNull()
    expect(extractLocaleFromSettingsEvent({ source: 'host', settings: null })).toBeNull()
  })

  it('preserves translation key parity between en-US and zh-TW', () => {
    const enKeys = collectLeafKeys(enUS).sort()
    const zhKeys = collectLeafKeys(zhTW).sort()

    expect(enKeys).toEqual(zhKeys)
    expect(enKeys.length).toBeGreaterThan(0)
  })
})
