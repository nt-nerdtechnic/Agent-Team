// Per-pane aider chat-history files.
//
// `<git-root>/.aider.chat.history.md` is shared by every aider pane in a repo,
// and nothing in the file says which process wrote a line — so two aider panes
// in one repo permanently merge their token accounting. Aider's
// `--chat-history-file` names the file instead, and `--restore-chat-history`
// restores from whatever that flag points at, so a per-pane file removes the
// ambiguity at the source and makes resume per-pane too.
//
// The file must sit in the SAME directory the backend's aider_history_path()
// resolves to (nearest ancestor of the pane cwd containing `.git`, else the
// cwd) — that is the only place the log reader looks.

import { shellEscape } from '../../lib/drop'

/** Aider's default, pane-agnostic history file — the one every pane shared
 *  before per-pane files existed. */
export const AIDER_SHARED_HISTORY_NAME = '.aider.chat.history.md'

// The backend claims per-pane files with `^\.aider\.chat\.history\.([0-9a-f]{8})\.md$`
// and treats any other token as "no per-pane file" (legacy shared file). A
// frontend token outside that set would name a file the backend never watches,
// claims or parses — aider would write it and token accounting would silently
// read zero. Mirror the backend's degradation instead.
const PANE_TOKEN_RE = /^[0-9a-f]{8}$/

/** First 8 characters of the pane UUID, lowercased (already random hex). '' when
 *  they are not 8 hex characters — the pane then has NO per-pane file. */
export function aiderPaneToken(paneId: string): string {
  const token = paneId.slice(0, 8).toLowerCase()
  return PANE_TOKEN_RE.test(token) ? token : ''
}

/** '' when the pane has no backend-claimable token; callers must fall back to
 *  the shared file (aiderHistoryPath and resumeAiderHistoryPath both do). */
export function aiderHistoryFileName(paneId: string): string {
  const token = aiderPaneToken(paneId)
  return token ? `.aider.chat.history.${token}.md` : ''
}

/** The pane's own history file — or the legacy shared one when its id yields no
 *  claimable token. Absolute: the pane cwd may be a SUBDIRECTORY of
 *  `historyRoot`, so a relative path would resolve to the wrong place. */
export function aiderHistoryPath(historyRoot: string, paneId: string): string {
  const name = aiderHistoryFileName(paneId)
  if (!name) return sharedAiderHistoryPath(historyRoot)
  return `${historyRoot.replace(/\/+$/, '')}/${name}`
}

export function sharedAiderHistoryPath(historyRoot: string): string {
  return `${historyRoot.replace(/\/+$/, '')}/${AIDER_SHARED_HISTORY_NAME}`
}

/** Which file a RESUMING pane must be pointed at, given the history root's
 *  current entry names.
 *
 *  A pane spawned before per-pane files existed has all of its history in the
 *  shared file and owns no file of its own: handing it a per-pane path would
 *  restore nothing AND strand that history while aider starts a new file. Such
 *  a pane stays on the shared file for the rest of its life — exactly today's
 *  behaviour. A pane that owns a file gets it, and so does a pane in a repo
 *  that has neither (a fresh pane must never inherit the shared file). A pane
 *  whose id yields no claimable token can never own a file at all. */
export function resumeAiderHistoryPath(
  historyRoot: string,
  paneId: string,
  rootEntries: readonly string[]
): string {
  const own = aiderHistoryFileName(paneId)
  if (!own) return sharedAiderHistoryPath(historyRoot) // no claimable token
  if (!rootEntries.includes(own) && rootEntries.includes(AIDER_SHARED_HISTORY_NAME)) {
    return sharedAiderHistoryPath(historyRoot)
  }
  return aiderHistoryPath(historyRoot, paneId)
}

/** `--chat-history-file <quoted path>`. The command string is executed via
 *  `zsh -lc`, and real-world workspace paths contain spaces. */
export function aiderChatHistoryFlag(historyPath: string): string {
  return `--chat-history-file ${shellEscape(historyPath)}`
}

/** Lists one directory's entry names; null when it isn't listable. */
export type DirLister = (dir: string) => Promise<string[] | null>

/** The nearest ancestor of `cwd` (inclusive) containing a `.git` entry, else
 *  `cwd` itself — mirrors the backend's aider_history_path() — TOGETHER WITH
 *  that directory's entry names. The walk already lists the root, so callers
 *  that also need to know which history files exist there get the answer from
 *  the same listing instead of a second call. */
export async function resolveAiderHistoryRoot(
  cwd: string,
  listDir: DirLister
): Promise<{ root: string; entries: string[] }> {
  const base = cwd.replace(/\/+$/, '')
  if (!base) return { root: cwd, entries: [] }
  let dir = base
  let baseEntries: string[] | null = null
  while (dir) {
    const entries = await listDir(dir)
    if (baseEntries === null) baseEntries = entries ?? []
    if (entries?.includes('.git')) return { root: dir, entries }
    dir = dir.slice(0, dir.lastIndexOf('/'))
  }
  return { root: base, entries: baseEntries ?? [] }
}

// ── spec-facing entry points ────────────────────────────────────────────────
// App.vue used to hold both of these plus an `agent !== 'aider'` guard. They
// live here so the shared spawn/restore code asks the spec instead of knowing
// which vendor keeps per-pane history files.

/** ONLY the resolved root is memoized: a workspace's git root can't move while
 *  the app runs, and each probe costs one directory listing per ancestor level.
 *  The ENTRY NAMES are deliberately not cached — the per-pane history file
 *  appears the moment aider first writes it, and a stale "absent" would pin a
 *  pane to the legacy shared file for the rest of the session. */
const rootCache = new Map<string, string>()

/** Where this pane's per-pane files live: its git root, else its cwd. */
export async function paneHistoryRoot(cwd: string, listDir: DirLister): Promise<string> {
  const cached = rootCache.get(cwd)
  if (cached !== undefined) return cached
  const { root } = await resolveAiderHistoryRoot(cwd, listDir)
  rootCache.set(cwd, root)
  return root
}

/** The chat-history file this pane must RESUME from: its own, or — for a pane
 *  spawned before per-pane files existed — the legacy shared file it has been
 *  writing all along. '' when there is no cwd to resolve a root from.
 *
 *  Exactly one directory listing answers both questions: the walk-up's final
 *  listing IS the root's, and an already-resolved root needs only that listing. */
export async function resumeHistoryFile(
  workspacePath: string,
  paneId: string,
  listDir: DirLister
): Promise<string> {
  if (!workspacePath) return ''
  const cachedRoot = rootCache.get(workspacePath)
  const { root, entries } = cachedRoot === undefined
    ? await resolveAiderHistoryRoot(workspacePath, listDir)
    : { root: cachedRoot, entries: (await listDir(cachedRoot)) ?? [] }
  rootCache.set(workspacePath, root)
  return resumeAiderHistoryPath(root, paneId, entries)
}
