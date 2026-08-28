// @vitest-environment happy-dom
import { effectScope, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { SettingsBackend } from '@navide/plugin-ui/shared'
import type { GitTransport } from '#git-feature'

const originalUrl = window.location.href

describe('useGitPreferences', () => {
  afterEach(() => {
    window.history.replaceState({}, '', originalUrl)
    vi.resetModules()
    vi.useRealTimers()
  })

  it('applies all persisted preferences after a delayed snapshot without writing defaults', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/?v2=1')
    vi.resetModules()
    const settings = await import('@navide/plugin-ui/shared')
    const { useGitPreferences } = await import('./useGitPreferences')
    const status = ref<SettingsBackend['status']['value']>('disconnected')
    let resolveSnapshot!: (value: Record<string, unknown>) => void
    const getAll = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      resolveSnapshot = resolve
    }))
    const setMany = vi.fn(async () => undefined)
    const backend: SettingsBackend = {
      status,
      ownedKeys: [
        'agentTeam.git.logScope',
        'agentTeam.git.logOrder',
        'agentTeam.git.autoCommit',
        'agentTeam.gitTopRatio',
      ],
      getAll,
      setMany,
      onChanged: () => () => undefined,
    }

    settings.initSettingsBackend(backend)
    const scope = effectScope()
    const onExternalLogChange = vi.fn()
    const preferences = scope.run(() => useGitPreferences(onExternalLogChange))!

    expect(preferences.logScope.value).toBe('all')
    expect(preferences.logOrder.value).toBe('ancestor')
    expect(preferences.autoCommit.value).toBe(false)
    expect(preferences.gitTopRatio.value).toBe(0.5)

    status.value = 'connected'
    await nextTick()
    expect(getAll).toHaveBeenCalledOnce()

    resolveSnapshot({
      'agentTeam.git.logScope': 'current',
      'agentTeam.git.logOrder': 'date',
      'agentTeam.git.autoCommit': 'true',
      'agentTeam.gitTopRatio': '0.72',
    })
    await settings.settingsReady()
    await vi.advanceTimersByTimeAsync(500)

    expect(preferences.logScope.value).toBe('current')
    expect(preferences.logOrder.value).toBe('date')
    expect(preferences.autoCommit.value).toBe(true)
    expect(preferences.gitTopRatio.value).toBe(0.72)
    expect(onExternalLogChange).toHaveBeenCalledOnce()
    expect(setMany).not.toHaveBeenCalled()

    preferences.setGitTopRatio(0.64)
    await vi.advanceTimersByTimeAsync(500)
    expect(setMany).toHaveBeenCalledWith({ 'agentTeam.gitTopRatio': '0.64' })

    preferences.setAutoCommit(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(setMany).toHaveBeenCalledWith({ 'agentTeam.git.autoCommit': 'false' })

    scope.stop()
  })

  it('reloads history after the authoritative log preferences arrive', async () => {
    window.history.replaceState({}, '', '/?v2=1')
    vi.resetModules()
    const settings = await import('@navide/plugin-ui/shared')
    const { useGit } = await import('./useGit')
    const settingsStatus = ref<SettingsBackend['status']['value']>('disconnected')
    let resolveSnapshot!: (value: Record<string, unknown>) => void
    const settingsBackend: SettingsBackend = {
      status: settingsStatus,
      ownedKeys: ['agentTeam.git.logScope', 'agentTeam.git.logOrder'],
      getAll: vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
        resolveSnapshot = resolve
      })),
      setMany: vi.fn(async () => undefined),
      onChanged: () => () => undefined,
    }
    settings.initSettingsBackend(settingsBackend)

    const transportStatus = ref<GitTransport['status']['value']>('connected')
    const send = vi.fn(async (type: string) => {
      if (type === 'git.log') {
        return { ok: true, payload: { commits: [] }, error: null }
      }
      return { ok: true, payload: null, error: null }
    })
    const transport = {
      status: transportStatus,
      send,
      on: () => () => undefined,
    } as unknown as GitTransport
    const scope = effectScope()
    const git = scope.run(() => useGit(() => '/workspace', transport))!
    await flushPromises()

    settingsStatus.value = 'connected'
    await nextTick()
    resolveSnapshot({
      'agentTeam.git.logScope': 'current',
      'agentTeam.git.logOrder': 'date',
    })
    await settings.settingsReady()
    await flushPromises()

    expect(git.logScope.value).toBe('current')
    expect(git.logOrder.value).toBe('date')
    expect(send).toHaveBeenCalledWith('git.log', {
      workspace_path: '/workspace',
      n: 50,
      all: false,
      order: 'date',
    })

    scope.stop()
  })
})
