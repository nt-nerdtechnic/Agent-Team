import { reactive, watch } from 'vue'
import type { ReactiveValue } from '../ports/value'

/** Private settings adapter seam shared by Host and isolated feature views. */
export interface SettingsBackend {
  readonly status: ReactiveValue<'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'>
  /** When present, getAll() is a partial snapshot owned by these keys. */
  readonly ownedKeys?: readonly string[]
  /** Host-owned keys accepted only from source: "host" broadcasts. */
  readonly readOnlyKeys?: readonly string[]
  getAll(): Promise<Record<string, unknown> | null>
  setMany(updates: Record<string, unknown>): Promise<void>
  onChanged(callback: (payload: unknown) => void): () => void
}

// Renderer-side facade over the backend-owned UI settings KV store
// (ui_settings.json, see backend/agent_team_backend/ui_settings.py). Exposes a
// localStorage-like synchronous API backed by an in-memory cache:
//
// - The Host entrypoint publishes its bootstrap snapshot before lazy-loading a
//   renderer root; the cache reads that generic snapshot at module load, so
//   values are available before first paint — no Host bridge is bundled here.
// - Writes update the cache immediately and are debounce-batched (500 ms) into
//   a single `ui.settings.set` message; a null value on the wire deletes the
//   key (settingsRemove semantics).
// - While the WebSocket is down, writes stay queued and are flushed on
//   reconnect; after each (re)connect the cache is reconciled against the
//   backend via `ui.settings.get`.
// - `ui.settings_changed` broadcasts (writes from other windows — the backend
//   excludes the sender) are merged into the cache for multi-window sync.

type Backend = SettingsBackend

export const SETTINGS_FLUSH_DEBOUNCE_MS = 500

export type SettingsReadinessStatus = 'pending' | 'ready' | 'failed'

/** State of the current authoritative settings snapshot. V2 surfaces render a
 * retry affordance from this state instead of treating a failed snapshot as a
 * successful empty/default store. */
export const settingsReadiness = reactive<{
  status: SettingsReadinessStatus
  error: Error | null
}>({ status: 'ready', error: null })

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

function initialSettings(): Record<string, unknown> {
  const value = (globalThis as typeof globalThis & {
    __navideSettingsBootstrap?: unknown
  }).__navideSettingsBootstrap
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

const cache: Record<string, unknown> = initialSettings()

// Keys written locally but not yet acknowledged by the backend. A null value
// marks a pending delete. Survives disconnects — flushed on reconnect.
const pending = new Map<string, unknown>()

let backend: Backend | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let stopStatusWatch: (() => void) | null = null
let offSettingsChanged: (() => void) | null = null
let backendReady: Promise<void> = Promise.resolve()
let resolveBackendReady: (() => void) | null = null
let rejectBackendReady: ((reason?: unknown) => void) | null = null
let readinessGeneration = 0
const warnedUnsupportedKeys = new Set<string>()

function resetBackendReady(reason = 'settings backend disconnected'): void {
  readinessGeneration += 1
  rejectBackendReady?.(new Error(reason))
  rejectBackendReady = null
  resolveBackendReady = null
  settingsReadiness.status = 'pending'
  settingsReadiness.error = null
  backendReady = new Promise<void>((resolve, reject) => {
    resolveBackendReady = resolve
    rejectBackendReady = reject
  })
  // Consumers may call settingsReady() only after a component has mounted. Keep
  // the rejection observable to those callers while preventing an unhandled
  // rejection when a legacy surface never awaited the readiness gate.
  void backendReady.catch(() => undefined)
}

function warnUnsupportedKeyOnce(key: string): void {
  const dev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true
  if (!dev || warnedUnsupportedKeys.has(key)) return
  warnedUnsupportedKeys.add(key)
  console.warn(`[settings] ignored write to non-owned key '${key}'`)
}

function canWriteKey(key: string): boolean {
  if (!backend?.ownedKeys || backend.ownedKeys.includes(key)) return true
  warnUnsupportedKeyOnce(key)
  return false
}

function isManifestV2Runtime(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('v2') === '1'
}

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
  if (!canWriteKey(key)) return
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
  if (!canWriteKey(key)) return
  delete cache[key]
  pending.set(key, null)
  scheduleFlush()
}

/** Hook the module to a composed settings port (call once from each window's
 *  composition root). Subscribes to settings-change broadcasts and, on every
 *  (re)connect, reconciles the cache and flushes writes queued while offline. */
