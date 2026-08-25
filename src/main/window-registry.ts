import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Crash-restore registry: continuously persists which workspace windows are
// open so an unexpected exit (crash, kill -9, power loss) can be detected on
// the next launch and offered for restore. A clean quit marks `cleanExit`;
// a crash never gets the chance — that asymmetry IS the detector.
//
// The same file also carries a per-workspace restore failure ledger: a
// workspace whose filesystem wedges the backend would otherwise be restored,
// wedge the backend again, and loop forever (issue #24). See beginRestore().
//
// Only app-level window state lives here. Per-workspace pane state (and CLI
// session resume) is already persisted in each workspace's .agent-team/
// project.json and restored by the renderer when the workspace loads — this
// registry only needs to get the windows back on screen.

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowEntry {
  workspace_path: string
  bounds?: WindowBounds
  /** Run group this window was detached for, when it is a detached child
   *  rather than a main window. Recorded so a detached group comes back
   *  detached instead of silently folding into the main window on relaunch. */
  detached_group?: string
  /** Workspaces this window took on from its sidebar beyond `workspace_path`.
   *  Restored with it, so a window that was running three projects comes back
   *  running three projects rather than one. */
  adopted_workspaces?: string[]
}

export interface RegistryDoc {
  version: 1
  cleanExit: boolean
  windows: WindowEntry[]
  /** Windows open at the last clean exit — the auto-restore snapshot. Kept
   *  separate from `windows` (live tracking) so the per-window remove() calls
   *  during the quit sequence can't wipe it. */
  snapshot: WindowEntry[]
  /** User setting: reopen the last clean-exit windows on next launch. */
  restoreOnLaunch: boolean
  /** Consecutive restore attempts charged to each workspace path that the
   *  backend never survived. Cleared once the backend proves stable. */
  restoreFailures: Record<string, number>
}

/** Restore attempts a single workspace may cost before it is left unrestored.
 *  Matches backend-autorestart's attempt budget: three tries, then stop. */
export const MAX_RESTORE_ATTEMPTS = 3

/** The outcome of beginRestore(): what to open, and what was left alone. */
export interface RestorePlan {
  restore: WindowEntry[]
  skipped: WindowEntry[]
}

/** Keep only well-formed workspace entries (used for both windows and snapshot). */
function sanitizeEntries(list: unknown): WindowEntry[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((w: unknown): w is WindowEntry =>
      typeof w === 'object' && w !== null && typeof (w as WindowEntry).workspace_path === 'string'
      && (w as WindowEntry).workspace_path.length > 0)
    .map((w: WindowEntry) => ({
      workspace_path: w.workspace_path,
      ...(w.bounds ? { bounds: w.bounds } : {}),
      ...(typeof w.detached_group === 'string' && w.detached_group
        ? { detached_group: w.detached_group }
        : {})
    }))
}

/** Keep only well-formed ledger entries: workspace path → positive attempt count. */
function sanitizeFailures(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [path, count] of Object.entries(value as Record<string, unknown>)) {
    if (!path) continue
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) continue
    out[path] = Math.floor(count)
  }
  return out
}

/** Parse a registry file's text, tolerating missing/corrupt content. */
export function parseRegistryDoc(text: string | null): RegistryDoc {
  const empty: RegistryDoc = {
    version: 1, cleanExit: true, windows: [], snapshot: [], restoreOnLaunch: true, restoreFailures: {},
  }
  if (!text) return empty
  try {
    const data = JSON.parse(text)
    if (typeof data !== 'object' || data === null || !Array.isArray(data.windows)) return empty
    return {
      version: 1,
      cleanExit: data.cleanExit === true,
      windows: sanitizeEntries(data.windows),
      snapshot: sanitizeEntries(data.snapshot),
      // Missing/undefined defaults to true (feature on); only explicit false disables.
      restoreOnLaunch: data.restoreOnLaunch !== false,
      // Missing key (doc written before the breaker existed) → empty ledger.
      restoreFailures: sanitizeFailures(data.restoreFailures),
    }
  } catch {
    return empty
  }
}

