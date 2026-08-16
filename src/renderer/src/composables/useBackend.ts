import { onScopeDispose, ref } from 'vue'
import { createWsClient, type WsRequest, type WsResponse } from '../../../shared/wsClient'

export type BackendStatus = 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'

// Re-exported so the many call sites importing these from `useBackend` keep
// working; the canonical definitions now live with the shared transport.
export type { WsRequest, WsResponse }

interface BackendInfo {
  status: 'starting' | 'ready' | 'error'
  host?: string
  port?: number
  pid?: number
  shell?: string
  httpUrl?: string
  wsUrl?: string
  error?: string
  /** Present while main has a bounded respawn scheduled for a crashed backend
   *  (see src/main/backend-autorestart.ts). Status stays 'starting' in that
   *  window so the UI waits instead of failing every send fast. */
  autoRestart?: { attempt: number; max: number; reason?: string }
}

/** What the UI shows while a crashed backend is being respawned. Null whenever
 *  no automatic attempt is outstanding. */
export interface AutoRestartInfo {
  attempt: number
  max: number
  reason: string
}

export function useBackend() {
  const status = ref<BackendStatus>('starting')
  const wsUrl = ref<string>('')
  const httpUrl = ref<string>('')
  const shell = ref<string>('')
  const port = ref<number>(0)
  const pid = ref<number>(0)
  const lastError = ref<string>('')
  const autoRestart = ref<AutoRestartInfo | null>(null)

  // All WebSocket transport — request/response correlation, the send queue,
  // reconnect backoff, and the ping liveness probe — lives in the shared
  // client. This composable owns only the Vue-reactive surface and the
  // main-process backend-lifecycle glue (init poll + backend:changed handling).
  const client = createWsClient({
    onStatus: (s) => {
      status.value = s
      if (s === 'connected') lastError.value = ''
    },
    onError: () => {
      lastError.value = 'WebSocket error'
    },
  })

  const send = client.send
  const on = client.on

  // Applied when the main process restarts/stops the backend: the port changes
  // on restart, so tear down the old socket and reconnect to the new wsUrl (or
  // settle on 'disconnected' when the backend was stopped).
  function applyBackendChanged(info: BackendInfo): void {
    // Same backend we're already talking to (e.g. the startup broadcast was
    // queued for this then-unfocused window and flushed on its next focus,
    // after init()'s poll had already connected): keep the healthy socket.
    // Tearing it down here rejects every in-flight request with 'backend
    // changed' — the packaged-launch CLI spawn failure.
    if (info.status === 'ready' && info.wsUrl && client.isHealthyFor(info.wsUrl)) {
      httpUrl.value = info.httpUrl ?? httpUrl.value
      shell.value = info.shell ?? shell.value
      port.value = info.port ?? port.value
      pid.value = info.pid ?? pid.value
      return
    }
    // Old socket + any queued/in-flight requests targeted the old backend/port
    // — reject them rather than replay on the new socket.
    client.reset('backend changed')
    autoRestart.value = info.autoRestart
      ? { attempt: info.autoRestart.attempt, max: info.autoRestart.max, reason: info.autoRestart.reason ?? '' }
      : null
    if (info.status === 'ready' && info.wsUrl) {
      wsUrl.value = info.wsUrl
      httpUrl.value = info.httpUrl ?? ''
      shell.value = info.shell ?? shell.value
      port.value = info.port ?? 0
      pid.value = info.pid ?? 0
      client.connect(info.wsUrl)
    } else if (info.status === 'error') {
      // A start/restart attempt gave up for good (e.g. the packaged binary
      // never came up) — surface it instead of leaving the UI silently
      // "disconnected" with a spinner that never resolves. Fail-fast future
      // sends so they don't queue against a backend that isn't coming back.
      wsUrl.value = ''
      httpUrl.value = ''
      port.value = 0
      pid.value = 0
      status.value = 'error'
      lastError.value = info.error ?? 'backend failed to start'
      client.markErrored()
    } else {
      wsUrl.value = ''
      httpUrl.value = ''
      port.value = 0
      pid.value = 0
      status.value = 'disconnected'
      lastError.value = ''
    }
  }

  function restart(): Promise<unknown> {
    status.value = 'connecting'
    lastError.value = ''
    // Main cancels the automatic budget on a manual restart; mirror that here
    // so the UI stops reporting an attempt that no longer exists.
    autoRestart.value = null
    return window.agentTeam?.restartBackend?.() ?? Promise.resolve()
  }

  function stop(): Promise<unknown> {
    return window.agentTeam?.stopBackend?.() ?? Promise.resolve()
  }

  async function init(): Promise<void> {
    let info: BackendInfo = { status: 'starting' }
    // Poll until main settles on ready/error. Main's give-up point is the
    // user-configurable health-check timeout (up to 120s, see
    // src/main/health-timeout.ts), so derive the deadline from that same
    // setting plus margin — a hardcoded 50s below it surfaced false
    // 'backend did not start' errors on slow-but-successful starts.
    let healthTimeoutSec = 45
    try {
      const cfg = await window.agentTeam?.readHealthCheckTimeout?.()
      if (cfg?.ok && typeof cfg.timeoutSec === 'number') healthTimeoutSec = cfg.timeoutSec
    } catch { /* setting unavailable — fall back to the default */ }
    const deadline = Date.now() + healthTimeoutSec * 1000 + 5_000
    while (Date.now() < deadline) {
      info = (await window.agentTeam?.getBackendInfo?.()) ?? { status: 'starting' }
      if (info.status === 'ready' || info.status === 'error') break
      await new Promise((r) => setTimeout(r, 300))
    }
    if (info.status !== 'ready' || !info.wsUrl) {
      status.value = 'error'
      lastError.value = info.error ?? 'backend did not start'
      client.reset('backend did not start')
      client.markErrored()
      return
    }
    wsUrl.value = info.wsUrl
    httpUrl.value = info.httpUrl ?? ''
    shell.value = info.shell ?? ''
    client.connect(info.wsUrl)
  }

  void init()

  window.agentTeam?.onBackendChanged?.((info) => applyBackendChanged(info))

  onScopeDispose(() => {
    client.dispose('ws not open')
  })

  return { status, wsUrl, httpUrl, shell, port, pid, lastError, autoRestart, send, on, restart, stop }
}