export function initSettingsBackend(b: Backend): void {
  if (backend) return
  backend = b
  resetBackendReady()
  offSettingsChanged = b.onChanged((raw) => {
    const delta = (raw as { settings?: unknown } | null)?.settings
    if (delta === null || typeof delta !== 'object') return
    const source = (raw as { source?: unknown } | null)?.source
    const ownedKeys = b.ownedKeys ? new Set(b.ownedKeys) : null
    const readOnlyKeys = b.readOnlyKeys ? new Set(b.readOnlyKeys) : null
    const changed: string[] = []
    for (const [key, value] of Object.entries(delta as Record<string, unknown>)) {
      if (ownedKeys) {
        const accepted = source === 'host'
          ? readOnlyKeys?.has(key) === true
          : source === 'plugin-storage'
            ? ownedKeys.has(key)
            : false
        if (!accepted) continue
      }
      // A locally pending write is newer than the broadcast (the backend
      // merges last-write-wins and our flush hasn't landed yet) — keep ours.
      if (pending.has(key)) continue
      if (value === null) delete cache[key]
      else cache[key] = value
      changed.push(key)
    }
    notifyChanged(changed)
  })
  let previousStatus = b.status.value
  stopStatusWatch = watch(
    () => b.status.value,
    (s) => {
      if (s === 'connected') {
        const generation = readinessGeneration
        void reconcile(b, generation)
      } else if (previousStatus === 'connected' || settingsReadiness.status !== 'pending') {
        resetBackendReady()
      }
      previousStatus = s
    },
    { immediate: true },
  )
}

/** Wait for the first connected-store reconciliation before reading a value
 * whose source is a workspace-scoped Plugin Storage partition. */
export function settingsReady(): Promise<void> {
  return backendReady
}

/** Retry the current authoritative snapshot. Unlike a connection watcher this
 *  also retries while the transport remains connected, which lets a v2 UI
 *  recover from a transient `getAll` failure without remounting the app. */
export function retrySettings(): Promise<void> {
  const b = backend
  if (!b) return Promise.reject(new Error('settings backend is not initialized'))
  resetBackendReady('settings snapshot retry superseded the previous attempt')
  if (b.status.value === 'connected') {
    const generation = readinessGeneration
    void reconcile(b, generation)
  }
  return backendReady
}

function markSettingsReady(generation: number): void {
  if (generation !== readinessGeneration) return
  settingsReadiness.status = 'ready'
  settingsReadiness.error = null
  const resolve = resolveBackendReady
  resolveBackendReady = null
  rejectBackendReady = null
  resolve?.()
}

function markSettingsFailed(generation: number, cause: unknown): void {
  if (generation !== readinessGeneration) return
  const error = cause instanceof Error ? cause : new Error(String(cause))
  settingsReadiness.status = 'failed'
  settingsReadiness.error = error
  const reject = rejectBackendReady
  resolveBackendReady = null
  rejectBackendReady = null
  reject?.(error)
}

async function reconcile(b: Backend, generation: number): Promise<void> {
  try {
    const server = await b.getAll()
    if (backend !== b || generation !== readinessGeneration) return
    if (server === null) {
      if (b.ownedKeys) throw new Error('authoritative settings snapshot unavailable')
    } else if (typeof server === 'object' && !Array.isArray(server)) {
      // The backend file is authoritative, except for local writes that
      // haven't been flushed yet — those take precedence and flush below.
      const ownedKeys = b.ownedKeys ? new Set(b.ownedKeys) : null
      const changed: string[] = []
      for (const key of Object.keys(cache)) {
        if (ownedKeys && !ownedKeys.has(key)) continue
        if (!(key in server) && !pending.has(key)) {
          delete cache[key]
          changed.push(key)
        }
      }
      for (const [key, value] of Object.entries(server)) {
        if (ownedKeys && !ownedKeys.has(key)) continue
        if (!pending.has(key) && cache[key] !== value) {
          cache[key] = value
          changed.push(key)
        }
      }
      notifyChanged(changed)
    } else {
      throw new Error('authoritative settings snapshot is invalid')
    }
    markSettingsReady(generation)
    void flushPending()
  } catch (err) {
    console.warn('[settings] reconcile failed', err)
    markSettingsFailed(generation, err)
  }
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
  // An owned v2 store may only receive writes after its authoritative snapshot
  // succeeded. This prevents fallback defaults from overwriting preferences.
  if (b.ownedKeys && settingsReadiness.status !== 'ready') return
  const updates: Record<string, unknown> = {}
  for (const [key, value] of pending) updates[key] = value
  pending.clear()
  try {
    await b.setMany(updates)
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

// The isolated Manifest v2 package has an explicit storage allowlist. Its
// origin-localStorage is a retained legacy seed, not a second migration input;
// the package reads that seed only at its own workspace-selection seam.
if (!isManifestV2Runtime()) migrateLegacyLocalStorage()

/** Test-only: detach the backend, drop queued writes, re-seed the cache from
 *  the bootstrap snapshot. */
export function __resetSettingsForTest(): void {
  stopStatusWatch?.()
  stopStatusWatch = null
  offSettingsChanged?.()
  offSettingsChanged = null
  backend = null
  readinessGeneration += 1
  backendReady = Promise.resolve()
  resolveBackendReady = null
  rejectBackendReady = null
  settingsReadiness.status = 'ready'
  settingsReadiness.error = null
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pending.clear()
  warnedUnsupportedKeys.clear()
  changeListeners.clear()
  for (const key of Object.keys(cache)) delete cache[key]
  Object.assign(cache, initialSettings())
}
