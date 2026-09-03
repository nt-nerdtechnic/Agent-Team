import enUS from './locales/en-US.json'
import zhTW from './locales/zh-TW.json'

type MergeLocaleMessage = (locale: string, messages: Record<string, unknown>) => void

export function installPlansMessages(mergeLocaleMessage: MergeLocaleMessage): void {
  mergeLocaleMessage('en-US', enUS)
  mergeLocaleMessage('zh-TW', zhTW)
}
