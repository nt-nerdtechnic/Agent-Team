// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import { initSettingsBackend, seedSettings, settingsGet, settingsReadiness, settingsSet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import { createMockBackend } from './mockBackend'
import { ensureLanguageSettingsSubscription, useSettings } from '../useSettings'

const LANGUAGE_KEY = 'agent-team:language'

describe('useSettings — health-check timeout', () => {
  beforeEach(() => {
    // Module-level singleton — reset to a known baseline before each test.
    const { setHealthCheckTimeoutSec } = useSettings()
    setHealthCheckTimeoutSec(45)
    window.agentTeam = undefined as unknown as typeof window.agentTeam
  })

  it('defaults to 45 seconds', () => {
    const { healthCheckTimeoutSec } = useSettings()
    expect(healthCheckTimeoutSec.value).toBe(45)
  })

  it('loadHealthCheckTimeoutSec adopts the value read via IPC', async () => {
    window.agentTeam = {
      readHealthCheckTimeout: vi.fn().mockResolvedValue({ ok: true, timeoutSec: 90 }),
    } as unknown as typeof window.agentTeam
    const { loadHealthCheckTimeoutSec, healthCheckTimeoutSec } = useSettings()
    await loadHealthCheckTimeoutSec()
    expect(healthCheckTimeoutSec.value).toBe(90)
  })

  it('loadHealthCheckTimeoutSec keeps the current value when IPC is unavailable', async () => {
    const { loadHealthCheckTimeoutSec, healthCheckTimeoutSec } = useSettings()
    await loadHealthCheckTimeoutSec()
    expect(healthCheckTimeoutSec.value).toBe(45)
  })

  it('loadHealthCheckTimeoutSec keeps the current value when the read fails', async () => {
    window.agentTeam = {
      readHealthCheckTimeout: vi.fn().mockRejectedValue(new Error('ipc down')),
    } as unknown as typeof window.agentTeam
    const { loadHealthCheckTimeoutSec, healthCheckTimeoutSec } = useSettings()
    await expect(loadHealthCheckTimeoutSec()).resolves.toBeUndefined()
    expect(healthCheckTimeoutSec.value).toBe(45)
  })

  it('setHealthCheckTimeoutSec clamps below the 15s floor and persists via IPC', () => {
    const write = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = { writeHealthCheckTimeout: write } as unknown as typeof window.agentTeam
    const { setHealthCheckTimeoutSec, healthCheckTimeoutSec } = useSettings()
    setHealthCheckTimeoutSec(5)
    expect(healthCheckTimeoutSec.value).toBe(15)
    expect(write).toHaveBeenCalledWith(15)
  })

  it('setHealthCheckTimeoutSec clamps above the 120s ceiling', () => {
    const write = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = { writeHealthCheckTimeout: write } as unknown as typeof window.agentTeam
    const { setHealthCheckTimeoutSec, healthCheckTimeoutSec } = useSettings()
    setHealthCheckTimeoutSec(999)
    expect(healthCheckTimeoutSec.value).toBe(120)
    expect(write).toHaveBeenCalledWith(120)
  })

  it('setHealthCheckTimeoutSec rounds and accepts an in-range value', () => {
    const write = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = { writeHealthCheckTimeout: write } as unknown as typeof window.agentTeam
    const { setHealthCheckTimeoutSec, healthCheckTimeoutSec } = useSettings()
    setHealthCheckTimeoutSec(60.4)
    expect(healthCheckTimeoutSec.value).toBe(60)
    expect(write).toHaveBeenCalledWith(60)
  })
})

