// Builds the CLI command that resumes a prior conversation by session id, so a
// pane reloads the agent's memory on App restart.
//
// Per-vendor syntax (verified against each CLI). Every vendor supports
// resuming a known id; three also accept an id AT LAUNCH, minting the session
// when the id is unknown: claude `--session-id`, copilot `--session-id` and pi
// `--session-id`. Of those, only claude's launch pin is actually used: App.vue
// pins a fresh `--session-id` on every non-resume claude spawn so backend
// attribution binds THAT pane, and the ghost-heal path in sessionHeal.ts is
// built on it. copilot and pi could pin at launch but do not — a fresh spawn
// carries no id; they and every other vendor bind a pane to its session
// through a session marker instead (see App.vue).
// (Cursor is sometimes said to mint an id up front via `create-chat` — that is
// an unverified vendor-doc claim, unused and unimplemented here.)
// The list below is the resume syntax only:
//   • claude --resume <id>
//   • codex resume <id>      ← subcommand, NOT a --flag
//   • agy --conversation <id>
//   • grok -s <id>           ← short flag (12-hex session id)
//   • kimi --session <id>    ← id is the `session_<uuid>` dir name
//                              (short form is uppercase `-S`)
//   • opencode --session <id> ← id is `ses_`-prefixed
//   • qwen --resume <id>      ← id is a UUID (default `--resume` branch)
//   • kilo --session <id>     ← id is `ses_`-prefixed
//   • pi --session-id <id>    ← id is a UUID (creates a NEW session when the
//                                id doesn't exist, resumes when it does)
//   • copilot --resume=<id>   ← id is a UUID; NOTE the `=` form (creates a NEW
//                                session when the id doesn't exist)
//   • agent --resume=<id>     ← id is a UUID; `=` form (legacy binary name:
//                                `cursor-agent`)
//   • aider --chat-history-file <path> --restore-chat-history
//                             ← NO session ids at all; lossy restore from the
//                               pane's own chat-history file
//
// `skipFlag` is the vendor's permission-bypass flag (or "" when YOLO is off),
// appended verbatim — same flags resolveCommand() uses for a fresh launch.

import { AGENT_SPECS, REBUILD_CAPABLE_AGENTS, RESTORE_PIN_AGENTS } from '../agents'
import type { AgentSpec } from '../agents/types'

export { REBUILD_CAPABLE_AGENTS, RESTORE_PIN_AGENTS }

/** The registered spec for an agent key, if any. */
function specFor(agentKey: string): AgentSpec | undefined {
  return AGENT_SPECS.find((s) => s.agentKey === agentKey)
}

/** Canonical id accepted by the vendor resume command.
 *
 * The repair itself is per-vendor knowledge and lives in the vendor's
 * `normalizeSessionId`; a vendor that declares none keeps its id verbatim.
 */
export function normalizeResumeSessionId(agentKey: string, sessionId: string): string {
  const id = sessionId.trim()
  if (!id) return id
  return specFor(agentKey)?.normalizeSessionId?.(id) ?? id
}

/** A saved conversation is data, not permission to start a replacement. For a
 * vendor that says so, keep the record untouched when its transcript is
 * unavailable; a fresh spawn stays an explicit user action from Agent History. */
export function shouldPreserveMissingSessionOnRestore(
  agentKey: string,
  savedSessionId: string,
  canResume: boolean,
): boolean {
  return !!specFor(agentKey)?.preserveMissingSessionOnRestore
    && !!savedSessionId.trim()
    && !canResume
}

/** A prior resume that is definitively missing needs a visible fallback warning.
 * Unknown probe results retain --resume, and a preserve-on-missing vendor is
 * kept in place instead (the two are deliberately complementary). */
export function shouldWarnMissingResume(
  agentKey: string,
  savedSessionId: string,
  canResume: boolean | null,
  lastCommandWasResume: boolean,
): boolean {
  return !specFor(agentKey)?.preserveMissingSessionOnRestore
    && !!savedSessionId.trim()
    && canResume === false
    && lastCommandWasResume
}

/** Does this vendor keep its state in a per-pane home directory? */
export function usesSessionHome(agentKey: string): boolean {
  return !!specFor(agentKey)?.needsSessionHome
}

/** The stable id for this pane's per-vendor session home ("" when the vendor
 * keeps no per-pane home). `saved` is the id a restore is carrying over;
 * `paneId` is the fallback a fresh pane names its home after.
 *
 * Codex is the only such vendor: its CODEX_HOME holds the rollout a resume
 * reads back, so the home id must survive a pane id changing across restores.
 */
export function sessionHomeIdFor(
  agentKey: string,
  paneId: string,
  saved?: string | null,
): string {
  if (!usesSessionHome(agentKey)) return ''
  return (saved ?? '').trim() || paneId
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

/** Shared deadline for a terminal create RPC and the STARTING rebuild guard. */
export const TERMINAL_CREATE_TIMEOUT_MS = 30_000

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
 * PTY that is already running while its display badge still says starting.
 * Returns WHY the pane is busy so callers can confirm-through a running CLI
 * ('running') while still hard-skipping an in-flight terminal create
 * ('starting'), or false when the pane is free to rebuild. */
export function paneBusyForRebuild(
  displayStatus?: string,
  terminalStatus?: string,
  startingAgeMs?: number | null,
): 'running' | 'starting' | false {
  if (displayStatus === 'running') return 'running'
  if (displayStatus !== 'starting' || terminalStatus !== 'starting') return false
  if (startingAgeMs == null || startingAgeMs < TERMINAL_CREATE_TIMEOUT_MS) return 'starting'
  return false
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

/** `chatHistoryFile` (aider only): absolute path to the pane's own chat-history
 *  file. `--restore-chat-history` restores from whatever `--chat-history-file`
 *  points at, so passing it makes aider resume per-pane. Empty falls back to
 *  aider's default shared `<git-root>/.aider.chat.history.md`. */
export function buildResumeCommand(
  agentKey: string,
  sessionId: string,
  skipFlag = '',
  chatHistoryFile = ''
): string {
  const spec = AGENT_SPECS.find((v) => v.agentKey === agentKey)
  const flag = skipFlag.trim()
  // Id-less vendors (aider): resume args come from the spec's resumeWithoutId
  // hook and the passed id — always empty there — is ignored.
  if (spec?.resumeWithoutId) {
    const base = `${spec.defaultCommand} ${spec.resumeWithoutId(chatHistoryFile)}`
    return flag ? `${base} ${flag}` : base
  }
  const id = normalizeResumeSessionId(agentKey, sessionId)
  if (!id) return '' // no id → caller falls back to a fresh spawn
  // The binary comes from the spec's defaultCommand — never a hardcoded name
  // here. (Custom-binary overrides thread through the caller's baseCommand.)
  const base = spec?.resumeArgs
    ? `${spec.defaultCommand} ${spec.resumeArgs(id)}`
    : `${agentKey} --resume ${id}`
  return flag ? `${base} ${flag}` : base
}
