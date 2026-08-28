// @vitest-environment happy-dom
import { effectScope } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { GitTransport } from '#git-feature'
import { useRepoDiscovery } from './useRepoDiscovery'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('useRepoDiscovery forced refresh ownership', () => {
  it('does not let a later skipped automatic refresh replace an accepted forced result', async () => {
    const forcedBadge = deferred<unknown>()
    const skippedBadge = deferred<unknown>()
    let discoverCall = 0
    let statusCall = 0
    const send = vi.fn(async (type: string) => {
      if (type === 'git.discover_repositories') {
        discoverCall += 1
        if (discoverCall === 1) {
          return { ok: true, payload: { ok: true, skipped: 'cloud_storage', repositories: [] } }
        }
        if (discoverCall === 2) {
          return {
            ok: true,
            payload: {
              ok: true,
              repositories: [{ rel_path: 'repo', abs_path: '/ws/repo', branch: 'main' }],
            },
          }
        }
        return {
          ok: true,
          payload: {
            ok: true,
            skipped: 'cloud_storage',
            repositories: [{ rel_path: '.', abs_path: '/ws', branch: 'main' }],
          },
        }
      }
      statusCall += 1
      return statusCall === 1 ? forcedBadge.promise : skippedBadge.promise
    })
    const transport = { send, on: () => () => undefined } as unknown as GitTransport
    const scope = effectScope()
    const discovery = scope.run(() => useRepoDiscovery(() => '/ws', transport))!
    await flush()

    const forced = discovery.refresh(true)
    await flush()
    expect(statusCall).toBe(1)
    const automatic = discovery.refresh()
    await flush()

    forcedBadge.resolve({
      ok: true,
      payload: { branch: 'main', staged: [], unstaged: [], untracked: [] },
    })
    await forced
    skippedBadge.resolve({
      ok: true,
      payload: { branch: 'main', staged: [], unstaged: [], untracked: [] },
    })
    await automatic

    expect(discovery.repositories.value.map((repo) => repo.abs_path)).toEqual(['/ws/repo'])
    expect(discovery.discoverySkipped.value).toBe(false)
    scope.stop()
  })
})
