import { invokeCommand, listCommands } from '@navide/shared'
import { currentDiagnosticSeq, takeDiagnosticsSince } from '../lib/uiDiagnostics'

/**
 * Bridges an external MCP client's `ui.invoke.request` broadcasts into this
 * window's command registry and replies with `ui.invoke.result`. Backend
 * contract (do not change without updating the backend side):
 *   request:  { request_id, workspace_path, op, action, args, global }
 *   response: backend.send('ui.invoke.result', { request_id, ok, result, error, warnings? })
 * `warnings` is a string array and is only present when uiDiagnostics recorded
 * something during the action (e.g. injectText resending content) — it lets
 * the caller see an in-window anomaly even though `ok` is still true.
 */

export type UiInvokeOp = 'invoke' | 'snapshot' | 'list_actions'

export interface UiInvokeRequest {
  request_id: string
  workspace_path: string
  op: UiInvokeOp
  action: string | null
  args: Record<string, unknown> | null
  global: boolean
}

export interface UiActionBusBackend {
  send: (type: string, payload: Record<string, unknown>) => Promise<unknown>
  on: (type: string, cb: (payload: unknown) => void) => (() => void) | void
}

export interface UseUiActionBusOptions {
  backend: UiActionBusBackend
  /** Reactive-or-plain holder for this window's open workspace path. */
  currentWorkspace: { value: string }
  buildSnapshot: () => unknown | Promise<unknown>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Handles a single ui.invoke.request payload; exported for direct unit testing
 *  without going through a fake backend.on subscription. */
export async function handleUiInvokeRequest(
  raw: unknown,
  opts: UseUiActionBusOptions,
): Promise<void> {
  const req = raw as Partial<UiInvokeRequest> | null | undefined
  if (!req || !req.request_id || !req.op) return
  // Ownership: global requests are already single-cast to the right window by
  // the backend; otherwise only the window whose open workspace matches
  // answers — mirrors handleMcpSpawnRequest's local-ownership check in App.vue
  // for agent_spawn.request (another window silently owns any mismatch).
  if (!req.global && req.workspace_path !== opts.currentWorkspace.value) return

  const diagnosticSeq = currentDiagnosticSeq()
  let ok = true
  let result: unknown
  let error: string | undefined
  try {
    if (req.op === 'invoke') {
      if (!req.action) {
        ok = false
        error = 'action is required for op "invoke"'
      } else {
        const outcome = await invokeCommand(req.action, req.args ?? undefined)
        ok = outcome.ok
        result = outcome.result
        error = outcome.error
      }
    } else if (req.op === 'snapshot') {
      result = await opts.buildSnapshot()
    } else if (req.op === 'list_actions') {
      result = listCommands()
    } else {
      ok = false
      error = `unknown op: ${String(req.op)}`
    }
  } catch (err) {
    ok = false
    error = errorMessage(err)
  }

  const diagnostics = takeDiagnosticsSince(diagnosticSeq)
  const payload: Record<string, unknown> = { request_id: req.request_id, ok, result, error: error ?? null }
  if (diagnostics.length > 0) {
    payload.warnings = diagnostics.map((d) => `[${d.code}] ${d.message}`)
  }

  await opts.backend
    .send('ui.invoke.result', payload)
    .catch(() => { /* best-effort reply — the requester's own call just times out */ })
}

/** Subscribes to ui.invoke.request for this window's lifetime. Returns an
 *  unsubscribe function; App.vue does not call it (App.vue lives for the
 *  window's lifetime, same as its other backend.on registrations). */
export function useUiActionBus(opts: UseUiActionBusOptions): () => void {
  const off = opts.backend.on('ui.invoke.request', (raw) => { void handleUiInvokeRequest(raw, opts) })
  return () => { off?.() }
}
