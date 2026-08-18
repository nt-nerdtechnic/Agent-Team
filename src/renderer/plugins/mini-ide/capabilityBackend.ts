// capabilityBackend — Phase 2 M4.
//
// The keystone seam that lets the unmodified mini-IDE (EditorWindowApp.vue,
// useGit, the panes …) run inside an isolated plugin
// WebContentsView. It re-implements the exact public surface of the renderer's
// `useBackend()` composable, but instead of owning a WebSocket it routes every
// `send(type, payload)` through the host capability broker (`window.nav`):
//
//   pane.send(type, payload)
//     → TYPE_TO_CAP[type] = { ns, method }
//     → window.nav.callCapability(ns, method, payload)   (IPC → main broker)
//     → main broker enforces manifest.requires + dispatches to the backend WS
//     ← CapabilityResponse, remapped to the WsResponse shape pane code expects
//
// The plugin build aliases `composables/useBackend` to this module (see
// vite.mini-ide.config.ts), so EditorWindowApp's `import { useBackend }` and
// every `ReturnType<typeof useBackend>` prop type resolve here with zero source
// changes. This module is Vue-aware (it owns the reactive `status` ref) but must
// stay free of any `electron`/`window.agentTeam` reference — a plugin's only
// host surface is `window.nav`.

import { ref, type Ref } from 'vue'
import type { AutoRestartInfo, BackendStatus, WsResponse } from '../../src/composables/useBackend'

// ── window.nav (injected by src/preload/plugin-preload.ts) ───────────────────
interface CapabilityResponse {
  reqId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message?: string }
}
// NOTE: this must stay structurally identical to the other plugin modules'
// `Window.nav` augmentations (noop/fs_probe mounts) or vue-tsc raises TS2717.
// The extended bridge surface (hideSelf / onOpenTarget) is consumed through
// local casts where needed (see EditorWindowApp.vue) rather than widened here.
interface NavBridge {
  callCapability(ns: string, method: string, args?: unknown): Promise<CapabilityResponse>
  /** Fire-and-forget capability call (no response). Optional: older hosts may
   *  not expose it, in which case the shim falls back to callCapability. */
  castCapability?(ns: string, method: string, args?: unknown): void
  on(type: string, cb: (data: unknown) => void): () => void
  ready(): void
}
declare global {
  interface Window {
    nav: NavBridge
  }
}

// ── Capability mapping ───────────────────────────────────────────────────────
/** A backend capability address: which namespace + method a WS `type` maps to. */
export interface CapabilityRef {
  ns: string
  method: string
}

/** Build `{ "<ns>.<method>": { ns, method } }` for a namespace whose WS types
 *  are exactly `"<ns>.<method>"` (fs / git / search — the uniform namespaces). */
function fromNs(ns: string, methods: readonly string[]): Record<string, CapabilityRef> {
  const out: Record<string, CapabilityRef> = {}
  for (const method of methods) out[`${ns}.${method}`] = { ns, method }
  return out
}

// fs.* WS types are `fs.<FsCapability method>` one-for-one. `stat_path` backs
// useTerminal's @-mention existence probe.
const FS_METHODS = [
  'read_file',
  'write_file',
  'list_dir',
  'list_files_flat',
  'glob_files',
  'create_file',
  'delete',
  'mkdir',
  'rename',
  'convert_office',
  'list_archive',
  'read_image',
  'stat_path',
] as const

// git.* WS types are `git.<method>` one-for-one. The backend WS handlers for
// these already exist (direct mode drives them via useGit), so the broker
// dispatches each mapped type straight through.
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
  // Three-way conflict surface: ConflictPane lives in this window, so it needs
  // the index's merge stages, the unmerged-path list, and resolve-only staging.
  'conflict_stages', 'list_conflicts', 'mark_resolved',
] as const

// search.* WS types are `search.<SearchCapability method>` one-for-one.
const SEARCH_METHODS = ['find_in_files', 'replace_in_files'] as const

// terminal.* WS types (uniform namespace) — the interactive PTY surface
// (useTerminal): spawn/reattach lifecycle, keystroke input, resize/redraw,
// interrupt/kill. `terminal.create.cancel` has a second dot, so it rides
// EXPLICIT below. Kept in lockstep with the git/plans shims and the host's
// capabilityMap.ts TERMINAL_METHODS.
const TERMINAL_METHODS = [
  'create', 'input', 'log_sent', 'resize', 'interrupt', 'kill', 'reattach', 'redraw',
] as const

// issues.* WS types are `issues.<method>` one-for-one (GitPane → useIssues,
// gh/glab CRUD). The backend handlers already exist; the plugin just needs the
// `issues` namespace granted in its manifest `requires` for the broker to route.
const ISSUES_METHODS = ['provider', 'list', 'get', 'create', 'comment', 'set_state'] as const

