// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettings } from '../useSettings'
import { settingsGet, settingsReadiness } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'

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
