import { onScopeDispose, ref, watch, type Ref } from 'vue'
import type { useBackend } from './useBackend'

export interface TokenBucket {
  input: number
  output: number
  calls: number
}

export interface RunSnapshot {
  run_id: string
  task: string
  run_dir: string
  started_at: string
  ended_at: string | null
  totals: TokenBucket
  by_vendor: Record<string, TokenBucket>
  by_stage: Record<string, TokenBucket>
  by_pane: Record<string, TokenBucket>
}

export interface CumulativeSnapshot {
  totals: TokenBucket
  by_vendor: Record<string, TokenBucket>
  by_stage: Record<string, TokenBucket>
}

export interface GlobalSnapshot {
  all_time: TokenBucket
  by_vendor: Record<string, TokenBucket>
  by_day: Record<string, TokenBucket>
}

export interface TokensSnapshot {
  workspace_path: string
  workspace: {
    current_run: RunSnapshot | null
    runs: RunSnapshot[]
    cumulative: CumulativeSnapshot
    // Live tallies keyed by session id (or, for a vendor whose reader cannot
    // name a session, the session file's absolute path). Read from the vendor
    // session logs rather than accumulated, so a backend restart does not
    // reset them — the first scan re-derives the whole total.
    live_by_session: Record<string, TokenBucket>
  }
  global: GlobalSnapshot
}

export type ResetScope = 'run' | 'workspace' | 'global'

export function emptyBucket(): TokenBucket {
  return { input: 0, output: 0, calls: 0 }
}

/**
 * Tracks token consumption snapshot from the backend.
 *
 * Subscribes to `tokens.changed` broadcasts so the panel updates live as
 * analyzer calls fire and CLI panes emit token reports. Only applies updates
 * matching the current workspace_path (or workspace-less updates when no
 * workspace is selected) — events for sibling workspaces are dropped so
 * multiple Agent-Team windows don't cross-contaminate.
 */
export function useTokens(
  backend: ReturnType<typeof useBackend>,
  workspacePath: Ref<string>
) {
  const snapshot = ref<TokensSnapshot | null>(null)
  const loading = ref<boolean>(false)
  const lastError = ref<string>('')
  let refreshSeq = 0

  async function refresh(): Promise<void> {
    if (backend.status.value !== 'connected') return
    const seq = ++refreshSeq
    loading.value = true
    lastError.value = ''
    try {
      const resp = await backend.send<TokensSnapshot>('tokens.snapshot', {
        workspace_path: workspacePath.value || undefined
      })
      if (seq !== refreshSeq) return
      if (resp.ok && resp.payload) {
        snapshot.value = resp.payload
      } else {
        lastError.value = resp.error?.message ?? 'snapshot failed'
      }
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  async function reset(scope: ResetScope): Promise<void> {
    try {
      const resp = await backend.send<TokensSnapshot>('tokens.reset', {
        scope,
        workspace_path: workspacePath.value || undefined
      })
      if (resp.ok && resp.payload) {
        snapshot.value = resp.payload
      } else {
        lastError.value = resp.error?.message ?? 'reset failed'
      }
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
    }
  }

  const unsubChanged = backend.on('tokens.changed', (raw) => {
    const payload = raw as TokensSnapshot
    if (!payload) return
    const own = workspacePath.value || ''
    const theirs = payload.workspace_path || ''
    // Only apply if this update is for our workspace (or both are unset).
    // We always accept global-only updates when we have no workspace.
    if (own === theirs) {
      snapshot.value = payload
    }
  })

  // Re-fetch on connect transition + workspace change. Watch via array so
  // both inputs trigger one common handler.
  watch(
    () => [backend.status.value, workspacePath.value] as const,
    ([s, path], prev) => {
      if (!prev || path !== prev[1]) {
        snapshot.value = null
        refreshSeq++
      }
      if (s === 'connected') void refresh()
    },
    { immediate: true }
  )

  onScopeDispose(() => {
    unsubChanged()
  })

  return { snapshot, loading, lastError, refresh, reset }
}
