/**
 * planModel.ts
 *
 * Unified in-memory plan model shared by both plan formats:
 *   - HTML plans (`.agent-team/plans/*.html`, parsed by usePlanHtml.ts)
 *   - Markdown plans (`.plan.md`, parsed by usePlanFile.ts)
 *
 * This is the blueprint the format adapters converge on. It is a pure type
 * module (plus the two literal string tuples) — no parsing or I/O lives here.
 * The `format` field is a memory-only discriminator injected by whichever
 * adapter produced the meta; it is never persisted to disk.
 */

export const PLAN_STAGES = ['draft', 'in-review', 'approved', 'in-progress', 'done', 'abandoned'] as const
export type PlanStage = (typeof PLAN_STAGES)[number]

export const TODO_STATUSES = ['pending', 'in-progress', 'done', 'skipped'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export interface PlanTodo {
  id: string
  content: string
  status: TodoStatus
  /** Unknown fields are preserved verbatim for forward compatibility. */
  [k: string]: unknown
}
export interface ReviewNote {
  id: string
  author: 'user' | 'ai'
  text: string
  resolved: boolean
  reply: string
  /** Section anchor (outline heading text); '' when document-level. */
  anchor: string
  /** Unknown fields are preserved verbatim for forward compatibility. */
  [k: string]: unknown
}

/** One dispatch record: which agent was sent to execute the plan, and when. */
export interface PlanExecution {
  agent: string
  startedAt: string
  /** Unknown fields are preserved verbatim for forward compatibility. */
  [k: string]: unknown
}

export interface PlanMeta {
  schemaVersion: 1
  /** Memory-only, injected by the adapter; never written to disk. */
  format: 'markdown' | 'html'
  name: string
  overview: string
  stage: PlanStage
  approvedAt: string | null
  /** ISO timestamp when the plan was archived; null/absent = not archived.
   * Orthogonal to `stage` — an archived plan keeps its original stage. */
  archivedAt?: string | null
  todos: PlanTodo[]
  reviewNotes: ReviewNote[]
  /** Optional dispatch log; absent means never dispatched. */
  executions?: PlanExecution[]
  isProject?: boolean
  /** Unknown fields are preserved verbatim for forward compatibility. */
  [k: string]: unknown
}
