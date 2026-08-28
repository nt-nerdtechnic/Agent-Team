// @vitest-environment happy-dom
import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { GitTransport } from '#git-feature'
import { useGit } from './useGit'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('useGit repository discovery ownership', () => {
  it('does not let an overlapping automatic skip replace an accepted force scan', async () => {
    const forced = deferred<unknown>()
    const automatic = deferred<unknown>()
    const workspace = ref('')
    let discoveryCalls = 0
    const transport = {
      status: ref('disconnected'),
      on: () => () => undefined,
      send: vi.fn((type: string) => {
        if (type !== 'git.discover_repositories') {
          return Promise.resolve({ ok: false, payload: null, error: null })
        }
        discoveryCalls += 1
        return discoveryCalls === 1 ? forced.promise : automatic.promise
      }),
    } as unknown as GitTransport
    const scope = effectScope()
    const git = scope.run(() => useGit(() => workspace.value, transport))!
    workspace.value = '/workspace'

    const forceRequest = git.discoverRepositories(true)
    const automaticRequest = git.discoverRepositories()
    forced.resolve({
      ok: true,
      payload: {
        ok: true,
        repositories: [{ rel_path: 'repo', abs_path: '/workspace/repo', branch: 'main' }],
      },
    })
    await forceRequest
    automatic.resolve({
      ok: true,
      payload: { ok: true, repositories: [], skipped: 'cloud_storage' },
    })
    await automaticRequest

    expect(git.discoveredRepos.value.map((repo) => repo.abs_path)).toEqual(['/workspace/repo'])
    expect(git.discoverySkipped.value).toBe(false)
    scope.stop()
  })
})
