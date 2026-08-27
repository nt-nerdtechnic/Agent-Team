import { ref, watch, onScopeDispose } from 'vue'
import type { DiscoveredRepo, DiscoverReposResponse, GitStatus } from './useGit'
import type { GitTransport } from '../../../shared/gitCompatibility'

export interface RepoBadge {
  branch: string
  dirtyCount: number
}

export interface DiscoveredRepoWithBadge extends DiscoveredRepo {
  badge: RepoBadge
}

export function useRepoDiscovery(
  workspacePath: () => string,
  transport: GitTransport,
) {
  const { send, on } = transport
  const repositories = ref<DiscoveredRepoWithBadge[]>([])
  // True when the backend skipped the downward scan because the workspace lives
  // on a cloud-synced folder (walking it can block for minutes). Only a user
  // triggered forced scan clears it — nothing retries automatically.
  const discoverySkipped = ref(false)
  // Workspace the user has already paid a forced walk for (via refresh(true) or
  // a result adopted from a child pane). While it matches the current
  // workspace, an automatic refresh that comes back skipped keeps the list the
  // user opted into instead of collapsing it back to the root-only stub.
  let forcedWorkspace = ''

  // Fetch a lightweight status badge for each repo in parallel.
  async function withBadges(
    discovered: DiscoveredRepo[],
  ): Promise<DiscoveredRepoWithBadge[]> {
    return Promise.all(
      discovered.map(async (repo) => {
        let badge: RepoBadge = { branch: repo.branch, dirtyCount: 0 }
        try {
          const sr = await send<GitStatus>('git.status', {
            workspace_path: repo.abs_path,
            include_ignored: false,
          })
          if (sr.ok && sr.payload) {
            const s = sr.payload
            badge = {
              branch: s.branch || repo.branch,
              dirtyCount: s.staged.length + s.unstaged.length + s.untracked.length,
            }
          }
        } catch {
          // leave default badge
        }
        return { ...repo, badge }
      }),
    )
  }

  // `force` makes the backend walk the tree even on a cloud-synced path. Pass it
  // only from an explicit user action — the walk is what wedged the backend.
  async function refresh(force = false): Promise<void> {
    const ws = workspacePath()
    if (!ws) {
      repositories.value = []
      discoverySkipped.value = false
      forcedWorkspace = ''
      return
    }

    let discovered: DiscoveredRepo[] = []
    try {
      const resp = await send<DiscoverReposResponse>(
        'git.discover_repositories',
        { workspace_path: ws, force },
      )
      if (!resp.ok || !resp.payload?.ok || workspacePath() !== ws) return
      const skipped = resp.payload.skipped === 'cloud_storage'
      // Don't throw away a result the user already paid a tree walk for.
      if (skipped && forcedWorkspace === ws) return
      discovered = resp.payload.repositories ?? []
      discoverySkipped.value = skipped
    } catch {
      return
    }

    if (force) forcedWorkspace = ws
    const badged = await withBadges(discovered)

    if (workspacePath() === ws) {
      repositories.value = badged
    }
  }

  // Adopt a repository list a child pane already fetched with force: true. One
  // user click must cost exactly one backend walk, so this takes over the
  // result rather than issuing a second git.discover_repositories.
  async function adopt(discovered: DiscoveredRepo[]): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    forcedWorkspace = ws
    discoverySkipped.value = false
    const badged = await withBadges(discovered)
    if (workspacePath() === ws) {
      repositories.value = badged
    }
  }

  // Re-discover when workspace changes.
  const _stopWatch = watch(workspacePath, () => void refresh(), { immediate: true })
  onScopeDispose(_stopWatch)

  // Re-discover on git.changed broadcasts for this workspace (or a repo nested
  // inside it — badge statuses register watchers under each repo's abs_path).
  // Reacting to every workspace made each window re-scan all repos and fan out
  // a git.status per repo on any disk change anywhere.
  let _timer: ReturnType<typeof setTimeout> | null = null
  const _offChanged = on('git.changed', (payload: unknown) => {
    const p = payload as { workspace_path?: string }
    const ws = workspacePath()
    if (p?.workspace_path && ws) {
      const prefix = ws.endsWith('/') ? ws : ws + '/'
      if (p.workspace_path !== ws && !p.workspace_path.startsWith(prefix)) return
    }
    if (_timer !== null) clearTimeout(_timer)
    _timer = setTimeout(() => {
      _timer = null
      void refresh()
    }, 400)
  })
  onScopeDispose(() => {
    _offChanged()
    if (_timer !== null) clearTimeout(_timer)
  })

  return { repositories, discoverySkipped, refresh, adopt }
}
