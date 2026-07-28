// Builds the CLI command that resumes a prior conversation by session id, so a
// pane reloads the agent's memory on App restart.
//
// Per-vendor syntax (verified against each CLI; none support pinning an id at
// launch, but all support resuming a known id):
//   • claude --resume <id>
//   • codex resume <id>      ← subcommand, NOT a --flag
//   • agy --conversation <id>
//   • grok -s <id>           ← short flag (12-hex session id)
//   • kimi --session <id>    ← id is the `session_<uuid>` dir name
//   • opencode --session <id> ← id is `ses_`-prefixed
//   • qwen --resume <id>      ← id is a UUID (default `--resume` branch)
//   • kilo --session <id>     ← id is `ses_`-prefixed
//   • pi --session-id <id>    ← id is a UUID (creates a NEW session when the
//                                id doesn't exist, resumes when it does)
//   • copilot --resume=<id>   ← id is a UUID; NOTE the `=` form (creates a NEW
//                                session when the id doesn't exist)
//   • cursor-agent --resume=<id> ← id is a UUID; `=` form
//   • aider --restore-chat-history ← NO session ids at all; lossy restore from
//                                the project's .aider.chat.history.md
//
// `skipFlag` is the vendor's permission-bypass flag (or "" when YOLO is off),
// appended verbatim — same flags resolveCommand() uses for a fresh launch.

const CODEX_UUID_AT_END = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\.jsonl)?$/i

/** Canonical id accepted by the vendor resume command.
 *
 * Older Agent-Team builds could persist a Codex rollout filename/path before
 * session_meta was readable. Recover only a strict trailing UUID; arbitrary
 * Codex strings and every other vendor stay unchanged.
 */
export function normalizeResumeSessionId(agentKey: string, sessionId: string): string {
  const id = sessionId.trim()
  if (agentKey !== 'codex' || !id) return id
  return id.match(CODEX_UUID_AT_END)?.[1] ?? id
}

/** A saved Codex conversation is data, not permission to start a replacement.
 * Keep the record untouched when its rollout is unavailable; fresh spawn must
 * remain an explicit user action from Agent History.
 */
export function shouldPreserveMissingSessionOnRestore(
  agentKey: string,
  savedSessionId: string,
  canResume: boolean,
): boolean {
  return agentKey === 'codex' && !!savedSessionId.trim() && !canResume
}

/** A pane that was continuing a conversation (its last command resumed a
 * session) but whose session file is now gone falls back to a fresh pane on
 * restore. Return true to warn the user instead of silently swapping in a new
 * conversation — a resume that can't find its transcript (moved home, deleted,
 * or a transient failure under load) otherwise looks like the app lost it.
 *
 * Requires `lastCommandWasResume` so a genuinely new pane (last launched with a
 * pinned --session-id, no transcript yet) is NOT flagged. Codex is excluded:
 * it is preserved untouched (see shouldPreserveMissingSessionOnRestore), never
 * silently replaced, so it needs no warning here.
 */
export function shouldWarnMissingResume(
  agentKey: string,
  savedSessionId: string,
  canResume: boolean,
  lastCommandWasResume: boolean,
): boolean {
  return (
    agentKey !== 'codex' &&
    !!savedSessionId.trim() &&
    !canResume &&
    lastCommandWasResume
  )
}

/** Collapse restorable panes that point at the SAME conversation. Legacy
 * project.json accumulation can persist several 'spawned' records sharing one
 * session_id; restoring them concurrently spawns multiple `--resume <id>` for a
 * single conversation, which the CLI cannot share — it forks/conflicts and
 * leaks processes. Keep the first record per (agent, session_id). Panes with no
 * session_id (genuinely fresh) are independent and always kept. Order preserved.
 */
