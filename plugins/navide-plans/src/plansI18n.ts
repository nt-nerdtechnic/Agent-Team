import enUS from './locales/en-US.json'
import zhTW from './locales/zh-TW.json'

export type SupportedPlansLocale = 'en-US' | 'zh-TW'
export const SUPPORTED_PLANS_LOCALES: readonly SupportedPlansLocale[] = ['en-US', 'zh-TW'] as const

type MergeLocaleMessage = (locale: string, messages: Record<string, unknown>) => void

export function installPlansMessages(mergeLocaleMessage: MergeLocaleMessage): void {
  mergeLocaleMessage('en-US', enUS)
  mergeLocaleMessage('zh-TW', zhTW)
}

export function resolvePlansLocale(value: unknown): SupportedPlansLocale {
  return value === 'zh-TW' || value === 'en-US' ? value : 'zh-TW'
}

export function parsePlansLocaleFromQuery(queryOrSearch: string): SupportedPlansLocale {
  const search = queryOrSearch.startsWith('?') ? queryOrSearch : `?${queryOrSearch}`
  const params = new URLSearchParams(search)
  return resolvePlansLocale(params.get('locale'))
}

export function extractLocaleFromSettingsEvent(payload: unknown): SupportedPlansLocale | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.source !== 'host') return null
  const settings = record.settings
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null
  const language = (settings as Record<string, unknown>)['agent-team:language']
  if (language === 'zh-TW' || language === 'en-US') {
    return language
  }
  return null
}

export interface PlansI18nTarget {
  global: {
    locale: { value: string } | string
    mergeLocaleMessage?: MergeLocaleMessage
  }
}

export function setPlansI18nLocale(i18nInstance: PlansI18nTarget, locale: SupportedPlansLocale): void {
  if (typeof i18nInstance.global.locale === 'object' && i18nInstance.global.locale !== null) {
    i18nInstance.global.locale.value = locale
  } else {
    (i18nInstance.global as unknown as { locale: string }).locale = locale
  }
}

export function bindPlansLocale(
  i18nInstance: PlansI18nTarget,
  subscribeEvent: (type: string, listener: (payload: unknown) => void) => () => void,
): () => void {
  return subscribeEvent('ui.settings_changed', (payload) => {
    const nextLocale = extractLocaleFromSettingsEvent(payload)
    if (nextLocale) {
      setPlansI18nLocale(i18nInstance, nextLocale)
    }
  })
}

export function bootstrapPlansI18n(
  i18nInstance: PlansI18nTarget,
  queryOrSearch: string,
): SupportedPlansLocale {
  if (typeof i18nInstance.global.mergeLocaleMessage === 'function') {
    installPlansMessages((locale, messages) => {
      i18nInstance.global.mergeLocaleMessage!(locale, messages)
    })
  }
  const locale = parsePlansLocaleFromQuery(queryOrSearch)
  setPlansI18nLocale(i18nInstance, locale)
  return locale
}
