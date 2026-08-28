/**
 * Host-side control of the `<webview>` guests that carry in-window plugin
 * contributions.
 *
 * Two facts shape this module, both measured rather than assumed:
 *
 * - `will-attach-webview` is the only place the Host can override a guest's
 *   webPreferences, and its override wins over whatever the renderer wrote on
 *   the tag. That is what keeps `webviewTag: true` from granting the renderer
 *   any authority: a guest gets the plugin preload, the sandbox, and the
 *   authoritative `--plugin-id`, or it does not attach at all.
 * - `did-attach-webview` hands over the guest's own `webContents` — a distinct
 *   id from the host's, which is what preserves capability attribution by
 *   sender — but its `getURL()` is still empty at that point. The two events
 *   fire in order for one attach, so the approved src is paired across them
 *   rather than re-read from the guest.
 */

export interface GuestAttachTarget {
  guestAttachPreferences(src: string): { preload: string; pluginId: string } | null
  attachGuestContribution(src: string, guest: GuestWebContents): boolean
}

export interface GuestWebContents {
  close(): void
}

export interface MutableWebPreferences {
  preload?: string
  contextIsolation?: boolean
  nodeIntegration?: boolean
  nodeIntegrationInSubFrames?: boolean
  sandbox?: boolean
  backgroundThrottling?: boolean
  webSecurity?: boolean
  additionalArguments?: string[]
}

export interface GuestAttachHooks {
  onWillAttach(event: { preventDefault(): void }, prefs: MutableWebPreferences, params: { src?: string }): void
  onDidAttach(guest: GuestWebContents): void
}

/** Wire one host window's guest lifecycle to `manager`. */
export function createGuestAttachHooks(manager: GuestAttachTarget): GuestAttachHooks {
  // The src approved by the most recent will-attach, consumed by the
  // did-attach that follows it.
  let approvedSrc: string | null = null

  return {
    onWillAttach(event, prefs, params) {
      const src = typeof params.src === 'string' ? params.src : ''
      const approved = src ? manager.guestAttachPreferences(src) : null
      if (!approved) {
        // A src this Host never handed out — refuse rather than attach a guest
        // nothing can attribute.
        approvedSrc = null
        event.preventDefault()
        return
      }
      approvedSrc = src
      prefs.preload = approved.preload
      prefs.contextIsolation = true
      prefs.nodeIntegration = false
      prefs.nodeIntegrationInSubFrames = false
      prefs.sandbox = true
      prefs.webSecurity = true
      // Plugin views host terminals; see the main window for why throttling
      // must stay off.
      prefs.backgroundThrottling = false
      // The preload reads this to stamp calls with an id page content cannot
      // forge. Replacing the array (not appending) drops anything the renderer
      // put on the tag.
      prefs.additionalArguments = [`--plugin-id=${approved.pluginId}`]
    },

    onDidAttach(guest) {
      const src = approvedSrc
      approvedSrc = null
      if (!src || !manager.attachGuestContribution(src, guest)) guest.close()
    },
  }
}
