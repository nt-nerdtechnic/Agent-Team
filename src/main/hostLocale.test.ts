import { describe, expect, it } from 'vitest'
import {
  HostLocaleManager,
  normalizeSystemLocale,
  readPersistedLocaleFromSettings,
  resolveInitialHostLocale,
  validateSupportedLocale,
} from './hostLocale'

describe('Host locale resolution', () => {
  it('validates only supported locales en-US and zh-TW', () => {
    expect(validateSupportedLocale('en-US')).toBe('en-US')
    expect(validateSupportedLocale('zh-TW')).toBe('zh-TW')
    expect(validateSupportedLocale('zh-CN')).toBeNull()
    expect(validateSupportedLocale('fr-FR')).toBeNull()
    expect(validateSupportedLocale('')).toBeNull()
    expect(validateSupportedLocale(null)).toBeNull()
    expect(validateSupportedLocale(123)).toBeNull()
  })

  it('normalizes system locale strings matching foundation and useSettings semantics', () => {
    expect(normalizeSystemLocale('zh-TW')).toBe('zh-TW')
    expect(normalizeSystemLocale('zh-HK')).toBe('zh-TW')
    expect(normalizeSystemLocale('zh-Hant-TW')).toBe('zh-TW')
    expect(normalizeSystemLocale('zh-CN')).toBe('zh-TW')
    expect(normalizeSystemLocale('zh')).toBe('zh-TW')

    expect(normalizeSystemLocale('en-US')).toBe('en-US')
    expect(normalizeSystemLocale('en-GB')).toBe('en-US')
    expect(normalizeSystemLocale('en')).toBe('en-US')

    // Unsupported system locales fall back to zh-TW
    expect(normalizeSystemLocale('ja-JP')).toBe('zh-TW')
    expect(normalizeSystemLocale('fr-FR')).toBe('zh-TW')
    expect(normalizeSystemLocale('')).toBe('zh-TW')
    expect(normalizeSystemLocale(null)).toBe('zh-TW')
    expect(normalizeSystemLocale(undefined)).toBe('zh-TW')
  })

  it('prioritizes valid persisted settings over system locale', () => {
    expect(resolveInitialHostLocale({
      persistedSetting: 'en-US',
      systemLocale: 'zh-TW',
    })).toBe('en-US')

    expect(resolveInitialHostLocale({
      persistedSetting: 'zh-TW',
      systemLocale: 'en-US',
    })).toBe('zh-TW')

    // Invalid or missing persisted setting falls back to system locale
    expect(resolveInitialHostLocale({
      persistedSetting: 'invalid',
      systemLocale: 'en-US',
    })).toBe('en-US')

    expect(resolveInitialHostLocale({
      persistedSetting: null,
      systemLocale: 'zh-TW',
    })).toBe('zh-TW')

    expect(resolveInitialHostLocale({
      persistedSetting: null,
      systemLocale: 'fr-FR',
    })).toBe('zh-TW')
  })

  it('HostLocaleManager caches validated runtime locale upon language IPC and ignores invalid', () => {
    let persistedValue: unknown = null
    let systemLocale = 'en-US'

    const manager = new HostLocaleManager(
      () => persistedValue,
      () => systemLocale,
    )

    // Initial read resolves system locale because persisted is null
    expect(manager.getLocale()).toBe('en-US')

    // Runtime update to zh-TW caches in-memory immediately
    const updated = manager.setRuntimeLocale('zh-TW')
    expect(updated).toBe('zh-TW')
    expect(manager.getLocale()).toBe('zh-TW')

    // Subsequent read ignores stale persisted value because runtimeLocale is active
    persistedValue = 'en-US'
    expect(manager.getLocale()).toBe('zh-TW')

    // Invalid runtime update is rejected and preserves previous valid runtime locale
    const rejected = manager.setRuntimeLocale('fr-FR')
    expect(rejected).toBeNull()
    expect(manager.getLocale()).toBe('zh-TW')

    // Valid update back to en-US
    expect(manager.setRuntimeLocale('en-US')).toBe('en-US')
    expect(manager.getLocale()).toBe('en-US')
  })

  it('reads raw and legacy JSON-encoded persisted locale from ui_settings map', () => {
    // Raw string settings
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': 'zh-TW' })).toBe('zh-TW')
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': 'en-US' })).toBe('en-US')

    // Legacy JSON-encoded string settings
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': '"zh-TW"' })).toBe('zh-TW')
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': '"en-US"' })).toBe('en-US')

    // Whitespace handling
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': '  zh-TW  ' })).toBe('zh-TW')
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': '  "en-US"  ' })).toBe('en-US')

    // Invalid, malformed, or missing settings
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': 'fr-FR' })).toBeNull()
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': '"fr-FR"' })).toBeNull()
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': '' })).toBeNull()
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': 123 })).toBeNull()
    expect(readPersistedLocaleFromSettings({})).toBeNull()
    expect(readPersistedLocaleFromSettings(null)).toBeNull()
    expect(readPersistedLocaleFromSettings(undefined)).toBeNull()
  })

  it('regression: raw persisted zh-TW setting wins over en-US system locale', () => {
    const rawSettings = { 'agent-team:language': 'zh-TW' }
    const persisted = readPersistedLocaleFromSettings(rawSettings)
    expect(persisted).toBe('zh-TW')

    const initialLocale = resolveInitialHostLocale({
      persistedSetting: persisted,
      systemLocale: 'en-US',
    })
    expect(initialLocale).toBe('zh-TW')

    const manager = new HostLocaleManager(
      () => readPersistedLocaleFromSettings(rawSettings),
      () => 'en-US',
    )
    expect(manager.getLocale()).toBe('zh-TW')
  })
})
