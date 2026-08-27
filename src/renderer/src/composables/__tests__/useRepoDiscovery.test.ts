// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { createMockBackend, withScope, flush } from './mockBackend'
import { useRepoDiscovery } from '../useRepoDiscovery'
import type { GitStatus } from '../useGit'

const EMPTY_STATUS: GitStatus = {
  is_git_repo: true,
  branch: '',
  remote_branch: '',
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  ignored: [],
  operation_in_progress: '',
}

function makeDiscoverResp(repos: { rel_path: string; abs_path: string; branch: string }[]) {
  return { ok: true, repositories: repos }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useRepoDiscovery', () => {
  it('returns empty list when workspace is empty string', async () => {
    const mock = createMockBackend('connected')
    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '', mock.backend),
    )
    await flush()
    expect(result.repositories.value).toEqual([])
    scope.stop()
  })

  it('fetches discovered repos and badge on init', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: '.', abs_path: '/ws', branch: 'main' },
      { rel_path: 'sub', abs_path: '/ws/sub', branch: 'dev' },
    ]))
    mock.setResponse('git.status', {
      ...EMPTY_STATUS,
      branch: 'main',
      staged: [{ path: 'a.ts', status: 'M' }],
    })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    await flush()

    expect(result.repositories.value).toHaveLength(2)
    expect(result.repositories.value[0].rel_path).toBe('.')
    expect(result.repositories.value[0].badge.dirtyCount).toBe(1)
    expect(result.repositories.value[0].badge.branch).toBe('main')
    scope.stop()
  })

  it('badge dirtyCount sums staged + unstaged + untracked', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', {
      ...EMPTY_STATUS,
      staged: [{ path: 'x', status: 'M' }],
      unstaged: [{ path: 'y', status: 'M' }],
      untracked: [{ path: 'z', status: '?' }, { path: 'w', status: '?' }],
    })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    await flush()

    expect(result.repositories.value[0].badge.dirtyCount).toBe(4)
    scope.stop()
  })

  it('refreshes on git.changed broadcast after debounce', async () => {
    vi.useFakeTimers()
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', { ...EMPTY_STATUS, branch: 'main' })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    // Flush the immediate watch trigger (async send chain).
    await vi.runAllTimersAsync()

    expect(result.repositories.value).toHaveLength(1)

    // Update preset to 2 repos, then emit git.changed.
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
      { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
    ]))
    mock.emit('git.changed', {})

    // Before debounce (400ms) fires, list unchanged.
    expect(result.repositories.value).toHaveLength(1)

    await vi.runAllTimersAsync()
    expect(result.repositories.value).toHaveLength(2)
    scope.stop()
  })

  it('ignores git.changed for an unrelated workspace_path', async () => {
    vi.useFakeTimers()
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', { ...EMPTY_STATUS, branch: 'main' })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    await vi.runAllTimersAsync()
    expect(result.repositories.value).toHaveLength(1)

    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
      { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
    ]))
    // '/ws2' shares the '/ws' string prefix but is NOT under '/ws/'.
    mock.emit('git.changed', { workspace_path: '/ws2' })
    await vi.runAllTimersAsync()

    // No refresh: repository list is unchanged.
    expect(result.repositories.value).toHaveLength(1)
    scope.stop()
  })

  it('refreshes on git.changed for the same workspace_path', async () => {
    vi.useFakeTimers()
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', { ...EMPTY_STATUS, branch: 'main' })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    await vi.runAllTimersAsync()
    expect(result.repositories.value).toHaveLength(1)

    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
      { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
    ]))
    mock.emit('git.changed', { workspace_path: '/ws' })
    await vi.runAllTimersAsync()

    expect(result.repositories.value).toHaveLength(2)
    scope.stop()
  })

  it('refreshes on git.changed for a path nested under the workspace', async () => {
    vi.useFakeTimers()
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', { ...EMPTY_STATUS, branch: 'main' })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    await vi.runAllTimersAsync()
    expect(result.repositories.value).toHaveLength(1)

    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
      { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
    ]))
    mock.emit('git.changed', { workspace_path: '/ws/a' })
    await vi.runAllTimersAsync()

    expect(result.repositories.value).toHaveLength(2)
    scope.stop()
  })

  it('refreshes on git.changed without workspace_path (backward compat)', async () => {
    vi.useFakeTimers()
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', { ...EMPTY_STATUS, branch: 'main' })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    await vi.runAllTimersAsync()
    expect(result.repositories.value).toHaveLength(1)

    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
      { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
    ]))
    mock.emit('git.changed', { some_other_field: true })
    await vi.runAllTimersAsync()

    expect(result.repositories.value).toHaveLength(2)
    scope.stop()
  })

  it('clears repositories when refresh is called with empty workspace', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', { ...EMPTY_STATUS })

    let ws = '/ws'
    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => ws, mock.backend),
    )
    await flush()
    expect(result.repositories.value).toHaveLength(1)

    ws = ''
    await result.refresh()
    expect(result.repositories.value).toHaveLength(0)
    scope.stop()
  })

  describe('cloud-synced workspaces (skipped discovery)', () => {
    function discoverCalls(mock: ReturnType<typeof createMockBackend>) {
      return mock.sent.filter((s) => s.type === 'git.discover_repositories')
    }

    it('leaves discoverySkipped false on a normal response', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('git.discover_repositories', makeDiscoverResp([
        { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
      ]))
      mock.setResponse('git.status', { ...EMPTY_STATUS })

      const { result, scope } = withScope(() =>
        useRepoDiscovery(() => '/ws', mock.backend),
      )
      await flush()

      expect(result.discoverySkipped.value).toBe(false)
      expect(discoverCalls(mock)[0].payload.force).toBe(false)
      scope.stop()
    })

    it('sets discoverySkipped and keeps the root-only list when the backend skips', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('git.discover_repositories', {
        ok: true,
        repositories: [{ rel_path: '.', abs_path: '/ws', branch: 'main' }],
        truncated: true,
        skipped: 'cloud_storage',
      })
      mock.setResponse('git.status', { ...EMPTY_STATUS, branch: 'main' })

      const { result, scope } = withScope(() =>
        useRepoDiscovery(() => '/ws', mock.backend),
      )
      await flush()

      expect(result.discoverySkipped.value).toBe(true)
      expect(result.repositories.value).toHaveLength(1)
      expect(result.repositories.value[0].rel_path).toBe('.')
      scope.stop()
    })

    it('sends force: true only for an explicit forced refresh, and clears the flag', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('git.discover_repositories', {
        ok: true,
        repositories: [],
        truncated: true,
        skipped: 'cloud_storage',
      })
      mock.setResponse('git.status', { ...EMPTY_STATUS })

      const { result, scope } = withScope(() =>
        useRepoDiscovery(() => '/ws', mock.backend),
      )
      await flush()
      expect(result.discoverySkipped.value).toBe(true)

      mock.setResponse('git.discover_repositories', makeDiscoverResp([
        { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
        { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
      ]))
      await result.refresh(true)

      const calls = discoverCalls(mock)
      expect(calls[0].payload.force).toBe(false)
      expect(calls[1].payload.force).toBe(true)
      expect(result.discoverySkipped.value).toBe(false)
      expect(result.repositories.value).toHaveLength(2)
      scope.stop()
    })

    it('does not force on git.changed re-discovery', async () => {
      vi.useFakeTimers()
      const mock = createMockBackend('connected')
      mock.setResponse('git.discover_repositories', {
        ok: true,
        repositories: [],
        truncated: true,
        skipped: 'cloud_storage',
      })
      mock.setResponse('git.status', { ...EMPTY_STATUS })

      const { result, scope } = withScope(() =>
        useRepoDiscovery(() => '/ws', mock.backend),
      )
      await vi.runAllTimersAsync()

      mock.emit('git.changed', { workspace_path: '/ws' })
      await vi.runAllTimersAsync()

      const calls = discoverCalls(mock)
      expect(calls.length).toBeGreaterThan(1)
      expect(calls.every((c) => c.payload.force === false)).toBe(true)
      expect(result.discoverySkipped.value).toBe(true)
      scope.stop()
    })

    it('adopt() takes over a forced result without walking the tree again', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('git.discover_repositories', {
        ok: true,
        repositories: [],
        truncated: true,
        skipped: 'cloud_storage',
      })
      mock.setResponse('git.status', { ...EMPTY_STATUS, branch: 'main' })

      const { result, scope } = withScope(() =>
        useRepoDiscovery(() => '/ws', mock.backend),
      )
      await flush()
      expect(result.discoverySkipped.value).toBe(true)
      const before = discoverCalls(mock).length

      // GitPane already paid for the walk and hands the result over.
      await result.adopt([
        { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
        { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
      ])

      expect(discoverCalls(mock)).toHaveLength(before)
      expect(result.repositories.value.map((r) => r.rel_path)).toEqual(['a', 'b'])
      expect(result.repositories.value[0].badge.branch).toBe('main')
      expect(result.discoverySkipped.value).toBe(false)
      scope.stop()
    })

    it('keeps an adopted list when a later automatic refresh comes back skipped', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('git.discover_repositories', {
        ok: true,
        repositories: [],
        truncated: true,
        skipped: 'cloud_storage',
      })
      mock.setResponse('git.status', { ...EMPTY_STATUS })

      const { result, scope } = withScope(() =>
        useRepoDiscovery(() => '/ws', mock.backend),
      )
      await flush()
      await result.adopt([{ rel_path: 'a', abs_path: '/ws/a', branch: 'main' }])
      expect(result.repositories.value).toHaveLength(1)

      // Automatic re-discovery: the backend skips again, but the list the user
      // paid a tree walk for must not be thrown away.
      await result.refresh()

      expect(result.repositories.value.map((r) => r.rel_path)).toEqual(['a'])
      expect(discoverCalls(mock).every((c) => c.payload.force === false)).toBe(true)
      scope.stop()
    })

    it('adopt() does not pin the list across a workspace switch', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('git.discover_repositories', {
        ok: true,
        repositories: [],
        truncated: true,
        skipped: 'cloud_storage',
      })
      mock.setResponse('git.status', { ...EMPTY_STATUS })

      const ws = ref('/ws')
      const { result, scope } = withScope(() =>
        useRepoDiscovery(() => ws.value, mock.backend),
      )
      await flush()
      await result.adopt([{ rel_path: 'a', abs_path: '/ws/a', branch: 'main' }])
      expect(result.repositories.value).toHaveLength(1)

      ws.value = '/ws2'
      await flush()

      // The new workspace gets its own (skipped) answer, not the old list.
      expect(result.repositories.value).toHaveLength(0)
      expect(result.discoverySkipped.value).toBe(true)
      expect(discoverCalls(mock).every((c) => c.payload.force === false)).toBe(true)
      scope.stop()
    })

    it('does not force on a workspace switch', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('git.discover_repositories', {
        ok: true,
        repositories: [],
        truncated: true,
        skipped: 'cloud_storage',
      })
      mock.setResponse('git.status', { ...EMPTY_STATUS })

      const ws = ref('/ws')
      const { scope } = withScope(() =>
        useRepoDiscovery(() => ws.value, mock.backend),
      )
      await flush()

      ws.value = '/ws2'
      await flush()

      const calls = discoverCalls(mock)
      expect(calls.length).toBe(2)
      expect(calls[1].payload.workspace_path).toBe('/ws2')
      expect(calls.every((c) => c.payload.force === false)).toBe(true)
      scope.stop()
    })
  })
})
