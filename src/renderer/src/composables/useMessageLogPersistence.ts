import type {
  MessageStatus,
  PersistedMessageRow,
  PersistedMessageUpdate,
} from './useAgentMessaging'

/**
 * Backend mirror for the inter-CLI message log (`agent_msg.log_*`).
 *
 * A single message walks through queued → delivering → delivered, so writing per
 * transition would be three RPCs per message. Coalesce instead, on a trailing
 * debounce, and put EVERY write — including the clear — on one serialized
 * channel: a clear fired straight out can overtake an append batch that is still
 * awaiting its response and resurrect the rows it was meant to delete.
 *
 * A factory rather than inline App.vue state so the flush/hydrate races have
 * unit tests.
 */

export const MSG_LOG_FLUSH_MS = 200

export interface MessageLogPersistenceDeps {
  /** RPC that resolves the response payload, or null on failure/timeout. */
  send: <T = unknown>(type: string, payload: Record<string, unknown>) => Promise<T | null>
  /** False while the socket is down: writes stay queued until onConnected(). */
  isConnected: () => boolean
  /** Hand a restored snapshot to the in-memory log. */
  hydrate: (rows: PersistedMessageRow[]) => void
}

export function createMessageLogPersistence(deps: MessageLogPersistenceDeps) {
  const pendingAppends = new Map<string, PersistedMessageRow>()
  const pendingUpdates = new Map<string, PersistedMessageUpdate>()
  let pendingClear: MessageStatus[] | null = null
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let flushing = false
  let hydrated = false
  let hydrating = false

  function schedule(): void {
    if (flushTimer !== undefined) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => void flush(), MSG_LOG_FLUSH_MS)
  }

  function hasPending(): boolean {
    return pendingAppends.size > 0 || pendingUpdates.size > 0 || pendingClear !== null
  }

  /** Put a failed batch back on the queue without clobbering writes made while
   *  it was in flight — the same shape the settings cache uses. */
  function requeue(rows: PersistedMessageRow[], updates: PersistedMessageUpdate[]): void {
    for (const row of rows) if (!pendingAppends.has(row.uid)) pendingAppends.set(row.uid, row)
    for (const patch of updates) {
      pendingUpdates.set(patch.uid, { ...patch, ...pendingUpdates.get(patch.uid) })
    }
    schedule()
  }

  async function flush(opts: { exiting?: boolean } = {}): Promise<void> {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    // Never two flushes in flight: the append must land before the update that
    // refers to it, and only sequential flushes guarantee that. The exit path
    // has no later flush to defer to, so it fires regardless.
    if (flushing && !opts.exiting) {
      if (hasPending()) schedule()
      return
    }
    // Not connected: keep the queue; onConnected() flushes it.
    if (!opts.exiting && !deps.isConnected()) return

    const clearKeep = pendingClear
    pendingClear = null
    const rowByUid = new Map(pendingAppends)
    const updates: PersistedMessageUpdate[] = []
    for (const [uid, patch] of pendingUpdates) {
      const row = rowByUid.get(uid)
      // A patch for a row that has not been written yet folds into that row —
      // sent on its own it would hit no matching uid and be a silent no-op.
      if (!row) {
        updates.push(patch)
        continue
      }
      if (patch.status !== undefined) row.status = patch.status
      if ('reason' in patch) row.reason = patch.reason
      if ('delivered_at' in patch) row.delivered_at = patch.delivered_at
    }
    pendingAppends.clear()
    pendingUpdates.clear()
    const rows = [...rowByUid.values()]
    if (rows.length === 0 && updates.length === 0 && clearKeep === null) return

    if (opts.exiting) {
      // beforeunload cannot await. Firing the sends still gets them onto the
      // socket in order before teardown; awaiting the append's response is what
      // used to strand the update batch this path exists to save.
      if (clearKeep) void deps.send('agent_msg.log_clear', { keep_statuses: clearKeep })
      if (rows.length > 0) void deps.send('agent_msg.log_append', { rows })
      if (updates.length > 0) void deps.send('agent_msg.log_update', { updates })
      return
    }

    flushing = true
    try {
      // The clear goes first: everything it deletes is already in the store, and
      // the writes behind it are rows it deliberately keeps.
      if (clearKeep) await deps.send('agent_msg.log_clear', { keep_statuses: clearKeep })
      if (rows.length > 0) {
        if ((await deps.send('agent_msg.log_append', { rows })) === null) {
          // Without the row in the store, every later update for that uid
          // matches nothing and is a silent no-op — retry the batch together.
          requeue(rows, updates)
          return
        }
      }
      if (updates.length > 0) {
        if ((await deps.send('agent_msg.log_update', { updates })) === null) requeue([], updates)
      }
    } finally {
      flushing = false
    }
  }

  function persistAppend(rows: PersistedMessageRow[]): void {
    for (const row of rows) pendingAppends.set(row.uid, row)
    schedule()
  }

  function persistUpdate(patches: PersistedMessageUpdate[]): void {
    for (const patch of patches) {
      pendingUpdates.set(patch.uid, { ...pendingUpdates.get(patch.uid), ...patch })
    }
    schedule()
  }

  function persistClear(keepStatuses: MessageStatus[]): void {
    // Drop the pending writes the clear would delete anyway — otherwise a late
    // append resurrects a row the user just cleared. A row's effective status is
    // its pending patch's, not the append snapshot's: one appended as `queued`
    // and patched to `delivered` in the same batch is cleared too. A row the
    // clear keeps (queued/delivering) keeps its pending write.
    for (const [uid, row] of pendingAppends) {
      const status = pendingUpdates.get(uid)?.status ?? row.status
      if (keepStatuses.includes(status)) continue
      pendingAppends.delete(uid)
      pendingUpdates.delete(uid)
    }
    pendingClear = keepStatuses
    void flush()
  }

  /** Restore the persisted log. Fails soft: a store error must never break
   *  startup — the log just starts empty and onConnected() retries. */
  async function hydrate(): Promise<void> {
    if (hydrated || hydrating) return
    hydrating = true
    try {
      const resp = await deps.send<{ rows?: PersistedMessageRow[] }>('agent_msg.log_snapshot', {})
      // null = timed out or errored. Leave `hydrated` false so the next
      // connected transition tries again — a cold start regularly needs it.
      if (resp === null) return
      hydrated = true
      deps.hydrate(resp.rows ?? [])
    } catch (err) {
      console.warn('[messaging] message log hydrate failed', err)
    } finally {
      hydrating = false
    }
  }

  /** Backend socket came up: retry a hydrate that never landed, and drain writes
   *  queued while it was down. Hydrating is once-only per window. */
  function onConnected(): void {
    void hydrate()
    void flush()
  }

  function flushOnExit(): void {
    void flush({ exiting: true })
  }

  return { persistAppend, persistUpdate, persistClear, hydrate, flush, flushOnExit, onConnected }
}
