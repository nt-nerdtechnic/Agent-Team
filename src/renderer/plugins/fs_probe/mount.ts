// FS probe plugin — Phase 2 M2 manual end-to-end check. Declares `requires:
// ["fs"]`, so the host broker lets its `fs.*` calls through to the backend WS
// and forwards `git.changed` working-tree events (gated on the `fs` ns). A
// `git.*` capability CALL, by contrast, is gated on `git` and would be DENIED.
// Runs inside the isolated plugin WebContentsView; the only host surface is
// `window.nav`.

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

const out = document.getElementById('out')
const eventsEl = document.getElementById('events')
const wsInput = document.getElementById('ws') as HTMLInputElement | null
const relInput = document.getElementById('rel') as HTMLInputElement | null
const readBtn = document.getElementById('read')

async function readFile(): Promise<void> {
  const workspace_path = wsInput?.value ?? ''
  const rel_path = relInput?.value ?? ''
  if (out) out.textContent = 'calling fs.read_file…'
  try {
    // Round-trips through the host broker → backend WS → back. A denied call
    // would surface as CAP_DENIED here; a real backend error as BACKEND_ERROR.
    const res = await window.nav.callCapability('fs', 'read_file', { workspace_path, rel_path })
    if (out) out.textContent = JSON.stringify(res, null, 2)
  } catch (err) {
    if (out) out.textContent = `capability call failed: ${String(err)}`
  }
}

let eventCount = 0
window.nav.on('git.changed', (payload) => {
  eventCount += 1
  if (eventsEl) {
    eventsEl.textContent = `#${eventCount} ${JSON.stringify(payload)}\n${eventsEl.textContent ?? ''}`
  }
})

readBtn?.addEventListener('click', () => void readFile())

window.nav.ready()

export {}
