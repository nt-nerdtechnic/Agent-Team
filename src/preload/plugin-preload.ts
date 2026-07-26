// Dedicated preload for plugin `WebContentsView`s.
//
// Deliberately minimal: it exposes ONLY `window.nav` (callCapability / on /
// ready). It must NOT expose `window.agentTeam` or any of the host's privileged
// surface — a plugin reaches the host solely through brokered capability calls.
// Node-free by design (request ids come from webcrypto) so it runs under
// `sandbox: true`.

import { contextBridge, ipcRenderer } from 'electron'

// The manager injects `--plugin-id=<id>` via webPreferences.additionalArguments,
// so the id is authoritative (main also verifies by sender) and not spoofable
// from page content.
const PLUGIN_ID_PREFIX = '--plugin-id='
const pluginId =
  process.argv.find((a) => a.startsWith(PLUGIN_ID_PREFIX))?.slice(PLUGIN_ID_PREFIX.length) ?? ''

interface CapabilityResponse {
  reqId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message?: string }
}

type EventListener = (data: unknown) => void
const listeners = new Map<string, Set<EventListener>>()

ipcRenderer.on('plugin:cap:event', (_event, payload: { type: string; data: unknown }) => {
  listeners.get(payload.type)?.forEach((cb) => cb(payload.data))
})

const nav = {
  /** Call a host capability. Resolves with the response envelope. */
  callCapability(ns: string, method: string, args?: unknown): Promise<CapabilityResponse> {
    return ipcRenderer.invoke('plugin:cap:call', {
      pluginId,
      ns,
      method,
      args,
      reqId: globalThis.crypto.randomUUID(),
    })
  },
  /** Subscribe to host-pushed events of a given type. Returns a disposer. */
  on(type: string, cb: EventListener): () => void {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    set.add(cb)
    return () => set!.delete(cb)
  },
  /** Announce the plugin has mounted. */
  ready(): void {
    ipcRenderer.send('plugin:ready')
  },
  /** Ask the host to dismiss (hide) this plugin's own view. Sender-scoped in
   *  main: a view can only ever hide itself. */
  hideSelf(): void {
    ipcRenderer.send('plugin:hideSelf')
  },
  /** Subscribe to host-pushed open targets — entry-query-shaped params
   *  delivered to an already-running view instead of a reload (so in-page
   *  state such as open tabs survives). Returns a disposer. */
  onOpenTarget(cb: (params: Record<string, string>) => void): () => void {
    const listener = (_event: unknown, params: Record<string, string>): void => cb(params)
    ipcRenderer.on('plugin:openTarget', listener)
    return () => {
      ipcRenderer.removeListener('plugin:openTarget', listener)
    }
  },
}

contextBridge.exposeInMainWorld('nav', nav)
