/**
 * pmAiContext.ts
 *
 * Pure helper for the Pipeline Manager window's embedded CLI terminal: the
 * context payload injected right after a fresh spawn (a short situating
 * preamble plus a snapshot of what the user is looking at and a roles
 * summary). Generic CLI-dock helpers (command assembly, bracketed paste,
 * truncation) live in aiCliContext.ts.
 */

import { truncateText } from './aiCliContext'

export interface PmAiPipelineSummary {
  name: string
  stageCount: number
  isDefault: boolean
}

export interface PmAiRoleSummary {
  key: string
  label: string
  oneLine: string
}

export interface PmAiContextInput {
  workspacePath: string
  /** Name of the pipeline open in the detail view; null in the list view. */
  pipelineName: string | null
  /** stageToBackend() serializations of the open pipeline's stages (detail view). */
  stages: Record<string, unknown>[]
  /** All pipelines — the snapshot shown when no pipeline detail is open. */
  pipelines: PmAiPipelineSummary[]
  /** Roles summary. Full system prompts are deliberately omitted (token cost). */
  roles: PmAiRoleSummary[]
}

/** Per-slot kickoff_body cap inside the injected stages JSON. Long pipelines
 *  carry full kickoff prompts in every slot — without a cap the paste can grow
 *  to a huge blob the CLI has to chew through before it is usable. */
export const KICKOFF_TRUNCATE_AT = 300

function truncateKickoffBodies(stages: Record<string, unknown>[]): Record<string, unknown>[] {
  return stages.map((stage) => {
    const slots = stage.slots
    if (!Array.isArray(slots)) return stage
    return {
      ...stage,
      slots: slots.map((slot) => {
        if (slot === null || typeof slot !== 'object') return slot
        const body = (slot as Record<string, unknown>).kickoff_body
        if (typeof body !== 'string' || body.length <= KICKOFF_TRUNCATE_AT) return slot
        return {
          ...(slot as Record<string, unknown>),
          kickoff_body: truncateText(body, KICKOFF_TRUNCATE_AT),
        }
      }),
    }
  })
}

export function buildPmAiContext(input: PmAiContextInput): string {
  const lines: string[] = []
  lines.push(
    "You are running in a terminal embedded in Navide's Pipeline Manager window, " +
      'assisting the user who is editing multi-agent pipelines (ordered stages ' +
      'with agent/role slots) and role definitions.'
  )
  lines.push(`Workspace: ${input.workspacePath}`)
  lines.push('')
  if (input.pipelineName !== null) {
    lines.push(`Currently open pipeline: "${input.pipelineName}" — stages JSON:`)
    lines.push(JSON.stringify(truncateKickoffBodies(input.stages), null, 2))
  } else {
    lines.push('Pipelines:')
    if (input.pipelines.length === 0) lines.push('(none)')
    for (const p of input.pipelines) {
      const stages = `${p.stageCount} stage${p.stageCount === 1 ? '' : 's'}`
      lines.push(`- ${p.name} (${stages})${p.isDefault ? ' [default]' : ''}`)
    }
  }
  lines.push('')
  lines.push('Roles (key: label — one-line description; full system prompts omitted):')
  if (input.roles.length === 0) lines.push('(none)')
  for (const r of input.roles) {
    lines.push(`- ${r.key}: ${r.label}${r.oneLine ? ` — ${r.oneLine}` : ''}`)
  }
  return lines.join('\n')
}
