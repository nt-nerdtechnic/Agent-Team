export type SupportedLocale = 'zh-TW' | 'en-US'
export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['zh-TW', 'en-US'] as const

export function normalizeSystemLocale(rawLocale: string | null | undefined): SupportedLocale {
  if (!rawLocale || typeof rawLocale !== 'string') return 'zh-TW'
  const normalized = rawLocale.trim()
  if (/^zh-(TW|Hant|HK)/i.test(normalized) || /^zh/i.test(normalized)) return 'zh-TW'
  if (/^en/i.test(normalized)) return 'en-US'
  return 'zh-TW'
}

export function validateSupportedLocale(value: unknown): SupportedLocale | null {
  return value === 'zh-TW' || value === 'en-US' ? value : null
}

export function readPersistedLocaleFromSettings(
  settings: Record<string, unknown> | null | undefined,
): SupportedLocale | null {
  if (!settings || typeof settings !== 'object') return null
  const raw = settings['agent-team:language']
  if (typeof raw !== 'string') return null
  const candidate = raw.trim()
  const validated = validateSupportedLocale(candidate)
  if (validated) return validated
  try {
    const decoded = JSON.parse(candidate)
    return validateSupportedLocale(decoded)
  } catch {
    return null
  }
}

export interface ResolveInitialHostLocaleInputs {
  persistedSetting?: unknown
  systemLocale?: string | null
}

export function resolveInitialHostLocale(inputs: ResolveInitialHostLocaleInputs): SupportedLocale {
  const persisted = validateSupportedLocale(inputs.persistedSetting)
  if (persisted) return persisted
  return normalizeSystemLocale(inputs.systemLocale)
}

export class HostLocaleManager {
  private runtimeLocale: SupportedLocale | null = null

  constructor(
    private readonly readPersistedLocale: () => unknown,
    private readonly getSystemLocale: () => string | null | undefined,
  ) {}

  getLocale(): SupportedLocale {
    if (this.runtimeLocale) return this.runtimeLocale
    return resolveInitialHostLocale({
      persistedSetting: this.readPersistedLocale(),
      systemLocale: this.getSystemLocale(),
    })
  }

  setRuntimeLocale(locale: unknown): SupportedLocale | null {
    const validated = validateSupportedLocale(locale)
    if (validated) {
      this.runtimeLocale = validated
      return validated
    }
    return null
  }
}
