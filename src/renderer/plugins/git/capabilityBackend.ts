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
// The plugin composition root consumes this facade to create one SDK-bound
// capability surface, then passes named feature ports to GitWindowApp. The Git
// domain itself does not import this module or observe its generic facade.
// This module is Vue-aware (it owns the reactive `status` ref) but must stay
// free of any `electron`/`window.agentTeam` reference — a plugin's only host
// surface is `window.nav`.

import { ref, type Ref } from 'vue'

type BackendStatus = 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'

interface AutoRestartInfo {
  attempt: number
  max: number
  reason: string
}

interface WsResponse<T = unknown> {
  id: string
  type: string
  ok: boolean
  payload: T | null
  error: { code: string; message: string; details?: Record<string, unknown> } | null
  timestamp: string
}

// ── window.nav (injected by src/preload/plugin-preload.ts) ───────────────────
interface CapabilityResponse {
  reqId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message?: string }
}
interface NavBridge {
  callCapability(ns: string, method: string, args?: unknown): Promise<CapabilityResponse>
  /** Fire-and-forget capability call (no response). Optional: older hosts may
   *  not expose it, in which case the shim falls back to callCapability. */
  castCapability?(ns: string, method: string, args?: unknown): void
  on(type: string, cb: (data: unknown) => void): () => void
  ready(): void
}

// Keep the plugin-side broker deadline aligned with the Git transport's
// established default. The SDK source must enforce this before returning a
// response to any feature port; forwarding the number alone is not enough.
const DEFAULT_CAPABILITY_TIMEOUT_MS = 10_000

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
  // Three-way conflict surface: read the index's merge stages, enumerate
  // unmerged paths, and stage a hand-merged file as resolved.
  'conflict_stages', 'list_conflicts', 'mark_resolved',
] as const

// issues.* WS types (uniform namespace) — the embedded GitPane's cloud-issues
// panel (gh/glab CRUD via useIssues).
const ISSUES_METHODS = ['provider', 'list', 'get', 'create', 'comment', 'set_state'] as const

// fs.* WS types (uniform namespace) the Git UI may send — diff panes read blobs
// / images, the workspace change event (git.changed) is gated on `fs`, and the
// embedded AiCliDock's @-mention file listing/probe adds the flat listing and
// stat_path.
const FS_METHODS = [
  'read_file',
  'write_file',
  'list_dir',
  'list_files_flat',
  'glob_files',
  'delete',
  'rename',
  'read_image',
  'list_archive',
  'convert_office',
  'stat_path',
] as const

// terminal.* WS types (uniform namespace) — the embedded AiCliDock CLI agent
// panel (useTerminal): PTY spawn/reattach lifecycle, keystroke input,
// resize/redraw, interrupt/kill. `terminal.create.cancel` has a second dot, so
// it rides EXPLICIT below.
const TERMINAL_METHODS = [
  'create', 'input', 'log_sent', 'resize', 'interrupt', 'kill', 'reattach', 'redraw',
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
  // Shell-level host capabilities (HOST_CAPABILITIES): remote ↗ browser open,
  // worktree Finder reveal / open-in-new-window, and the directory picker the
  // worktree add/move flows use.
  'ui.open_external': { ns: 'ui', method: 'open_external' },
  'ui.reveal_path': { ns: 'ui', method: 'reveal_path' },
  'ui.open_workspace': { ns: 'ui', method: 'open_workspace' },
  'ui.pick_folder': { ns: 'ui', method: 'pick_folder' },
  // shell → TerminalCapability (one-shot command run)
  'shell.run': { ns: 'terminal', method: 'run' },
  // PTY create cancellation (second dot → not uniform-splittable)
  'terminal.create.cancel': { ns: 'terminal', method: 'create_cancel' },
  // Messaging roster read for the embedded CLI panel's @-mention menu (see
  // capabilityMap's note on why it rides the terminal namespace).
  'agent_msg.list': { ns: 'terminal', method: 'agent_msg_list' },
}

/**
 * Complete WS-type → capability map for every `type` the Git UI sends. Pure
 * data so it is trivially unit-testable. A `type` absent here is an explicit
 * "unmapped" (see {@link resolveCapability}).
 *
 * The `git.changed` / `git.credential_*` / `terminal.output` / `terminal.exit`
 * server-push events are subscribed via `on()` (no request mapping needed
 * here); their broker forwarding is gated by CAP_EVENTS on the main side.
 */
export const TYPE_TO_CAP: Readonly<Record<string, CapabilityRef>> = {
  ...fromNs('git', GIT_METHODS),
  ...fromNs('fs', FS_METHODS),
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

// ── Plugin capability facade ─────────────────────────────────────────────────
/**
 * Provides the plugin composition root with a capability-backed, backend-shaped
 * facade. Feature code receives named ports before GitWindowApp is mounted.
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
  // The broker fans out only the status, not main's auto-restart bookkeeping,
  // so a plugin view can tell that the backend is away but not which respawn
  // attempt is in flight. Kept as a ref to satisfy the host's shape.
  const autoRestart = ref<AutoRestartInfo | null>(null)

  async function send<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<WsResponse<T>> {
    const cap = resolveCapability(type)
    if (!cap) {
      return errorWsResponse<T>(type, 'UNMAPPED_CAPABILITY', `no capability mapping for '${type}'`)
    }
    try {
      const bridge = navBridge()
      // One-way fast path (terminal.input / terminal.log_sent): cast and
      // resolve immediately with a synthetic ok — no per-keystroke round-trip.
      if (CAST_TYPES.has(type) && typeof bridge.castCapability === 'function') {
        bridge.castCapability(cap.ns, cap.method, payload)
        return { id: '', type, ok: true, payload: null, error: null, timestamp: nowIso() }
      }
      const deadlineMs = timeoutMs ?? DEFAULT_CAPABILITY_TIMEOUT_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race([
          bridge.callCapability(cap.ns, cap.method, payload).then((response) => ({
            kind: 'response' as const,
            response,
          })),
          new Promise<{ kind: 'timeout' }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'timeout' }), deadlineMs)
          }),
        ])
        if (outcome.kind === 'timeout') {
          return errorWsResponse<T>(
            type,
            'TIMEOUT',
            `capability call '${type}' timed out after ${deadlineMs}ms`,
          )
        }
        return toWsResponse<T>(type, outcome.response)
      } finally {
        if (timer) clearTimeout(timer)
      }
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
  // Resolving keeps callers that `await` these from hanging, but a silent
  // resolve reads as success, so name the no-op where a caller can see it.
  function restart(): Promise<unknown> {
    console.warn('[git-plugin] backend.restart() is a no-op — the host owns the backend lifecycle')
    return Promise.resolve()
  }
  function stop(): Promise<unknown> {
    console.warn('[git-plugin] backend.stop() is a no-op — the host owns the backend lifecycle')
    return Promise.resolve()
  }

  return { status, wsUrl, httpUrl, shell, port, pid, lastError, autoRestart, send, on, restart, stop }
}
