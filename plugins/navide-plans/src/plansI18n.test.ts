import { createI18n } from 'vue-i18n'
import { describe, expect, it } from 'vitest'
import { installPlansMessages } from './plansI18n'

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
})