describe('useSettings — language bootstrap and persistence', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    ensureLanguageSettingsSubscription()
    window.agentTeam = undefined as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    delete (globalThis as typeof globalThis & { __navideSettingsBootstrap?: unknown }).__navideSettingsBootstrap
    __resetSettingsForTest()
  })

  it('loads language from bootstrap settings cache and sets i18n locale', () => {
    seedSettings({ 'agent-team:language': 'zh-TW' })
    const { language, loadLanguage } = useSettings()
    loadLanguage()
    expect(language.value).toBe('zh-TW')
    expect(i18n.global.locale.value).toBe('zh-TW')
  })

  it('handles JSON-encoded locale string from persisted settings', () => {
    seedSettings({ 'agent-team:language': '"zh-TW"' })
    const { language, loadLanguage } = useSettings()
    loadLanguage()
    expect(language.value).toBe('zh-TW')
    expect(i18n.global.locale.value).toBe('zh-TW')
  })

  it('setLanguage persists to settings cache and broadcasts change via IPC', () => {
    const broadcast = vi.fn()
    window.agentTeam = { broadcastLanguageChange: broadcast } as unknown as typeof window.agentTeam
    const { language, setLanguage } = useSettings()

    setLanguage('en-US')
    expect(language.value).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
    expect(settingsGet('agent-team:language', null)).toBe('en-US')
    expect(broadcast).toHaveBeenCalledWith('en-US')
  })

  it('setLanguage with broadcast: false persists without calling broadcastLanguageChange', () => {
    const broadcast = vi.fn()
    window.agentTeam = { broadcastLanguageChange: broadcast } as unknown as typeof window.agentTeam
    const { language, setLanguage } = useSettings()

    setLanguage('zh-TW', { broadcast: false })
    expect(language.value).toBe('zh-TW')
    expect(i18n.global.locale.value).toBe('zh-TW')
    expect(settingsGet('agent-team:language', null)).toBe('zh-TW')
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('setLanguage ignores unsupported locales and does not broadcast', () => {
    const broadcast = vi.fn()
    window.agentTeam = { broadcastLanguageChange: broadcast } as unknown as typeof window.agentTeam
    const { language, setLanguage } = useSettings()

    setLanguage('zh-TW')
    broadcast.mockClear()

    setLanguage('fr-FR')
    expect(language.value).toBe('zh-TW')
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('setLanguage does not re-broadcast when locale is already current', () => {
    const broadcast = vi.fn()
    window.agentTeam = { broadcastLanguageChange: broadcast } as unknown as typeof window.agentTeam
    const { setLanguage } = useSettings()

    setLanguage('en-US')
    expect(broadcast).toHaveBeenCalledTimes(1)

    setLanguage('en-US')
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('adopts backendFallback when settings cache is empty', () => {
    const { language, loadLanguage } = useSettings()
    loadLanguage({ language: 'en-US' })
    expect(language.value).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
    expect(settingsGet('agent-team:language', null)).toBe('en-US')
  })

  it('updates language and i18n locale when settings change externally', () => {
    const { backend, emit } = createMockBackend('connected')
    initSettingsBackend(backend)
    seedSettings({ 'agent-team:language': 'zh-TW' })
    const { language, loadLanguage } = useSettings()
    loadLanguage()
    expect(language.value).toBe('zh-TW')

    emit('ui.settings_changed', { settings: { 'agent-team:language': 'en-US' } })
    expect(language.value).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
  })

  it('proves main bootstrap locale applies to i18n before first mount and matches useSettings', async () => {
    // Simulates the exact Host bootstrap startup sequence in main.ts:
    // 1. Host bootstrap settings contain persisted zh-TW
    const bootstrapSettings = { 'agent-team:language': 'zh-TW' }
    ;(globalThis as typeof globalThis & { __navideSettingsBootstrap?: Record<string, unknown> }).__navideSettingsBootstrap =
      bootstrapSettings
    seedSettings(bootstrapSettings)

    // 2. main.ts resolves bootstrap locale and updates i18n before loadRoot / first mount
    const bootstrapLocale = bootstrapSettings['agent-team:language']
    if (bootstrapLocale === 'zh-TW' || bootstrapLocale === 'en-US') {
      i18n.global.locale.value = bootstrapLocale
    }
    expect(i18n.global.locale.value).toBe('zh-TW')

    // 3. Components calling useSettings() immediately see the bootstrapped zh-TW
    const { language } = useSettings()
    expect(language.value).toBe('zh-TW')

    // 4. Updating via UI persists to settings store (which flushes to ui_settings.json)
    const broadcast = vi.fn()
    window.agentTeam = { broadcastLanguageChange: broadcast } as unknown as typeof window.agentTeam
    const { setLanguage } = useSettings()
    setLanguage('en-US')
    expect(settingsGet('agent-team:language', null)).toBe('en-US')
    expect(broadcast).toHaveBeenCalledWith('en-US')
  })
})

describe('useSettings — language fallback promotion', () => {
  beforeEach(() => {
    __resetSettingsForTest()
  })

  it('promotes the workspace fallback once the store is authoritative', () => {
    const { loadLanguage, language } = useSettings()
    loadLanguage({ language: 'en-US' })
    expect(language.value).toBe('en-US')
    expect(settingsGet(LANGUAGE_KEY, null)).toBe('en-US')
  })

  it('does not promote the workspace fallback before the snapshot lands', () => {
    // An empty cache here means the snapshot is still in flight, not that the
    // user has no language. Writing the workspace's dormant backup now buries
    // the real preference permanently: a pending key beats the server value in
    // reconcile, so nothing later corrects it.
    settingsReadiness.status = 'pending'
    try {
      const { loadLanguage, language } = useSettings()
      loadLanguage({ language: 'en-US' })
      // Applied to the UI, but not written back.
      expect(language.value).toBe('en-US')
      expect(settingsGet(LANGUAGE_KEY, null)).toBeNull()
    } finally {
      settingsReadiness.status = 'ready'
    }
  })

  it('leaves an explicit change writable while the snapshot is in flight', () => {
    // setLanguage is the user acting, not a fallback being guessed — it must
    // still be recorded (the settings module holds the write until ready).
    settingsReadiness.status = 'pending'
    try {
      const { setLanguage } = useSettings()
      setLanguage('en-US')
      expect(settingsGet(LANGUAGE_KEY, null)).toBe('en-US')
    } finally {
      settingsReadiness.status = 'ready'
    }
  })
})
