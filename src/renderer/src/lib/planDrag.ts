// Drag contract for dropping a plan document (from PlansPane) onto a CLI pane.
// Separate from cliContext.ts because a plan carries no pane identity or buffer
// — the terminal drop handler must tell the two drags apart by MIME type.

/** MIME type set by a PlansPane plan-row dragstart. Carries a JSON PlanDragRef. */
export const PLAN_REF_MIME = 'application/x-plan-ref'

/** A plan document referenced by a drag. `overview` is the plan goal (absent
 *  for plain docs, which have no plan-meta). */
export interface PlanDragRef {
  relPath: string
  name?: string
  overview?: string
}

/** Write the plan-ref drag payload. Kept beside the parser so the shape stays
 *  in one place. */
export function writePlanDragPayload(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  ref: PlanDragRef
): void {
  dataTransfer.setData(PLAN_REF_MIME, JSON.stringify(ref))
}

/** Parse the plan-ref drag payload. Returns null for malformed JSON or a
 *  payload without a usable relPath. */
export function parsePlanRefPayload(raw: string): PlanDragRef | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  if (typeof rec.relPath !== 'string' || !rec.relPath) return null
  return {
    relPath: rec.relPath,
    name: typeof rec.name === 'string' && rec.name ? rec.name : undefined,
    overview: typeof rec.overview === 'string' && rec.overview ? rec.overview : undefined
  }
}

/** True when a drag carries a plan reference. Reads only `types`, which stay
 *  visible during dragover even in the protected mode that hides the data. */
export function isPlanDrag(types: readonly string[] | undefined): boolean {
  return !!types && types.includes(PLAN_REF_MIME)
}

/** Text pasted into the target CLI pane's input prompt when a plan is dropped:
 *  just the plan document's workspace-relative path, so the user writes their
 *  own instruction around it. No Enter is sent — the paste waits for the user
 *  to review and submit. */
export function planDropPrompt(ref: PlanDragRef): string {
  return ref.relPath
}
