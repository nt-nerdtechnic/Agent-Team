// No-op plugin entry — proves the plugin runtime is alive and that a capability
// call round-trips through the host broker. Runs inside the isolated plugin
// WebContentsView, so the only host surface available is `window.nav` (see
// src/preload/plugin-preload.ts).

interface CapabilityResponse {
  reqId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message?: string }
}

interface NavBridge {
  callCapability(ns: string, method: string, args?: unknown): Promise<CapabilityResponse>
  /** Fire-and-forget capability call (no response). Optional: older hosts may
   *  not expose it. Unused here; declared to keep every `Window.nav`
   *  augmentation structurally identical (TS2717). */
  castCapability?(ns: string, method: string, args?: unknown): void
  on(type: string, cb: (data: unknown) => void): () => void
  ready(): void
}

declare global {
  interface Window {
    nav: NavBridge
  }
}

const out = document.getElementById('pong')

async function main(): Promise<void> {
  window.nav.ready()
  try {
    const res = await window.nav.callCapability('ping', 'ping', { hello: 1 })
    if (out) out.textContent = JSON.stringify(res, null, 2)
  } catch (err) {
    if (out) out.textContent = `capability call failed: ${String(err)}`
  }
}

void main()

export {}
