import { describe, expect, it } from 'vitest'
import { updateStages } from '../updaterStages'
import type { UpdateState } from '../../../../shared/updater'

function state(over: Partial<UpdateState>): UpdateState {
  return { status: 'idle', currentVersion: '1.0.0', ...over }
}

const shape = (s: UpdateState): string =>
  updateStages(s).map((stage) => `${stage.id}:${stage.state}`).join(' ')

describe('updateStages', () => {
  it('renders nothing for a build without updates', () => {
    expect(updateStages(state({ status: 'unsupported' }))).toEqual([])
  })

  it('walks the pipeline forward as the status advances', () => {
    expect(shape(state({ status: 'idle' }))).toBe('check:pending download:pending install:pending')
    expect(shape(state({ status: 'checking' }))).toBe('check:active download:pending install:pending')
    expect(shape(state({ status: 'available', availableVersion: '1.1.0' })))
      .toBe('check:done download:pending install:pending')
    expect(shape(state({ status: 'downloading', percent: 40 })))
      .toBe('check:done download:active install:pending')
    expect(shape(state({ status: 'downloaded' }))).toBe('check:done download:done install:pending')
    expect(shape(state({ status: 'installing' }))).toBe('check:done download:done install:active')
  })

  it('reports being up to date as a finished check, not a finished pipeline', () => {
    // Nothing was downloaded or installed, so those stages must not read done.
    expect(shape(state({ status: 'not-available' })))
      .toBe('check:done download:pending install:pending')
  })

  it('carries clamped download progress on the download stage only', () => {
    const stages = updateStages(state({ status: 'downloading', percent: 62.4 }))
    expect(stages.find((s) => s.id === 'download')?.percent).toBe(62)
    expect(stages.find((s) => s.id === 'check')?.percent).toBeUndefined()
    expect(updateStages(state({ status: 'downloading', percent: 140 }))[1].percent).toBe(100)
    expect(updateStages(state({ status: 'downloading', percent: -5 }))[1].percent).toBe(0)
    expect(updateStages(state({ status: 'downloading' }))[1].percent).toBe(0)
  })

  it('blames the download when the error carries a version', () => {
    // A version is only known after a check succeeded, so the failure is later.
    expect(shape(state({ status: 'error', availableVersion: '1.1.0', message: 'ECONNRESET' })))
      .toBe('check:done download:failed install:pending')
  })

  it('blames the check when the error has no version to show', () => {
    expect(shape(state({ status: 'error', message: 'feed unreachable' })))
      .toBe('check:failed download:pending install:pending')
  })

  it('does not turn the rail red for a run of failed background checks', () => {
    // Those have their own diagnostic line; the visible status here succeeded.
    const withFailures = state({
      status: 'not-available',
      lastCheckFailure: { message: 'offline', count: 5, at: '2026-01-01T00:00:00.000Z' },
    })
    expect(shape(withFailures)).toBe('check:done download:pending install:pending')
  })

  it('always returns the three stages in pipeline order', () => {
    for (const status of ['idle', 'checking', 'available', 'downloading', 'downloaded', 'installing', 'error'] as const) {
      expect(updateStages(state({ status })).map((s) => s.id)).toEqual(['check', 'download', 'install'])
    }
  })
})
