/**
 * Context payload injected into the Plans window's embedded CLI agent right
 * after it spawns: which plan is open, its plan-meta summary and a truncated
 * copy of the document.
 *
 * v1 built this with `buildPlanCliContext` from `@navide/plugin-shell`, a
 * Host-private module a packaged plugin may not import. The wire text is
 * restated here so the packaged window injects the same briefing; keep the two
 * in step if the v1 module changes.
 */

/** Cap on the injected document body. Plans can be long HTML files — the
 *  summary carries the essentials, the body is a best-effort excerpt. */
export const PLAN_DOC_TRUNCATE_AT = 8000

export interface PlanCliMetaSummary {
  name: string
  stage: string
  /** Todo statuses only — the contents are in the document body already. */
  todoStatuses: string[]
}

export interface PlanCliContextInput {
  workspacePath: string
  /** Workspace-relative path of the open doc; null when no document is open. */
  relPath: string | null
  /** Plan-meta summary; null for a plain document without plan meta. */
  meta: PlanCliMetaSummary | null
  /** Raw document content; null when unavailable. Truncated on injection. */
  content: string | null
}

function truncateText(text: string, at: number): string {
  return text.length <= at ? text : `${text.slice(0, at)}…[truncated]`
}

export function buildPlanCliContext(input: PlanCliContextInput): string {
  const lines: string[] = []
  lines.push(
    "You are running in a terminal embedded in Navide's Plan window, " +
      'assisting the user who is reviewing plan documents ' +
      '(.agent-team/plans/) for this workspace.',
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
    for (const status of input.meta.todoStatuses) counts.set(status, (counts.get(status) ?? 0) + 1)
    const breakdown = [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(', ')
    lines.push(
      `Todos: ${input.meta.todoStatuses.length} total${breakdown ? ` (${breakdown})` : ''}`,
    )
  }
  if (input.content !== null && input.content.length > 0) {
    lines.push('')
    lines.push(
      input.content.length > PLAN_DOC_TRUNCATE_AT
        ? 'Document content (truncated):'
        : 'Document content:',
    )
    lines.push(truncateText(input.content, PLAN_DOC_TRUNCATE_AT))
  }
  return lines.join('\n')
}
