/**
 * Turning the backend's accumulated CPU counters into a live percentage.
 *
 * `terminal.resource_usage` returns CPU *seconds* rather than a percentage,
 * because a percentage only exists between two readings and each window
 * samples at its own rate. The differencing therefore lives here, next to the
 * caller that keeps the previous sample — one ring buffer per window, no
 * shared state on the backend to fight over.
 */

/** One reading of a pane's process tree. */
export interface CpuSample {
  /** Accumulated CPU seconds for the whole tree. */
  cpuSeconds: number
  /** Wall clock of the reading, in milliseconds. */
  sampledAt: number
}

/**
 * Average CPU utilisation between two readings, as a percentage.
 *
 * Null means "not yet knowable", which the panel shows as a dash rather than a
 * zero: with no previous sample there is no interval, and the first tick after
 * opening always lands here.
 *
 * Above 100 is real and kept — a CLI running four workers on four cores is at
 * 400%, exactly as Activity Monitor reports it.
 */
export function cpuPercent(prev: CpuSample | undefined, curr: CpuSample): number | null {
  if (!prev) return null
  const elapsedMs = curr.sampledAt - prev.sampledAt
  // A clock that did not move (or went backwards, across a sleep/wake) gives
  // no interval to divide by.
  if (!(elapsedMs > 0)) return null
  const delta = curr.cpuSeconds - prev.cpuSeconds
  // The counter only falls when the tree changed under us — a child exited
  // between sweeps, so its accumulated time left the total. That is not
  // negative CPU use; it is no measurement.
  if (delta < 0) return 0
  return (delta / (elapsedMs / 1000)) * 100
}

/**
 * A CPU percentage as it appears in the panel's column.
 *
 * One decimal below 100 and none above, matching `formatBytes` so the two
 * numeric columns line up.
 */
export function formatCpuPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return '—'
  const value = Math.max(0, percent)
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)}%`
}

/**
 * What share of the whole machine the panes add up to.
 *
 * The per-pane column is relative to one core, the way Activity Monitor
 * reports it — a four-worker CLI reads 400%. The summary answers a different
 * question ("how much of this machine is Navide using"), so it needs the core
 * count as a denominator. Null when the backend could not tell us the
 * capacity; the caller then shows the raw total rather than a made-up share.
 */
export function machineCpuShare(totalPercent: number | null, cpuCount: number): number | null {
  if (totalPercent === null || !Number.isFinite(totalPercent)) return null
  if (!(cpuCount > 0)) return null
  return Math.max(0, totalPercent) / cpuCount
}

/** What share of physical memory the panes add up to. */
export function machineMemoryShare(bytes: number, machineBytes: number): number | null {
  if (!(machineBytes > 0) || !Number.isFinite(bytes)) return null
  return (Math.max(0, bytes) / machineBytes) * 100
}

/**
 * How often to sample, in milliseconds.
 *
 * The pill needs a number even when nothing is open, which is what forces a
 * background cadence at all; it is deliberately slow, and stops entirely when
 * there is nothing to measure. A panel in front of the user gets the fast one.
 */
export const RESOURCE_POLL_IDLE_MS = 30_000
export const RESOURCE_POLL_ACTIVE_MS = 2_000

/**
 * The interval that applies right now.
 *
 * Returning null means "do not sample": with no realized pane there is nothing
 * to measure, and a timer that keeps shelling out to `ps` and `footprint` for
 * an empty list is pure cost.
 */
export function resourcePollIntervalMs(opts: {
  paneCount: number
  panelOpen: boolean
}): number | null {
  if (opts.paneCount <= 0) return null
  return opts.panelOpen ? RESOURCE_POLL_ACTIVE_MS : RESOURCE_POLL_IDLE_MS
}
