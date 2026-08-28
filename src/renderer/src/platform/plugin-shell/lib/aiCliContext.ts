/**
 * aiCliContext.ts
 *
 * Shared pure helpers for embedded CLI agent terminals (the AiCliDock module):
 * spawn command assembly, the bracketed-paste envelope used for context
 * injection, a generic truncation helper, and the Plan window's context
 * builder. Window-specific context builders that need their own domain types
 * (e.g. the Pipeline Manager's) live next to their window instead.
 */

import { CLI_AGENT_SPECS } from '../agents'
import { parseCliPermissionMode, skipPermissionFlagFor } from './cliPermission'

/** Wrap text in a bracketed-paste envelope so TUI CLIs treat it as one paste
 *  (inserted literally, not interpreted keystroke-by-keystroke). */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

/** Pane id for an embedded AI CLI terminal, unique per (surface, workspace).
 *
 *  A fixed per-surface id breaks down the moment two windows of the same
 *  surface coexist on different workspaces (e.g. two Plan windows): they share
 *  the same localStorage terminal-pty key, so window B's connect-time
 *  tryReattach steals window A's PTY and B's Start reaps A's running CLI via
 *  replaces_terminal_id. Deriving the id from the workspace path keeps each
 *  window on its own PTY, and a workspace re-point lands on a fresh id.
 *
 *  The first 8 chars are a 32-bit FNV-1a hash of the workspace path rendered
 *  as 8 hex digits — aider's per-pane chat-history file name is derived from
 *  paneId.slice(0, 8) and the backend only claims 8-hex tokens, so the prefix
 *  MUST stay pure hex. */
export function aiTerminalPaneId(surface: string, workspacePath: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < workspacePath.length; i++) {
    hash ^= workspacePath.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  const hex8 = (hash >>> 0).toString(16).padStart(8, '0')
  return `${hex8}-${surface}-ai-terminal`
}

/** Truncate `text` to `at` characters, marking the cut. Used to cap injected
 *  payload fragments so the CLI is not buried under a huge startup paste. */
export function truncateText(text: string, at: number): string {
  return text.length <= at ? text : text.slice(0, at) + '…[truncated]'
}

/** Simplified App.vue resolveCommand for embedded CLI dock panels: spec default
 *  command + per-pane arg (aider chat-history isolation) + YOLO skip-permission
 *  flag. There is no user command-override UI here, and the frontend binary
 *  override is deliberately skipped — the backend backstops binary resolution.
 *
 *  `yoloStored` is the raw 'agentTeam.yolo' setting value: '1'/'0', or null
 *  when unset → defaults ON, mirroring App.vue's makeStickyBool semantics.
 *  `permissionStored` is the raw per-vendor override (see cliPermission.ts);
 *  null/absent means 'inherit'. */
export function resolveCliCommand(input: {
  agentKey: string
  paneId: string
  /** Directory the per-pane files live in — the panel's workspace path. */
  historyRoot: string
  yoloStored: string | null
  permissionStored?: string | null
}): string {
  const spec = CLI_AGENT_SPECS.find((s) => s.agentKey === input.agentKey)
  const parts = [spec?.defaultCommand || input.agentKey]
  const paneArg = spec?.paneArg
    ? spec.paneArg({ paneId: input.paneId, historyRoot: input.historyRoot })
    : ''
  if (paneArg) parts.push(paneArg)
  const skipFlag = skipPermissionFlagFor({
    spec,
    globalYolo: input.yoloStored === null ? true : input.yoloStored === '1',
    mode: parseCliPermissionMode(input.permissionStored)
  })
  if (skipFlag) parts.push(skipFlag)
  return parts.join(' ')
}

// ── Plan window context ──────────────────────────────────────────────────────

/** Cap on the injected plan document content. Plans can be long HTML files —
 *  the summary (name/stage/todos) carries the essentials, the body is a
 *  best-effort excerpt. */
export const PLAN_DOC_TRUNCATE_AT = 8000

export interface PlanCliMetaSummary {
  name: string
  stage: string
  /** Todo statuses only — content is in the document body already. */
  todoStatuses: string[]
}

export interface PlanCliContextInput {
  workspacePath: string
  /** Workspace-relative path of the open doc; null when no document is open. */
  relPath: string | null
  /** Parsed plan-meta summary; null for plain docs without plan meta. */
  meta: PlanCliMetaSummary | null
  /** Raw document content; null when unavailable. Truncated on injection. */
  content: string | null
}

/** Context payload injected after a fresh spawn in the Plan window: the open
 *  plan document's path, its plan-meta summary (name / stage / todo status
 *  counts) and truncated content, plus the workspace. */
export function buildPlanCliContext(input: PlanCliContextInput): string {
  const lines: string[] = []
  lines.push(
    "You are running in a terminal embedded in Navide's Plan window, " +
      'assisting the user who is reviewing plan documents ' +
      '(.agent-team/plans/) for this workspace.'
  )
  lines.push(`Workspace: ${input.workspacePath}`)
  lines.push('')
  if (input.relPath === null) {
    lines.push('No plan document is currently open.')
    return lines.join('\n')
  }
  lines.push(`Currently open document: ${input.relPath}`)
  if (input.meta !== null) {
    lines.push(`Plan name: ${input.meta.name}`)
    lines.push(`Stage: ${input.meta.stage}`)
    const counts = new Map<string, number>()
    for (const s of input.meta.todoStatuses) counts.set(s, (counts.get(s) ?? 0) + 1)
    const breakdown = [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(', ')
    lines.push(
      `Todos: ${input.meta.todoStatuses.length} total${breakdown ? ` (${breakdown})` : ''}`
    )
  }
  if (input.content !== null && input.content.length > 0) {
    lines.push('')
    lines.push(
      input.content.length > PLAN_DOC_TRUNCATE_AT
        ? 'Document content (truncated):'
        : 'Document content:'
    )
    lines.push(truncateText(input.content, PLAN_DOC_TRUNCATE_AT))
  }
  return lines.join('\n')
}
