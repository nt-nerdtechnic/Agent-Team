// The preview panel's record track: what this workspace recently changed.
//
// Deliberately the opposite of `usePreview` next door. A preview *target* is a
// here-and-now working context and is never persisted; the record track is a
// per-workspace log that outlives the window, so every row here is minted and
// stored by the backend (`preview_log.py`) and the renderer only mirrors it.
//
// The store merges: an attributed write upgrades the anonymous watcher row the
// same file change already produced, and `preview.recorded` then carries that
// row again with the SAME uid. Merging incoming rows must therefore be an
// upsert by uid — a plain append would show one change twice.
//
// Module-level state, like `usePreview`, because two unrelated call sites need
// the same track: App.vue wires it at startup so the hydrate does not wait for
// the rail to be opened, and PreviewPanel renders it.

import { computed, ref, watch, type Ref } from 'vue'
import type { useBackend } from '../composables/useBackend'

export type PreviewLogChange = 'created' | 'modified' | 'deleted' | 'shown'
export type PreviewLogSource = 'user' | 'agent' | 'watcher'

// Mirrors the backend row exactly (snake_case included) — this is stored data,
// not a renderer-side shape, so renaming the fields would only hide the wire.
export interface PreviewLogEntry {
  uid: string
  created_at: number
  change: PreviewLogChange
  rel_path: string | null
  kind: string
  title: string | null
  source: PreviewLogSource
  pane_id: string | null
  agent: string | null
  tool: string | null
  note: string | null
  payload: string | null
}

// The backend prunes to 300 rows per workspace; this is a second line of
// defence so a misbehaving writer cannot grow the renderer's array without
// bound.
export const MAX_ENTRIES = 300

// Newest first, matching the backend's tail().
const entries = ref<PreviewLogEntry[]>([])
const loading = ref(false)
const lastError = ref('')
// The project root the backend resolved this window's workspace to, as the
// snapshot reported it. Empty until a snapshot answers — see matchesWorkspace.
const resolvedRoot = ref('')

let backendRef: ReturnType<typeof useBackend> | null = null
let workspaceRef: Ref<string> | null = null
let teardown: (() => void)[] = []
let wired = false

function cap(): void {
  if (entries.value.length > MAX_ENTRIES) {
    entries.value.splice(MAX_ENTRIES)
  }
}

// Upsert by uid, not append: see the merge note at the top of this file. The
// row moves back to the front because a merge also bumps its created_at.
function upsert(entry: PreviewLogEntry): void {
  const at = entries.value.findIndex((e) => e.uid === entry.uid)
  if (at >= 0) entries.value.splice(at, 1)
  entries.value.unshift(entry)
  cap()
}

// Several windows share one backend; only rows for the workspace this window
// is showing belong on its track. The backend normalises a workspace to its
// project root before it stores or broadcasts, so once the snapshot has told
// us that root, it — not the raw path this window was opened on — is what an
// event's workspace_path has to equal. Before the first snapshot answers (and
// against a backend too old to report `root`) fall back to the raw path:
// accepting everything would let another workspace's rows onto this track.
function matchesWorkspace(incoming: string): boolean {
  return incoming === (resolvedRoot.value || workspaceRef?.value || '')
}

async function refresh(): Promise<void> {
  const backend = backendRef
  const workspacePath = workspaceRef?.value ?? ''
  if (!backend || !workspacePath) {
    entries.value = []
    return
  }
  if (backend.status.value !== 'connected') return
  loading.value = true
  lastError.value = ''
  try {
    const resp = await backend.send<{ entries?: PreviewLogEntry[]; root?: string }>(
      'preview.log_snapshot',
      {
        workspace_path: workspacePath,
        limit: MAX_ENTRIES,
      }
    )
    // The project may have switched while this was in flight — that snapshot
    // (and the root it resolved) belongs to the workspace we just left.
    if ((workspaceRef?.value ?? '') !== workspacePath) return
    if (resp.ok && resp.payload) {
      resolvedRoot.value = resp.payload.root ?? ''
      entries.value = (resp.payload.entries ?? []).slice(0, MAX_ENTRIES)
    } else {
      lastError.value = resp.error?.message ?? 'snapshot failed'
    }
  } catch (err) {
    lastError.value = String((err as Error).message ?? err)
  } finally {
    loading.value = false
  }
}

// Clears everything the user can currently see and keeps anything recorded
// while they were clicking — the cut-off is what the backend's `before` means.
async function clear(): Promise<number> {
  const backend = backendRef
  const workspacePath = workspaceRef?.value ?? ''
  if (!backend || !workspacePath) return 0
  const before = Date.now()
  try {
    const resp = await backend.send<{ removed?: number }>('preview.log_clear', {
      workspace_path: workspacePath,
      before,
    })
    if (!resp.ok) {
      lastError.value = resp.error?.message ?? 'clear failed'
      return 0
    }
    entries.value = entries.value.filter((e) => e.created_at >= before)
    return resp.payload?.removed ?? 0
  } catch (err) {
    lastError.value = String((err as Error).message ?? err)
    return 0
  }
}

// Wires once per window: the first caller owns the subscription and the
// watched refs, later callers only read the state it maintains.
function wire(backend: ReturnType<typeof useBackend>, workspacePath: Ref<string>): void {
  if (wired) return
  wired = true
  backendRef = backend
  workspaceRef = workspacePath

  teardown.push(backend.on('preview.recorded', (raw) => {
    const msg = raw as {
      workspace_path?: string
      entry?: PreviewLogEntry
      entries?: PreviewLogEntry[]
    }
    if (!matchesWorkspace(msg?.workspace_path ?? '')) return
    // `entry` is one recorded change — every writer that reports a single
    // write. `entries` is the file watcher coalescing a whole burst (a
    // `git checkout` can debounce thousands of paths) into one frame; the
    // backend sends them oldest first, which is the order upsert expects.
    const rows = msg?.entries ?? (msg?.entry ? [msg.entry] : [])
    for (const row of rows) {
      if (row?.uid) upsert(row)
    }
  }))

  teardown.push(backend.on('preview.log_cleared', (raw) => {
    const msg = raw as { workspace_path?: string; before?: number | null }
    // Broadcast from the same resolved root as preview.recorded.
    if (!matchesWorkspace(msg?.workspace_path ?? '')) return
    const before = msg?.before
    entries.value =
      typeof before === 'number' ? entries.value.filter((e) => e.created_at >= before) : []
  }))

  teardown.push(watch(
    () => [backend.status.value, workspacePath.value] as const,
    ([status, ws], prev) => {
      // Switching project must not leave the previous workspace's rows on
      // screen while the new snapshot is in flight — nor its resolved root,
      // which would match that project's broadcasts onto this track.
      if (prev && prev[1] !== ws) {
        entries.value = []
        resolvedRoot.value = ''
      }
      // Also covers reconnect: a snapshot on the connected transition is what
      // fills in whatever `preview.recorded` events were missed while down.
      if (status === 'connected') void refresh()
    },
    { immediate: true }
  ))
}

// Test seam: drop the module state between test cases.
function reset(): void {
  for (const stop of teardown) stop()
  teardown = []
  entries.value = []
  loading.value = false
  lastError.value = ''
  resolvedRoot.value = ''
  backendRef = null
  workspaceRef = null
  wired = false
}

export function usePreviewLog(
  backend: ReturnType<typeof useBackend>,
  workspacePath: Ref<string>
) {
  wire(backend, workspacePath)
  return {
    entries: computed(() => entries.value),
    loading: computed(() => loading.value),
    lastError: computed(() => lastError.value),
    refresh,
    clear,
    reset,
  }
}
