import { watch } from 'vue'
import type { useBackend } from '../composables/useBackend'

// Renderer-side facade over the backend-owned UI settings KV store
// (ui_settings.json, see backend/agent_team_backend/ui_settings.py). Exposes a
// localStorage-like synchronous API backed by an in-memory cache:
//
// - The cache is seeded synchronously at module load from the main process's
//   bootstrap snapshot (window.agentTeam.getBootstrapSettings), so values are
//   available before first paint — no flash.
// - Writes update the cache immediately and are debounce-batched (500 ms) into
//   a single `ui.settings.set` message; a null value on the wire deletes the
//   key (settingsRemove semantics).
// - While the WebSocket is down, writes stay queued and are flushed on
//   reconnect; after each (re)connect the cache is reconciled against the
//   backend via `ui.settings.get`.
// - `ui.settings_changed` broadcasts (writes from other windows — the backend
//   excludes the sender) are merged into the cache for multi-window sync.

type Backend = ReturnType<typeof useBackend>

export const SETTINGS_FLUSH_DEBOUNCE_MS = 500

// ── One-time localStorage → ui_settings.json migration ──────────────────────
// User-level keys that used to live in renderer localStorage. On first run the
// values are copied into the settings store (existing store values win), the
// `__migrated` flag is uploaded with the same batch, and the localStorage
// copies are deleted only after the backend acks the write — so a failed
// migration retries on the next startup. Workspace-scoped keys
// (agentTeam.runGroups.*, agentTeam.activeTab.*, …) are NOT listed here — they
// migrate lazily per workspace into project.json when that workspace is
// opened (App.vue).
export const MIGRATED_LOCALSTORAGE_KEYS: readonly string[] = [
  // language / theme
  'agent-team:language',
  'agent-team:theme',
  'agent-team:theme-custom',
  // main window layout & sticky toggles (App.vue)
  'agentTeam.yolo',
  'agentTeam.autoAnswer',
  'agentTeam.analyzerModel',
  'agentTeam.tokenPanel.expanded',
  'agentTeam.rightPanel.tab',
  'agentTeam.leftWidth',
  'agentTeam.rightWidth',
  'agentTeam.colWidths',
  'agentTeam.rowHeights',
  'agentTeam.sidebarLeftPx',
  'agentTeam.dualFocusSplitPx',
  'agentTeam.floatPipPos',
  'agentTeam.floatPipWidth',
  'agentTeam.spawnHistory',
  'agentTeam.history.logHeight',
  // editor window layout
  'ide-sidebar-width',
  'ide-ai-panel-width',
  // git / search / pipeline / analyzer panes
  'agentTeam.git.logScope',
  'agentTeam.git.autoCommit',
  'agentTeam.gitTopRatio',
  'agentTeam.search.opts',
  'agent-team.benchmark-results',
]

// Dead legacy entries that are deleted outright (never copied). Absorbed from
// per-component one-time cleanups (e.g. ControlPane's pipelineTaskDescription).
// The ai-chat-*/ai-recent-*/ai-thread-* keys are the retired AIChatPane's
// user-level prefs (the pane is gone; the CLI dock replaced it).
export const PURGED_LOCALSTORAGE_KEYS: readonly string[] = [
  'agentTeam.pipelineTaskDescription',
  // Pipeline/agents split divider — the two panes are separate sidebar tabs now.
  'agentTeam.pipelineTopRatio',
  'ai-chat-send-mode',
  'ai-chat-auto-accept',
  'ai-chat-smart-context',
  'ai-chat-user-rules',
  'ai-chat-custom-docs',
  'ai-chat-max-agent-iter',
  'ai-chat-memories',
  'ai-chat-global-context-pins',
  'ai-chat-prompt-templates',
  'ai-chat-snippets',
  'ai-recent-at',
  'ai-recent-cmds',
  'ai-chat-thread-sort',
  'ai-thread-panel-h',
  'ai-thread-last-visited',
  'ai-chat-terminal-buffer',
]

// Workspace-scoped leftovers of the retired AIChatPane, keyed as
// `<prefix><workspacePath>` — deleted by prefix scan (exact keys can't be
// enumerated up front).
export const PURGED_LOCALSTORAGE_PREFIXES: readonly string[] = [
  'ai-chat-notes:',
  'ai-chat-notepads:',
  'ai-chat-threads:',
  'ai-chat-history:',
]