/** The windows to offer for restore, or null when the last exit was clean
 *  (or nothing restorable was open). */
export function pendingFromDoc(doc: RegistryDoc): WindowEntry[] | null {
  if (doc.cleanExit) return null
  return doc.windows.length ? doc.windows : null
}

export class WindowRegistry {
  private entries = new Map<number, WindowEntry>()
  private cleanExit = false
  private snapshot: WindowEntry[] = []
  private restoreOnLaunch = true
  private lastCleanRestore: WindowEntry[] = []
  private restoreFailures = new Map<string, number>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  // Accepts a path PROVIDER so the location can be resolved lazily: the dev
  // build re-points userData (…-dev suffix) after this module is imported, so
  // capturing app.getPath('userData') at construction would hit the wrong dir.
  constructor(private filePathOrFn: string | (() => string)) {}

  private get filePath(): string {
    return typeof this.filePathOrFn === 'function' ? this.filePathOrFn() : this.filePathOrFn
  }

  /** Read the previous run's doc, compute its restorable windows, then reset
   *  the file to this run's (empty, dirty) state. Call once at startup, after
   *  the single-instance lock is held. */
  readPendingAndReset(): WindowEntry[] | null {
    let text: string | null = null
    try { text = readFileSync(this.filePath, 'utf-8') } catch { /* first run */ }
    const doc = parseRegistryDoc(text)
    // Preserve the user setting across the reset, and capture the clean-exit
    // auto-restore list NOW — before persistNow() wipes the file to this run's
    // empty state. Crash pending and clean-exit restore are mutually exclusive:
    // cleanExit gates which one is non-empty.
    this.restoreOnLaunch = doc.restoreOnLaunch
    // The failure ledger must also survive the reset — it is the only record
    // that the previous launch charged a workspace an attempt it never
    // finished paying off.
    this.restoreFailures = new Map(Object.entries(doc.restoreFailures))
    this.lastCleanRestore = (doc.cleanExit && doc.restoreOnLaunch) ? doc.snapshot : []
    const pending = pendingFromDoc(doc)
    this.persistNow()
    return pending
  }

  /** Windows to auto-restore after a clean exit. Valid only after
   *  readPendingAndReset() has run; empty if the last exit wasn't clean, the
   *  setting is off, or nothing was open. */
  cleanExitRestore(): WindowEntry[] {
    return this.lastCleanRestore
  }

  /** Charge every candidate workspace one restore attempt BEFORE any window is
   *  created, then split the list into what may be opened and what has burned
   *  its budget. The charge is persisted immediately and on purpose: a
   *  workspace on a wedged filesystem can hang the backend hard enough that
   *  this launch never exits cleanly, so a counter written only on success
   *  could never fire. The increment on disk is the whole mechanism —
   *  clearRestoreFailures() is what pays it back.
   *
   *  `userInitiated` marks an explicit user action (the crash-restore banner's
   *  Apply): consent overrides the skip, and resets that workspace's tally so
   *  asking for a workspace can never leave the user locked out of it. */
  beginRestore(entries: WindowEntry[], opts?: { userInitiated?: boolean }): RestorePlan {
    const userInitiated = opts?.userInitiated === true
    const plan: RestorePlan = { restore: [], skipped: [] }
    for (const entry of entries) {
      const failures = userInitiated ? 0 : (this.restoreFailures.get(entry.workspace_path) ?? 0)
      if (failures >= MAX_RESTORE_ATTEMPTS) {
        plan.skipped.push(entry)
        continue
      }
      this.restoreFailures.set(entry.workspace_path, failures + 1)
      plan.restore.push(entry)
    }
    this.persistNow()
    return plan
  }

