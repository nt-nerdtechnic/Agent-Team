// capabilityBackend — Git plugin.
//
// The seam that lets the Git UI (GitWindowApp.vue, useGit, the diff panes …)
// run inside an isolated plugin WebContentsView. It re-implements the exact
// public surface of the renderer's `useBackend()` composable, but instead of
// owning a WebSocket it routes every `send(type, payload)` through the host
// capability broker (`window.nav`):
//
//   useGit.send(type, payload)
//     → TYPE_TO_CAP[type] = { ns, method }
//     → window.nav.callCapability(ns, method, payload)   (IPC → main broker)
//     → main broker enforces manifest.requires + dispatches to the backend WS
//     ← CapabilityResponse, remapped to the WsResponse shape caller code expects
//
// The plugin build aliases `composables/useBackend` to this module (see
// vite.git.config.ts), so GitWindowApp's `import { useBackend }` and every
// `ReturnType<typeof useBackend>` prop type resolve here with zero source
// changes. This module is Vue-aware (it owns the reactive `status` ref) but must
// stay free of any `electron`/`window.agentTeam` reference — a plugin's only
// host surface is `window.nav`.

import { ref, type Ref } from 'vue'
import type { BackendStatus, WsResponse } from '../../src/composables/useBackend'

// ── window.nav (injected by src/preload/plugin-preload.ts) ───────────────────
interface CapabilityResponse {
  reqId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message?: string }
}
interface NavBridge {
  callCapability(ns: string, method: string, args?: unknown): Promise<CapabilityResponse>
  on(type: string, cb: (data: unknown) => void): () => void
  ready(): void
}

// Deliberately NOT a `declare global` Window augmentation: the other plugin
// modules already augment `Window.nav`, and their bridge surfaces are evolving
// independently — a structurally different re-declaration here would break
// vue-tsc (TS2717). A local cast reads the same runtime bridge without
// coupling this bundle to the global declaration's exact shape.
function navBridge(): NavBridge {
  return (window as unknown as { nav: NavBridge }).nav
}

// ── Capability mapping ───────────────────────────────────────────────────────
/** A backend capability address: which namespace + method a WS `type` maps to. */
export interface CapabilityRef {
  ns: string
  method: string
}

/** Build `{ "<ns>.<method>": { ns, method } }` for a namespace whose WS types
 *  are exactly `"<ns>.<method>"` (git and fs are both uniform namespaces —
 *  capabilityMap.ts). */
function fromNs(ns: string, methods: readonly string[]): Record<string, CapabilityRef> {
  const out: Record<string, CapabilityRef> = {}
  for (const method of methods) out[`${ns}.${method}`] = { ns, method }
  return out
}

// Every git.* WS type useGit sends. `git` is a uniform namespace, so the WS
// type equals the capability address one-for-one (capabilityMap.ts GIT_METHODS).
// Kept as the full method set so the shim covers the whole useGit surface, not
// just the subset the current GitWindowApp exercises.
const GIT_METHODS = [
  'status', 'log', 'diff_branches', 'rebase', 'restore_from_branch', 'show_commit',
  'worktrees', 'add_worktree', 'remove_worktree', 'prune_worktrees', 'lock_worktree',
  'unlock_worktree', 'move_worktree', 'repair_worktrees', 'config_set', 'config_get',
  'blame', 'tags', 'create_tag', 'delete_tag', 'cherry_pick', 'file_log', 'show_file',
  'resolve_ours', 'resolve_theirs', 'remotes', 'diff_file', 'diff_blame', 'merge',
  'merge_into', 'revert', 'add_remote', 'remove_remote', 'branches', 'stash_list',
  'fetch', 'pull', 'push', 'create_branch', 'switch_branch', 'checkout_remote_branch',
  'checkout_commit', 'commit_file_diff', 'delete_branch', 'stash', 'stash_pop',
  'stash_drop', 'amend', 'undo_commit', 'apply_patch', 'clone', 'check_ignore', 'abort',
  'stash_apply', 'pull_rebase', 'push_force', 'push_upstream', 'credential_submit',
  'credential_cancel', 'discover_repositories', 'compare_branches', 'clean', 'discard',
  'stage', 'unstage', 'stage_all', 'commit', 'sync', 'init', 'generate_message',
  'check_staged', 'connect_to_remote', 'ignore', 'diff_all', 'reset',
] as const

// fs.* WS types (uniform namespace) the Git UI may send — diff panes read blobs
// / images, and the workspace change event (git.changed) is gated on `fs`.
const FS_METHODS = [
  'read_file',
  'write_file',
  'list_dir',
  'delete',
  'rename',
  'read_image',
  'list_archive',
  'convert_office',
] as const

// Non-uniform WS types: the type string differs from `<ns>.<method>`. Settings
// persistence (lib/settings.ts theme sync) remaps onto the ui namespace, and
// `ui.open_in_editor` is a HOST capability (pluginCapabilityBroker
// HOST_CAPABILITIES): the main process routes the file to the mini-IDE plugin,
// falling back to the OS default application when it is not installed.
const EXPLICIT: Record<string, CapabilityRef> = {
  'ui.settings.get': { ns: 'ui', method: 'settings_get' },
  'ui.settings.set': { ns: 'ui', method: 'settings_set' },
  'ui.open_in_editor': { ns: 'ui', method: 'open_in_editor' },
}

