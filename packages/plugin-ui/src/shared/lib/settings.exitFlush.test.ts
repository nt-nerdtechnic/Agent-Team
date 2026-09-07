// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// Exit paths (beforeunload, and the quit sequence's 'saving' stage) have no
// async turn to await a flush in. These cover the write actually leaving the
// module — the debounce is what used to swallow it.

async function harness() {
  vi.resetModules()
  const settings = await import('./settings')
  const status = ref<'connected' | 'disconnected'>('connected')
  const setMany = vi.fn(async () => undefined)
  settings.initSettingsBackend({
    status,
    getAll: vi.fn(async () => ({})),
    setMany,
    onChanged: () => () => undefined,
  })
  await settings.settingsReady()
  // The module queues its own legacy-migration flag at import time. Drain it so
  // the assertions below see only what each test wrote.
  settings.flushSettingsOnExit()
  await vi.advanceTimersByTimeAsync(0)
  setMany.mockClear()
  return { settings, setMany, status }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
})

describe('flushSettingsOnExit', () => {
  it('sends a write that the debounce is still holding', async () => {
    const { settings, setMany } = await harness()

    settings.settingsSet('agentTeam.confirmClose', '0')
    // The bug: at this point the value exists only in the pending map. An exit
    // here (quit, reload) used to lose it.
    expect(setMany).not.toHaveBeenCalled()

    settings.flushSettingsOnExit()
    expect(setMany).toHaveBeenCalledWith({ 'agentTeam.confirmClose': '0' })
  })

  it('does not send the batch twice when the debounce timer would have fired', async () => {
    const { settings, setMany } = await harness()

    settings.settingsSet('agentTeam.confirmClose', '0')
    settings.flushSettingsOnExit()
    expect(setMany).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(settings.SETTINGS_FLUSH_DEBOUNCE_MS * 2)
    expect(setMany).toHaveBeenCalledTimes(1)
  })

  it('sends every key queued before the exit, not just the last one', async () => {
    const { settings, setMany } = await harness()

    settings.settingsSet('agentTeam.confirmClose', '0')
    settings.settingsSet('agentTeam.idleReclaimMinutes', '180')
    settings.settingsRemove('agentTeam.yolo')
    settings.flushSettingsOnExit()

    expect(setMany).toHaveBeenCalledWith({
      'agentTeam.confirmClose': '0',
      'agentTeam.idleReclaimMinutes': '180',
      'agentTeam.yolo': null,
    })
  })

  it('is a no-op with nothing queued', async () => {
    const { settings, setMany } = await harness()

    settings.flushSettingsOnExit()
    expect(setMany).not.toHaveBeenCalled()
  })

  it('keeps the write queued when the socket is already down', async () => {
    const { settings, setMany, status } = await harness()
    status.value = 'disconnected'

    settings.settingsSet('agentTeam.confirmClose', '0')
    settings.flushSettingsOnExit()
    // Nothing to send it over — but the value must not be dropped either, so a
    // reconnect still drains it.
    expect(setMany).not.toHaveBeenCalled()
    expect(settings.settingsGet('agentTeam.confirmClose', 'missing')).toBe('0')
  })
})