  /** Wipe the ledger: the backend has stayed up long enough to prove the
   *  restored workspaces did not kill it. Driven by backend-autorestart's
   *  stability window, so there is only one notion of "healthy" in the app. */
  clearRestoreFailures(): void {
    if (this.restoreFailures.size === 0) return
    this.restoreFailures.clear()
    this.persistNow()
  }

  /** Attempts currently charged to each workspace (diagnostics/tests). */
  restoreFailureCounts(): Record<string, number> {
    return Object.fromEntries(this.restoreFailures)
  }

  /** Record/replace the workspace for a window; empty path (back to Welcome)
   *  removes the entry — a workspace-less window isn't worth restoring. */
  setWorkspace(winId: number, workspacePath: string): void {
    if (!workspacePath) {
      this.entries.delete(winId)
    } else {
      const prev = this.entries.get(winId)
      this.entries.set(winId, {
        workspace_path: workspacePath,
        ...(prev?.bounds ? { bounds: prev.bounds } : {}),
        ...(prev?.detached_group ? { detached_group: prev.detached_group } : {}),
        ...(prev?.adopted_workspaces?.length
          ? { adopted_workspaces: prev.adopted_workspaces }
          : {})
      })
    }
    this.persistNow()
  }

  /** Mark a tracked window as the detached view of one run group.
   *
   *  Kept separate from setWorkspace because the two arrive independently:
   *  the renderer reports its workspace, main knows which group it detached.
   *  A window with no entry yet is ignored — setWorkspace lands first and the
   *  detach path re-states it right after. */
  setDetachedGroup(winId: number, groupId: string): void {
    const entry = this.entries.get(winId)
    if (!entry) return
    if (groupId) entry.detached_group = groupId
    else delete entry.detached_group
    this.persistNow()
  }

  /** Record the workspaces a window has taken on beyond its own.
   *
   *  Like setDetachedGroup: the renderer reports this independently of the
   *  workspace, and a window with no entry yet is ignored — a Welcome window
   *  has nothing to adopt into. */
  setAdoptedWorkspaces(winId: number, paths: string[]): void {
    const entry = this.entries.get(winId)
    if (!entry) return
    if (paths.length) entry.adopted_workspaces = [...paths]
    else delete entry.adopted_workspaces
    this.persistNow()
  }

  setBounds(winId: number, bounds: WindowBounds): void {
    const entry = this.entries.get(winId)
    if (!entry) return // Welcome window — not tracked
    entry.bounds = bounds
    this.persistDebounced()
  }

  remove(winId: number): void {
    if (!this.entries.delete(winId)) return
    this.persistNow()
  }

  /** Mark this run as a clean exit. Synchronous — called from before-quit. */
  markCleanExit(): void {
    this.cleanExit = true
    // Freeze the currently-open windows so the per-window remove() calls that
    // follow during the quit sequence can't empty the restore snapshot.
    this.snapshot = [...this.entries.values()]
    this.persistNow()
  }

  getRestoreOnLaunch(): boolean {
    return this.restoreOnLaunch
  }

  setRestoreOnLaunch(value: boolean): void {
    this.restoreOnLaunch = value
    this.persistNow()
  }

  private doc(): RegistryDoc {
    return {
      version: 1,
      cleanExit: this.cleanExit,
      windows: [...this.entries.values()],
      snapshot: this.snapshot,
      restoreOnLaunch: this.restoreOnLaunch,
      restoreFailures: Object.fromEntries(this.restoreFailures),
    }
  }

  private persistNow(): void {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      // Atomic: write a sibling tmp file then rename over the target, so a
      // crash mid-write can't leave a truncated doc (parse falls back anyway).
      const tmp = join(dirname(this.filePath), '.open-windows.json.tmp')
      writeFileSync(tmp, JSON.stringify(this.doc(), null, 2), 'utf-8')
      renameSync(tmp, this.filePath)
    } catch {
      // Best-effort: a failed persist only costs restore fidelity, never the app.
    }
  }

  // Bounds updates fire on every move/resize tick — coalesce them.
  private persistDebounced(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persistNow() }, 500)
  }
}
