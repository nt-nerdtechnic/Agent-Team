import type { UpdateState } from '../../../shared/updater'

/**
 * The updater's three stages, derived from its status.
 *
 * The backend is a single status enum, but the user's model of updating is a
 * pipeline — check, then download, then install — and each stage has its own
 * settings. Deriving the pipeline here (rather than in the template) keeps that
 * mapping testable and stops the panel from restating it per element.
 */
export type UpdateStageId = 'check' | 'download' | 'install'
export type UpdateStageState = 'pending' | 'active' | 'done' | 'failed'

export interface UpdateStage {
  id: UpdateStageId
  state: UpdateStageState
  /** Transfer progress, on the download stage while it is active. */
  percent?: number
}

const ORDER: readonly UpdateStageId[] = ['check', 'download', 'install']

/**
 * Stages for the current state, in order. Empty when there is no pipeline to
 * show (a build without updates) — the caller renders nothing rather than an
 * inert rail.
 *
 * `lastCheckFailure` deliberately does NOT mark the check stage failed: a run
 * of failed *background* checks rides alongside whatever the visible status is
 * and already has its own diagnostic line. Turning the rail red for it would
 * claim the current, possibly successful, foreground state had failed.
 */
export function updateStages(state: UpdateState): UpdateStage[] {
  if (state.status === 'unsupported') return []

  const build = (states: Record<UpdateStageId, UpdateStageState>, percent?: number): UpdateStage[] =>
    ORDER.map((id) => (id === 'download' && percent !== undefined
      ? { id, state: states[id], percent }
      : { id, state: states[id] }))

  switch (state.status) {
    case 'checking':
      return build({ check: 'active', download: 'pending', install: 'pending' })
    case 'not-available':
      return build({ check: 'done', download: 'pending', install: 'pending' })
    case 'available':
      return build({ check: 'done', download: 'pending', install: 'pending' })
    case 'downloading':
      return build(
        { check: 'done', download: 'active', install: 'pending' },
        Math.max(0, Math.min(100, Math.round(state.percent ?? 0))),
      )
    case 'downloaded':
      return build({ check: 'done', download: 'done', install: 'pending' })
    case 'installing':
      return build({ check: 'done', download: 'done', install: 'active' })
    case 'error':
      // Which stage broke is not in the status, but a version is only known
      // once a check has succeeded — so an error carrying one belongs to the
      // download that followed it.
      return state.availableVersion
        ? build({ check: 'done', download: 'failed', install: 'pending' })
        : build({ check: 'failed', download: 'pending', install: 'pending' })
    default:
      return build({ check: 'pending', download: 'pending', install: 'pending' })
  }
}
