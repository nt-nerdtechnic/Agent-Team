import { ref, watch, onScopeDispose } from 'vue'
import type { DiscoveredRepo, DiscoverReposResponse, GitStatus } from './useGit'
import type { GitTransport } from '#git-feature'

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
  const discoverySkipped = ref(false)
  let forcedWorkspace = ''

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
      if (force) forcedWorkspace = ws
      const skipped = resp.payload.skipped === 'cloud_storage'
      if (skipped && forcedWorkspace === ws) return
      discovered = resp.payload.repositories ?? []
      discoverySkipped.value = skipped
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

  async function adopt(discovered: DiscoveredRepo[]): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    forcedWorkspace = ws
    discoverySkipped.value = false
    const withAdoptedBadges = await Promise.all(
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
        } catch { /* leave default badge */ }
        return { ...repo, badge }
      }),
    )
    if (workspacePath() === ws) repositories.value = withAdoptedBadges
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
