import { createI18n } from 'vue-i18n'
import zhTW from './locales/zh-TW.json'
import enUS from './locales/en-US.json'
import { settingsGet } from '../lib/settings'

const LANGUAGE_KEY = 'agent-team:language'

function getInitialLocale(): string {
  // Synchronous read from the bootstrap-seeded settings cache — available
  // before first paint, so the initial locale never flashes.
  const saved = settingsGet<string | null>(LANGUAGE_KEY, null)
  if (saved === 'zh-TW' || saved === 'en-US') return saved
  const browser = navigator.language
  if (/^zh-(TW|Hant|HK)/i.test(browser) || /^zh/i.test(browser)) return 'zh-TW'
  if (/^en/i.test(browser)) return 'en-US'
  return 'zh-TW'
}

export const i18n = createI18n({
  legacy: false,
  locale: getInitialLocale(),
  fallbackLocale: 'zh-TW',
  messages: {
    'zh-TW': zhTW,
    'en-US': enUS,
  },
})
