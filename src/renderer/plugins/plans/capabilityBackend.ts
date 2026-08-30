// capabilityBackend — Plans plugin.
//
// The seam that lets the unmodified Plans UI (PlanWindowApp.vue, PlansPane,
// PlanReviewToolbar, the plan stores …) run inside an isolated plugin
// WebContentsView. It re-implements the exact public surface of the renderer's
// `useBackend()` composable, but instead of owning a WebSocket it routes every
// `send(type, payload)` through the host capability broker (`window.nav`):
//
//   pane.send(type, payload)
//     → package-local Plans calls use @navide/plugin-sdk
//     → Host authenticates the view and dispatches the packaged Backend Wire child
//     ← SDK result, remapped to the WsResponse shape pane code expects
//
// Legacy capability calls remain the adapter for the other Plans operations
// until the production core bridge is delivered by the later migration issue.
//
// The plugin build aliases `composables/useBackend` to this module (see
// vite.plans.config.ts), so PlanWindowApp's `import { useBackend }` and every
// `ReturnType<typeof useBackend>` prop type resolve here with zero source
// changes. This module is Vue-aware (it owns the reactive `status` ref) but must
// stay free of any `electron`/`window.agentTeam` reference — a plugin's only
// host surface is `window.nav`.

import { ref, type Ref } from 'vue'
import {
  createPluginBackendClient,
  PluginBackendError,
  type JsonValue,
  type PluginBackendClient,
} from '@navide/plugin-sdk'
import type { AutoRestartInfo, BackendStatus, WsResponse } from '../../src/composables/useBackend'

const PACKAGE_BACKEND_FALLBACK_CODES = new Set([
  'BACKEND_UNAVAILABLE',
  'INVALID_RUNTIME',
  'NOT_READY',
  'PLUGIN_STOPPING',
])
const DEFAULT_CAPABILITY_TIMEOUT_MS = 10_000

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

