// Request/reply relay behind ipcMain.handle('pane:action'), extracted so it can
// be unit-tested without an Electron runtime (same pattern as
// cli-buffer-relay.ts). The Resource Manager window lists every CLI this app is
// running, whichever window each belongs to, and offers two actions on a row —
// jump to it, or reclaim it. Both only exist in the window that owns the pane,
// so the main process fans the request out to every main-window webContents
// with a correlation id and resolves with the first window that claims it.

export const PANE_ACTION_REQUEST_CHANNEL = 'pane:action:request'
export const PANE_ACTION_REPLY_CHANNEL = 'pane:action:reply'

/** What a row can ask for. `reclaim` runs the same guards the status-bar
 *  reclaim does, so a pane that is busy answers `blocked` rather than dying. */
export type PaneActionKind = 'focus' | 'reclaim'

export interface PaneActionResult {
  ok?: boolean
  /** Set by the owning window when the action was a jump: main brings that
   *  window forward, which the renderer cannot do for itself. */
  focused?: boolean
  /** `not-found` means no window owns this pane; `blocked` means its owner
   *  refused (a running or focused pane is not reclaimable). */
  error?: 'unavailable' | 'timeout' | 'not-found' | 'blocked'
}

/** webContents-shaped send target (kept structural for tests). */
export interface PaneActionRelayTarget {
  send(channel: string, requestId: string, paneId: string, action: PaneActionKind): void
}

interface PendingRequest {
  resolve: (result: PaneActionResult) => void
  /** Windows that have not replied yet — all replying not-found ⇒ not-found. */
  remaining: number
  timer: ReturnType<typeof setTimeout>
}

export class PaneActionRelay {
  private pending = new Map<string, PendingRequest>()
  private seq = 0

  /** Fan the request out to `targets`; resolves with the first window that
   *  owns the pane (whether it acted or refused), `not-found` once every
   *  window disowned it, `unavailable` when there is no window to ask, or
   *  `timeout`. */
  request(
    targets: PaneActionRelayTarget[],
    paneId: string,
    action: PaneActionKind,
    timeoutMs = 3000
  ): Promise<PaneActionResult> {
    if (targets.length === 0) return Promise.resolve({ error: 'unavailable' })
    const requestId = `pane-act-${++this.seq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ error: 'timeout' })
      }, timeoutMs)
      this.pending.set(requestId, { resolve, remaining: targets.length, timer })
      for (const target of targets) {
        target.send(PANE_ACTION_REQUEST_CHANNEL, requestId, paneId, action)
      }
    })
  }

  /** Feed a renderer reply back in (wired to PANE_ACTION_REPLY_CHANNEL). */
  handleReply(requestId: string, result: PaneActionResult): void {
    const entry = this.pending.get(requestId)
    if (!entry) return // already resolved or timed out
    // Only `not-found` is a disowning. Any other answer came from the window
    // that owns the pane, and it is the answer — waiting for the rest would
    // turn a legitimate "blocked" into a timeout.
    if (result.error !== 'not-found') {
      clearTimeout(entry.timer)
      this.pending.delete(requestId)
      entry.resolve(result)
      return
    }
    entry.remaining -= 1
    if (entry.remaining <= 0) {
      clearTimeout(entry.timer)
      this.pending.delete(requestId)
      entry.resolve({ error: 'not-found' })
    }
  }
}