export function dedupeRestorablePanes<T extends { agent?: string; session_id?: string }>(
  panes: T[],
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const p of panes) {
    const id = normalizeResumeSessionId(p.agent ?? '', (p.session_id ?? '').trim())
    if (!id) {
      out.push(p) // no session → independent fresh pane, never merged
      continue
    }
    const key = `${p.agent ?? ''} ${id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/** CLIs whose panes can be re-spawned via `<cli> --resume <id>`. Aider is
 * excluded: it has no session ids, so paneCanRebuild's pinnedSessionId +
 * sessionOnDisk gates (set only by session.detected / resume spawns) can
 * never be satisfied — the button would render permanently disabled. */
export const REBUILD_CAPABLE_AGENTS = ['claude', 'codex', 'antigravity', 'grok', 'kimi', 'opencode', 'qwen', 'kilo', 'pi', 'copilot', 'cursor']

/** Shared deadline for a terminal create RPC and the STARTING rebuild guard. */
export const TERMINAL_CREATE_TIMEOUT_MS = 30_000

/** CLIs whose panes may keep the SAVED session id pinned when a restore
 * spawns them fresh (spawn opt sessionKnownOnDisk) so the Rebuild button
 * stays enabled. Restricted to agents whose stale restore-pin reliably
 * self-heals to the pane's real session once one exists: claude (the turn
 * event's attributed id is adopted directly for restore pins) and codex
 * (per-pane CODEX_HOME announces the new session deterministically). Grok
 * binds only via a typed marker — a roleless restored pane never types one —
 * and antigravity/kimi fall back to a single-unclaimed-candidate heuristic
 * that fails with 2+ same-vendor panes in one cwd; their stale pin could
 * never heal, and Rebuild would swap the user's live conversation for the
 * abandoned pre-restart one. Those agents keep the pre-existing behavior:
 * button disabled until session.detected. */
export const RESTORE_PIN_AGENTS = ['claude', 'codex']

/** Whether the Rebuild (resume) button is RENDERED for a pane. Purely by
 * agentKey, so a resume-capable pane shows the button from spawn (disabled
 * until it becomes rebuildable) for discoverability. Non-resumable agents
 * (e.g. plain terminal) never render it. */
export function paneRebuildVisible(pane: { agentKey: string }): boolean {
  return REBUILD_CAPABLE_AGENTS.includes(pane.agentKey)
}

/** Whether the Rebuild (resume) button is ENABLED: a transcript for the pane's
 * session must exist on disk. Every resumable CLI needs both a pinned session
 * id AND the sessionOnDisk flag:
 *  - claude pins `--session-id` at spawn, before any transcript is written, so
 *    the id alone is not enough — the flag is set on resume spawns, on the
 *    first claude turn event, and on session.detected.
 *  - the other CLIs only ever receive pinnedSessionId together with the flag
 *    (resume spawn or session.detected), so requiring both leaves their
 *    enable timing unchanged.
 */
export function paneCanRebuild(pane: {
  agentKey: string
  pinnedSessionId?: string
  sessionOnDisk?: boolean
}): boolean {
  if (!pane.pinnedSessionId) return false
  if (!pane.sessionOnDisk) return false
  return REBUILD_CAPABLE_AGENTS.includes(pane.agentKey)
}

/** Protect active work and terminal creation, but allow rebuilding a silent
 * PTY that is already running while its display badge still says starting. */
export function paneBusyForRebuild(
  displayStatus?: string,
  terminalStatus?: string,
  startingAgeMs?: number | null,
): boolean {
  if (displayStatus === 'running') return true
  if (displayStatus !== 'starting' || terminalStatus !== 'starting') return false
  return startingAgeMs == null || startingAgeMs < TERMINAL_CREATE_TIMEOUT_MS
}

/** Acquire every rebuild identity atomically; null means another rebuild owns one. */
export function acquirePaneRebuildLock(
  locks: Set<string>,
  keys: string[],
): (() => void) | null {
  if (keys.some((key) => locks.has(key))) return null
  for (const key of keys) locks.add(key)
  return () => { for (const key of keys) locks.delete(key) }
}

/** Wait for rollback only when raw STARTING has reached the create deadline. */
export async function cancelStalePendingCreate(
  terminalStatus: string | undefined,
  startingAgeMs: number | null | undefined,
  cancel: (() => Promise<void>) | undefined,
): Promise<void> {
  if (
    terminalStatus === 'starting' &&
    startingAgeMs != null &&
    startingAgeMs >= TERMINAL_CREATE_TIMEOUT_MS
  ) {
    await cancel?.()
  }
}

export function buildResumeCommand(
  agentKey: string,
  sessionId: string,
  skipFlag = ''
): string {
  // Aider has no session ids: resume is always the lossy
  // `--restore-chat-history` (reads the project's .aider.chat.history.md),
  // so the passed id — always empty for aider — is ignored.
  if (agentKey === 'aider') {
    const aiderFlag = skipFlag.trim()
    return aiderFlag
      ? `aider --restore-chat-history ${aiderFlag}`
      : 'aider --restore-chat-history'
  }
  const id = normalizeResumeSessionId(agentKey, sessionId)
  if (!id) return '' // no id → caller falls back to a fresh spawn
  const base =
    agentKey === 'codex'
      ? `codex resume ${id}`
      : agentKey === 'antigravity'
        ? `agy --conversation ${id}`
        : agentKey === 'grok'
          ? `grok -s ${id}`
          : agentKey === 'kimi'
            ? `kimi --session ${id}`
            : agentKey === 'opencode'
              ? `opencode --session ${id}`
              : agentKey === 'kilo'
                ? `kilo --session ${id}`
                : agentKey === 'pi'
                  ? `pi --session-id ${id}`
                  : agentKey === 'copilot'
                    ? `copilot --resume=${id}`
                    : agentKey === 'cursor'
                      ? `cursor-agent --resume=${id}`
      : `${agentKey} --resume ${id}`
  const flag = skipFlag.trim()
  return flag ? `${base} ${flag}` : base
}
