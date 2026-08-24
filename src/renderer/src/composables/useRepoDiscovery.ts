import { ref, watch, onScopeDispose } from 'vue'
import type { useBackend } from './useBackend'
import type { DiscoveredRepo, DiscoverReposResponse, GitStatus } from './useGit'

export interface RepoBadge {
  branch: string
  dirtyCount: number
}

export interface DiscoveredRepoWithBadge extends DiscoveredRepo {
  badge: RepoBadge
}

export function useRepoDiscovery(
  workspacePath: () => string,
  backend: ReturnType<typeof useBackend>,
) {
  const { send, on } = backend
  const repositories = ref<DiscoveredRepoWithBadge[]>([])
  // True when the backend skipped the downward scan because the workspace lives
  // on a cloud-synced folder (walking it can block for minutes). Only a user
  // triggered forced scan clears it — nothing retries automatically.
  const discoverySkipped = ref(false)

  // `force` makes the backend walk the tree even on a cloud-synced path. Pass it
  // only from an explicit user action — the walk is what wedged the backend.
  async function refresh(force = false): Promise<void> {
    const ws = workspacePath()
    if (!ws) {
      repositories.value = []
      discoverySkipped.value = false
      return
    }

    let discovered: DiscoveredRepo[] = []
    try {
      const resp = await send<DiscoverReposResponse>(
        'git.discover_repositories',
        { workspace_path: ws, force },
      )
      if (!resp.ok || !resp.payload?.ok || workspacePath() !== ws) return
      discovered = resp.payload.repositories ?? []
      discoverySkipped.value = resp.payload.skipped === 'cloud_storage'
    } catch {
      return
    }

    // Fetch lightweight status badge for each repo in parallel.
    const withBadges = await Promise.all(
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

    if (workspacePath() === ws) {
      repositories.value = withBadges
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

  return { repositories, discoverySkipped, refresh }
}
