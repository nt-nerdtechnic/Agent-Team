import { describe, expect, it } from 'vitest'
import {
  cpuPercent,
  formatCpuPercent,
  RESOURCE_POLL_ACTIVE_MS,
  RESOURCE_POLL_IDLE_MS,
  resourcePollIntervalMs,
} from '../resourceSampling'

describe('cpuPercent', () => {
  // The backend returns a counter, not a rate; one second of CPU burned over
  // one second of wall clock is one busy core.
  it('divides the counter delta by the elapsed wall time', () => {
    const prev = { cpuSeconds: 10, sampledAt: 1_000 }
    const curr = { cpuSeconds: 10.5, sampledAt: 2_000 }
    expect(cpuPercent(prev, curr)).toBeCloseTo(50)
  })

  // A CLI running workers across cores is genuinely above 100%, and that is
  // what Activity Monitor shows too — clamping it would hide the outlier the
  // panel exists to surface.
  it('keeps figures above one full core', () => {
    const percent = cpuPercent({ cpuSeconds: 0, sampledAt: 0 }, { cpuSeconds: 4, sampledAt: 1_000 })
    expect(percent).toBeCloseTo(400)
  })

  // The first tick after opening has nothing to difference against. A dash is
  // honest; a zero would read as "idle".
  it('is null without a previous sample', () => {
    expect(cpuPercent(undefined, { cpuSeconds: 5, sampledAt: 1_000 })).toBeNull()
  })

  it('is null when the clock did not move or went backwards', () => {
    const curr = { cpuSeconds: 5, sampledAt: 1_000 }
    expect(cpuPercent({ cpuSeconds: 4, sampledAt: 1_000 }, curr)).toBeNull()
    expect(cpuPercent({ cpuSeconds: 4, sampledAt: 2_000 }, curr)).toBeNull()
  })

  // The tree lost a child between sweeps, taking its accumulated time with it.
  // A zero here would read as "idle" next to a pane that is pinning a core, so
  // it is unknown — the same answer as the first sample.
  it('is null rather than zero when the counter falls', () => {
    expect(
      cpuPercent({ cpuSeconds: 90, sampledAt: 0 }, { cpuSeconds: 10, sampledAt: 1_000 })
    ).toBeNull()
  })

  // The backend re-walks each pane's descendants on a slower timer than the
  // panel samples, so a child can join the group carrying CPU time it accrued
  // before we were watching. Over one interval that reads as an impossible
  // spike; the machine cannot exceed 100% per core.
  it('is null when the figure exceeds what the machine has', () => {
    const prev = { cpuSeconds: 0, sampledAt: 0 }
    const curr = { cpuSeconds: 20, sampledAt: 2_000 } // 1000% of one core
    expect(cpuPercent(prev, curr, 4)).toBeNull()
    // Same reading on a machine that really has twelve cores is possible.
    expect(cpuPercent(prev, curr, 12)).toBeCloseTo(1000)
  })

  // Without a core count there is nothing to compare against, so the cap is off.
  it('does not cap when the core count is unknown', () => {
    expect(
      cpuPercent({ cpuSeconds: 0, sampledAt: 0 }, { cpuSeconds: 20, sampledAt: 2_000 })
    ).toBeCloseTo(1000)
  })
})

describe('formatCpuPercent', () => {
  it('shows one decimal below a hundred and none above', () => {
    expect(formatCpuPercent(4.25)).toBe('4.3%')
    expect(formatCpuPercent(142.6)).toBe('143%')
  })

  it('shows a dash when there is nothing to show', () => {
    expect(formatCpuPercent(null)).toBe('—')
    expect(formatCpuPercent(Number.NaN)).toBe('—')
  })
})

describe('resourcePollIntervalMs', () => {
  // The pill carries a number even when nothing is open, so there is a
  // background cadence — deliberately slow.
  it('is slow in the background and fast with a panel open', () => {
    expect(resourcePollIntervalMs({ paneCount: 3, panelOpen: false })).toBe(RESOURCE_POLL_IDLE_MS)
    expect(resourcePollIntervalMs({ paneCount: 3, panelOpen: true })).toBe(RESOURCE_POLL_ACTIVE_MS)
  })

  // Shelling out to `ps` and `footprint` for an empty pid list is pure cost.
  it('does not sample at all with no panes', () => {
    expect(resourcePollIntervalMs({ paneCount: 0, panelOpen: true })).toBeNull()
  })
})