// Non-uniform WS types: the type string differs from `<ns>.<method>`. These are
// the shell/editor/ai/ui families, remapped explicitly onto the M3 capability
// namespaces (terminal / chat / ui).
const EXPLICIT: Record<string, CapabilityRef> = {
  // shell → TerminalCapability
  'shell.run': { ns: 'terminal', method: 'run' },
  // PTY create cancellation (second dot → not uniform-splittable)
  'terminal.create.cancel': { ns: 'terminal', method: 'create_cancel' },
  // Messaging roster read for the embedded CLI panel's @-mention menu (see
  // capabilityMap's note on why it rides the terminal namespace).
  'agent_msg.list': { ns: 'terminal', method: 'agent_msg_list' },
  // editor inline AI → ChatCapability
  'editor.rewrite': { ns: 'chat', method: 'editor_rewrite' },
  'editor.complete': { ns: 'chat', method: 'editor_complete' },
  // ai.chat settings → ChatCapability (retired AIChatPane surface trimmed to
  // the settings store ReviewPane still reads for its analyzer credentials)
  'ai.chat.settings.get': { ns: 'chat', method: 'settings_get' },
  'ai.chat.settings.set': { ns: 'chat', method: 'settings_set' },
  // ai.review / analyzer → ChatCapability (Branch-Diff AI code review). The
  // result events (ai.review.result/end/error) are already chat-gated in
  // CAP_EVENTS; these route the request side through the same namespace.
  'ai.review.start': { ns: 'chat', method: 'review_start' },
  'ai.review.stop': { ns: 'chat', method: 'review_stop' },
  'analyzer.models': { ns: 'chat', method: 'analyzer_models' },
  // settings persistence → UiCapability (ui.settings.set backend handler exists).
  'ui.settings.set': { ns: 'ui', method: 'settings_set' },
  // settings read → UiCapability. lib/settings' connect-time reconcile sends
  // `ui.settings.get` to repopulate the whole cache (theme + other prefs) —
  // the plugin origin has no bootstrap snapshot, so without this mapping the
  // cache stays empty and useTheme falls back to the default dark theme.
  'ui.settings.get': { ns: 'ui', method: 'settings_get' },
}

/**
 * Complete WS-type → capability map for every `type` the mini-IDE sends.
 * Pure data so it is trivially unit-testable. A `type` absent here is an
 * explicit "unmapped" (see {@link resolveCapability}).
 *
 * `issues.*` (GitPane → useIssues) maps to the `issues` namespace the manifest
 * grants; the backend gh/glab handlers already exist, so it routes like fs/git.
 */
export const TYPE_TO_CAP: Readonly<Record<string, CapabilityRef>> = {
  ...fromNs('fs', FS_METHODS),
  ...fromNs('git', GIT_METHODS),
  ...fromNs('search', SEARCH_METHODS),
  ...fromNs('issues', ISSUES_METHODS),
  ...fromNs('terminal', TERMINAL_METHODS),
  ...EXPLICIT,
}

/** WS types the shim casts (fire-and-forget) instead of awaiting: the
 *  per-keystroke PTY input path and its log marker. Their senders never read
 *  the response (`void backend.send(...)` in useTerminal), and a broker
 *  request/response round-trip per key would eat the typing-latency budget. */
const CAST_TYPES: ReadonlySet<string> = new Set(['terminal.input', 'terminal.log_sent'])

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

/** Adapt a broker CapabilityResponse into the `WsResponse` envelope pane code
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
 * Drop-in replacement for `useBackend()` inside the mini-IDE plugin bundle.
 * Returns the identical public surface; the plugin build aliases the real
 * composable to this so EditorWindowApp and every pane use it unchanged.
 */
export function useBackend(): {
  status: Ref<BackendStatus>
  wsUrl: Ref<string>
  httpUrl: Ref<string>
  shell: Ref<string>
  port: Ref<number>
  pid: Ref<number>
  lastError: Ref<string>
  autoRestart: Ref<AutoRestartInfo | null>
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
  // Start optimistic and converge on the pushed transitions.
  const status = ref<BackendStatus>('connected')
  window.nav.on('nav.backend_status', (data) => {
    const s = (data as { status?: BackendStatus } | null)?.status
    if (s === 'connecting' || s === 'connected' || s === 'disconnected' || s === 'error') {
      status.value = s
    }
  })
  const wsUrl = ref('')
  // The host appends the backend HTTP base as a `http_url` query param at mount
  // (mirrors core useBackend's `httpUrl = http://<host>:<port>`), so panes that
  // build HTTP URLs (image/media/PDF fetches) can resolve it inside the plugin.
  const httpUrl = ref(readHttpUrlFromQuery())
  const shell = ref('')
  const port = ref(0)
  const pid = ref(0)
  const lastError = ref('')
  // The broker fans out only the status, not main's auto-restart bookkeeping,
  // so a plugin view can tell that the backend is away but not which respawn
  // attempt is in flight. Kept as a ref to satisfy the host's shape.
  const autoRestart = ref<AutoRestartInfo | null>(null)

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
      // One-way fast path (terminal.input / terminal.log_sent): cast and
      // resolve immediately with a synthetic ok — no per-keystroke round-trip.
      if (CAST_TYPES.has(type) && typeof window.nav.castCapability === 'function') {
        window.nav.castCapability(cap.ns, cap.method, payload)
        return { id: '', type, ok: true, payload: null, error: null, timestamp: nowIso() }
      }
      const resp = await window.nav.callCapability(cap.ns, cap.method, payload)
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
    return window.nav.on(type, cb)
  }

  // No lifecycle control from inside a plugin view — the host owns the backend.
  function restart(): Promise<unknown> {
    return Promise.resolve()
  }
  function stop(): Promise<unknown> {
    return Promise.resolve()
  }

  return { status, wsUrl, httpUrl, shell, port, pid, lastError, autoRestart, send, on, restart, stop }
}