const MIGRATION_FLAG = '__migrated'

function seedFromBootstrap(): Record<string, unknown> {
  try {
    const raw = window.agentTeam?.getBootstrapSettings?.() ?? '{}'
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (err) {
    console.warn('[settings] bootstrap parse failed; starting empty', err)
  }
  return {}
}

const cache: Record<string, unknown> = seedFromBootstrap()

// Keys written locally but not yet acknowledged by the backend. A null value
// marks a pending delete. Survives disconnects — flushed on reconnect.
const pending = new Map<string, unknown>()

let backend: Backend | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let stopStatusWatch: (() => void) | null = null
let offSettingsChanged: (() => void) | null = null

// Local listeners notified when OTHER sources change the cache (broadcasts
// from other windows, connect-time reconcile) — NOT this window's own writes.
// Lets consumers that must react live (e.g. the editor window's theme) replace
// the old cross-window localStorage `storage` event.
type SettingsChangeListener = (changedKeys: string[]) => void
const changeListeners = new Set<SettingsChangeListener>()

/** Subscribe to external settings changes (other windows / reconcile).
 *  Returns an unsubscribe function. */
export function onSettingsChanged(cb: SettingsChangeListener): () => void {
  changeListeners.add(cb)
  return () => changeListeners.delete(cb)
}

function notifyChanged(keys: string[]): void {
  if (keys.length === 0) return
  for (const cb of changeListeners) {
    try {
      cb(keys)
    } catch (err) {
      console.warn('[settings] change listener failed', err)
    }
  }
}

/** Seed cache entries without queueing a backend write. Used by plugin views,
 *  whose origin has no bootstrap snapshot, to inject host-provided initial
 *  values (e.g. the theme from the entry query) before the app mounts. Keys
 *  already present are kept — the connect-time reconcile stays authoritative. */
export function seedSettings(entries: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (!(key in cache)) cache[key] = value
  }
}

/** Synchronous cache read. Returns `fallback` when the key is absent. */
export function settingsGet<T>(key: string, fallback: T): T {
  return key in cache ? (cache[key] as T) : fallback
}

/** Write a JSON-serializable value. `null`/`undefined` are remove semantics
 *  (null is the delete marker on the wire, undefined can't survive JSON). */
export function settingsSet(key: string, value: unknown): void {
  if (value === null || value === undefined) {
    settingsRemove(key)
    return
  }
  cache[key] = value
  pending.set(key, value)
  scheduleFlush()
}

/** Delete a key locally and on the backend (null value in the batched set). */
export function settingsRemove(key: string): void {
  delete cache[key]
  pending.set(key, null)
  scheduleFlush()
}

/** Hook the module to the window's WebSocket backend (call once, e.g. right
 *  after useBackend() in App.vue). Subscribes to `ui.settings_changed`
 *  broadcasts and, on every (re)connect, reconciles the cache via
 *  `ui.settings.get` and flushes writes queued while offline. */
export function initSettingsBackend(b: Backend): void {
  if (backend) return
  backend = b
  offSettingsChanged = b.on('ui.settings_changed', (raw) => {
    const delta = (raw as { settings?: unknown } | null)?.settings
    if (delta === null || typeof delta !== 'object') return
    const changed: string[] = []
    for (const [key, value] of Object.entries(delta as Record<string, unknown>)) {
      // A locally pending write is newer than the broadcast (the backend
      // merges last-write-wins and our flush hasn't landed yet) — keep ours.
      if (pending.has(key)) continue
      if (value === null) delete cache[key]
      else cache[key] = value
      changed.push(key)
    }
    notifyChanged(changed)
  })
  stopStatusWatch = watch(
    () => b.status.value,
    (s) => {
      if (s === 'connected') void reconcile(b)
    },
    { immediate: true },
  )
}