/**
 * Complete WS-type → capability map for every `type` the Git UI sends. Pure
 * data so it is trivially unit-testable. A `type` absent here is an explicit
 * "unmapped" (see {@link resolveCapability}).
 *
 * The `git.changed` / `git.credential_*` server-push events are subscribed via
 * `on()` (no request mapping needed here); their broker forwarding is gated by
 * CAP_EVENTS on the main side.
 */
export const TYPE_TO_CAP: Readonly<Record<string, CapabilityRef>> = {
  ...fromNs('git', GIT_METHODS),
  ...fromNs('fs', FS_METHODS),
  ...EXPLICIT,
}

/** Resolve a WS message `type` to its capability address, or `null` when the
 *  type has no mapping (caller must handle unmapped explicitly). */
export function resolveCapability(type: string): CapabilityRef | null {
  return TYPE_TO_CAP[type] ?? null
}

/** Read the backend HTTP base the host injected as `?http_url=` (empty when the
 *  view was opened without one, or outside a browser context in tests). */
function readHttpUrlFromQuery(): string {
  if (typeof window === 'undefined' || !window.location) return ''
  return new URLSearchParams(window.location.search).get('http_url') ?? ''
}

// ── WsResponse adaptation ────────────────────────────────────────────────────
function nowIso(): string {
  return new Date().toISOString()
}

/** Adapt a broker CapabilityResponse into the `WsResponse` envelope caller code
 *  already consumes (reads `.ok` / `.payload` / `.error`). */
function toWsResponse<T>(type: string, resp: CapabilityResponse): WsResponse<T> {
  return {
    id: resp.reqId,
    type,
    ok: resp.ok,
    payload: (resp.ok ? (resp.result as T) : null) ?? null,
    error: resp.error ? { code: resp.error.code, message: resp.error.message ?? '' } : null,
    timestamp: nowIso(),
  }
}

/** A client-side failure envelope (unmapped type / broker unreachable) shaped
 *  like a backend error response so callers awaiting `.ok` don't crash. */
function errorWsResponse<T>(type: string, code: string, message: string): WsResponse<T> {
  return { id: '', type, ok: false, payload: null, error: { code, message }, timestamp: nowIso() }
}

// ── The useBackend-compatible shim ───────────────────────────────────────────
/**
 * Drop-in replacement for `useBackend()` inside the Git plugin bundle. Returns
 * the identical public surface; the plugin build aliases the real composable to
 * this so GitWindowApp and useGit use it unchanged.
 */
export function useBackend(): {
  status: Ref<BackendStatus>
  wsUrl: Ref<string>
  httpUrl: Ref<string>
  shell: Ref<string>
  port: Ref<number>
  pid: Ref<number>
  lastError: Ref<string>
  send: <T = unknown>(
    type: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number
  ) => Promise<WsResponse<T>>
  on: (type: string, cb: (payload: unknown) => void) => () => void
  restart: () => Promise<unknown>
  stop: () => Promise<unknown>
} {
  // The broker owns the real WS liveness and fans every transition out as the
  // host-synthesized `nav.backend_status` event (frontendPluginManager
  // dispatchBackendStatus), replaying the current status once at view load.
  // Start optimistic — the host connects the shared transport at plugin open —
  // and converge on the pushed transitions.
  const status = ref<BackendStatus>('connected')
  navBridge().on('nav.backend_status', (data) => {
    const s = (data as { status?: BackendStatus } | null)?.status
    if (s === 'connecting' || s === 'connected' || s === 'disconnected' || s === 'error') {
      status.value = s
    }
  })
  const wsUrl = ref('')
  // The host appends the backend HTTP base as a `http_url` query param at mount
  // (mirrors core useBackend's `httpUrl = http://<host>:<port>`), so panes that
  // build HTTP URLs (image/media fetches) can resolve it inside the plugin.
  const httpUrl = ref(readHttpUrlFromQuery())
  const shell = ref('')
  const port = ref(0)
  const pid = ref(0)
  const lastError = ref('')

  async function send<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    _timeoutMs?: number
  ): Promise<WsResponse<T>> {
    const cap = resolveCapability(type)
    if (!cap) {
      return errorWsResponse<T>(type, 'UNMAPPED_CAPABILITY', `no capability mapping for '${type}'`)
    }
    try {
      const resp = await navBridge().callCapability(cap.ns, cap.method, payload)
      return toWsResponse<T>(type, resp)
    } catch (err) {
      return errorWsResponse<T>(
        type,
        'BROKER_ERROR',
        err instanceof Error ? err.message : 'capability call failed'
      )
    }
  }

  function on(type: string, cb: (payload: unknown) => void): () => void {
    return navBridge().on(type, cb)
  }

  // No lifecycle control from inside a plugin view — the host owns the backend.
  function restart(): Promise<unknown> {
    return Promise.resolve()
  }
  function stop(): Promise<unknown> {
    return Promise.resolve()
  }

  return { status, wsUrl, httpUrl, shell, port, pid, lastError, send, on, restart, stop }
}