function packageBackendClient(): PluginBackendClient | null {
  const bridge = navBridge() as NavBridge & Record<string, unknown>
  if (
    typeof bridge.callBackend !== 'function' ||
    typeof bridge.cancelBackend !== 'function' ||
    typeof bridge.subscribeBackend !== 'function'
  ) {
    return null
  }
  try {
    return createPluginBackendClient()
  } catch {
    return null
  }
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
 *  are exactly `"<ns>.<method>"` (fs / terminal / plans — the uniform
 *  namespaces the Plans UI uses). */
function fromNs(ns: string, methods: readonly string[]): Record<string, CapabilityRef> {
  const out: Record<string, CapabilityRef> = {}
  for (const method of methods) out[`${ns}.${method}`] = { ns, method }
  return out
}

// fs.* WS types the Plans UI actually sends (PlansPane list/rename/delete,
// planStore/planShare read+write, PlanFileView/PlanMarkdownBody/PlanDocPreview
// reads, FilePreviewPane's bundled archive/office previews, and the embedded
// AiCliDock's context read + @-mention file listing/probe).
const FS_METHODS = [
  'read_file',
  'write_file',
  'list_dir',
  'list_files_flat',
  'glob_files',
  'delete',
  'rename',
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

// plans.* WS types (uniform namespace) — the plan document index:
// PlanWindowApp resolves the git root its rel_paths are relative to at mount,
// and PlansPane lists the documents plus writes the meta it parsed back into
// the backend cache. Without these the plugin window falls back to the raw
// query-string workspace, which resolves rel_paths against the wrong root when
// the window is opened on a subdirectory of the project.
const PLANS_METHODS = ['resolve_root', 'list_docs', 'cache_put'] as const

// Non-uniform WS types: the type string differs from `<ns>.<method>`. Settings
// persistence (lib/settings.ts theme sync) remaps onto the ui namespace;
// shell.run rides the terminal namespace (mirrors the mini-IDE shim).
const EXPLICIT: Record<string, CapabilityRef> = {
  'ui.settings.get': { ns: 'ui', method: 'settings_get' },
  'ui.settings.set': { ns: 'ui', method: 'settings_set' },
  // shell → TerminalCapability (one-shot command run)
  'shell.run': { ns: 'terminal', method: 'run' },
  // PTY create cancellation (second dot → not uniform-splittable)
  'terminal.create.cancel': { ns: 'terminal', method: 'create_cancel' },
  // Messaging roster read for the embedded CLI panel's @-mention menu (see
  // capabilityMap's note on why it rides the terminal namespace).
  'agent_msg.list': { ns: 'terminal', method: 'agent_msg_list' },
}

/**
 * Complete WS-type → capability map for every `type` the Plans UI sends.
 * Pure data so it is trivially unit-testable. A `type` absent here is an
 * explicit "unmapped" (see {@link resolveCapability}).
 *
 * The `plans` namespace gates both the request types above and the
 * `plans.changed` server-push event (see capabilityMap.ts CAP_EVENTS). The
 * `terminal` namespace likewise gates the terminal.output / terminal.exit
 * events the embedded AiCliDock's useTerminal subscribes to via `on()`.
 */
export const TYPE_TO_CAP: Readonly<Record<string, CapabilityRef>> = {
  ...fromNs('fs', FS_METHODS),
  ...fromNs('terminal', TERMINAL_METHODS),
  ...fromNs('plans', PLANS_METHODS),
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
 * Drop-in replacement for `useBackend()` inside the Plans plugin bundle.
 * Returns the identical public surface; the plugin build aliases the real
 * composable to this so PlanWindowApp and every pane use it unchanged.
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
  navBridge().on('nav.backend_status', (data) => {
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
    timeoutMs?: number
  ): Promise<WsResponse<T>> {
    const cap = resolveCapability(type)
    if (!cap) {
      return errorWsResponse<T>(type, 'UNMAPPED_CAPABILITY', `no capability mapping for '${type}'`)
    }
    try {
      if (type === 'plans.resolve_root') {
        const packageBackend = packageBackendClient()
        if (packageBackend) {
          try {
            const result = await packageBackend.call<JsonValue>(
              type,
              payload as unknown as JsonValue,
              timeoutMs === undefined ? undefined : { timeoutMs },
            )
            return toWsResponse<T>(type, { reqId: '', ok: true, result })
          } catch (error) {
            // An installed package may retain descriptor precedence without
            // the bundled spike backend. Keep the old Plans route as the
            // rollback path whenever the package child is unavailable.
            if (
              error instanceof PluginBackendError &&
              !PACKAGE_BACKEND_FALLBACK_CODES.has(error.code)
            ) throw error
          }
        }
      }
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
      if (err instanceof PluginBackendError) {
        return errorWsResponse(type, err.code, err.message)
      }
      return errorWsResponse<T>(
        type,
        'BROKER_ERROR',
        err instanceof Error ? err.message : 'capability call failed'
      )
    }
  }

  function on(type: string, cb: (payload: unknown) => void): () => void {
    if (type === 'plans.changed') {
      const packageBackend = packageBackendClient()
      if (packageBackend) {
        try {
          const subscription = packageBackend.subscribe<JsonValue>(
            type,
            cb as (payload: JsonValue) => void,
          )
          // The packaged B5 child emits this event for its own roundtrip but
          // does not yet own the core file watcher. Keep the established
          // watcher subscription for the lifetime of the view until Issue 22
          // supplies an equivalent package-owned watcher port.
          const fallbackDisposer = navBridge().on(type, cb)
          void subscription.ready.catch(() => undefined)
          void subscription.settled.catch(() => undefined)
          return () => {
            subscription.dispose()
            fallbackDisposer()
          }
        } catch {
          // A package subscription failure is local to the optional route;
          // keep the established legacy watcher available.
        }
      }
    }
    return navBridge().on(type, cb)
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