async function reconcile(b: Backend): Promise<void> {
  try {
    const resp = await b.send<{ settings?: Record<string, unknown> }>('ui.settings.get', {})
    const server = resp.ok ? resp.payload?.settings : undefined
    if (server && typeof server === 'object') {
      // The backend file is authoritative, except for local writes that
      // haven't been flushed yet — those take precedence and flush below.
      const changed: string[] = []
      for (const key of Object.keys(cache)) {
        if (!(key in server) && !pending.has(key)) {
          delete cache[key]
          changed.push(key)
        }
      }
      for (const [key, value] of Object.entries(server)) {
        if (!pending.has(key) && cache[key] !== value) {
          cache[key] = value
          changed.push(key)
        }
      }
      notifyChanged(changed)
    }
  } catch (err) {
    console.warn('[settings] reconcile failed', err)
  }
  void flushPending()
}

function scheduleFlush(): void {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPending()
  }, SETTINGS_FLUSH_DEBOUNCE_MS)
}

async function flushPending(): Promise<void> {
  if (pending.size === 0) return
  const b = backend
  // Not connected: keep the queue; the status watch flushes on reconnect.
  if (!b || b.status.value !== 'connected') return
  const updates: Record<string, unknown> = {}
  for (const [key, value] of pending) updates[key] = value
  pending.clear()
  try {
    const resp = await b.send('ui.settings.set', { updates })
    if (!resp.ok) throw new Error(resp.error?.message ?? 'ui.settings.set failed')
    // The batch that carried the migration flag was acked — the store now owns
    // the data, so the legacy localStorage copies can finally be deleted.
    if (MIGRATION_FLAG in updates) removeMigratedLocalCopies()
  } catch (err) {
    console.warn('[settings] flush failed; re-queueing', err)
    // Re-queue what we tried to send, without clobbering newer writes made
    // while the request was in flight.
    for (const [key, value] of Object.entries(updates)) {
      if (!pending.has(key)) pending.set(key, value)
    }
  }
}

function removeMigratedLocalCopies(): void {
  try {
    for (const key of MIGRATED_LOCALSTORAGE_KEYS) window.localStorage.removeItem(key)
  } catch {
    // storage unavailable — nothing to clean up
  }
}

/** One-time user-level migration (runs at module load; exported for tests).
 *  Copies whitelisted localStorage values the store doesn't have yet into the
 *  cache + pending queue, queues the `__migrated` flag with the same batch,
 *  and leaves localStorage deletion to the post-ack hook in flushPending().
 *  Idempotent: once `__migrated` is in the store, only leftover-copy cleanup
 *  runs (covers a crash between ack and removal). */
export function migrateLegacyLocalStorage(): void {
  let store: Storage
  try {
    store = window.localStorage
  } catch {
    return
  }
  for (const key of PURGED_LOCALSTORAGE_KEYS) {
    try {
      store.removeItem(key)
    } catch {
      /* ignore */
    }
  }
  try {
    // Collect first — removing while iterating by index skips keys.
    const prefixed: string[] = []
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)
      if (key && PURGED_LOCALSTORAGE_PREFIXES.some((p) => key.startsWith(p))) prefixed.push(key)
    }
    for (const key of prefixed) store.removeItem(key)
  } catch {
    /* ignore */
  }
  if (cache[MIGRATION_FLAG] === true) {
    removeMigratedLocalCopies()
    return
  }
  for (const key of MIGRATED_LOCALSTORAGE_KEYS) {
    let raw: string | null = null
    try {
      raw = store.getItem(key)
    } catch {
      continue
    }
    if (raw === null) continue
    // An existing store value wins over the stale localStorage copy.
    if (key in cache) continue
    cache[key] = raw
    pending.set(key, raw)
  }
  cache[MIGRATION_FLAG] = true
  pending.set(MIGRATION_FLAG, true)
  scheduleFlush()
}

migrateLegacyLocalStorage()

/** Test-only: detach the backend, drop queued writes, re-seed the cache from
 *  the bootstrap snapshot. */
export function __resetSettingsForTest(): void {
  stopStatusWatch?.()
  stopStatusWatch = null
  offSettingsChanged?.()
  offSettingsChanged = null
  backend = null
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pending.clear()
  changeListeners.clear()
  for (const key of Object.keys(cache)) delete cache[key]
  Object.assign(cache, seedFromBootstrap())
}
