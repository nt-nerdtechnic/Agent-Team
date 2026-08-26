// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import {
  useResourceUsage,
  type ResourceUsageWire,
} from '../useResourceUsage'
import { RESOURCE_POLL_ACTIVE_MS, RESOURCE_POLL_IDLE_MS } from '../../lib/resourceSampling'

function wire(over: Partial<ResourceUsageWire> = {}): ResourceUsageWire {
  return {
    available: true,
    cpu_available: true,
    sampled_at: 1,
    panes: [{ terminal_session_id: 'sess-a', pane_id: 'pane-a', bytes: 100, cpu_seconds: 10 }],
    total_bytes: 100,
    cpu_count: 4,
    machine_memory_bytes: 1_000,
    ...over,
  }
}

/** Runs the composable inside a scope so its watcher and timer are disposable. */
function mount(request: () => Promise<ResourceUsageWire | null>, paneCount = 1, panelOpen = false) {
  const scope = effectScope()
  const panes = ref(paneCount)
  const open = ref(panelOpen)
  const api = scope.run(() =>
    useResourceUsage({ request, paneCount: panes, panelOpen: open })
  )!
  return { api, panes, open, dispose: () => scope.stop() }
}

let disposers: Array<() => void> = []
afterEach(() => {
  disposers.forEach((d) => d())
  disposers = []
  vi.useRealTimers()
})
beforeEach(() => {
  vi.useFakeTimers()
})

describe('useResourceUsage', () => {
  // The backend hands back a counter; the first reading has nothing to
  // difference against, so CPU is unknown until the second one arrives.
  it('reports CPU only from the second sample onwards', async () => {
    const replies = [
      wire({ sampled_at: 1, panes: [{ terminal_session_id: 'sess-a', pane_id: 'pane-a', bytes: 100, cpu_seconds: 10 }] }),
      wire({ sampled_at: 2, panes: [{ terminal_session_id: 'sess-a', pane_id: 'pane-a', bytes: 100, cpu_seconds: 10.5 }] }),
    ]
    let call = 0
    const m = mount(async () => replies[Math.min(call++, replies.length - 1)])
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(m.api.cpuPercentByKey.value.get('sess-a')).toBeNull()
    expect(m.api.totalCpuPercent.value).toBeNull()

    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS)
    expect(m.api.cpuPercentByKey.value.get('sess-a')).toBeCloseTo(50)
    expect(m.api.totalCpuPercent.value).toBeCloseTo(50)
  })

  // Four cores means one busy core is a quarter of the machine.
  it('divides the total by the core count for the machine share', async () => {
    let call = 0
    const m = mount(async () =>
      wire({
        sampled_at: 1 + call++,
        panes: [{ terminal_session_id: 'sess-a', pane_id: 'pane-a', bytes: 250, cpu_seconds: call },],
      })
    )
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS)
    expect(m.api.cpuShare.value).toBeCloseTo(25)
    expect(m.api.memoryShare.value).toBeCloseTo(25)
  })

  // Showing an unmeasured pane as 0 reads as "this one is free", which is the
  // opposite of what a failed sweep means.
  it('marks usage unavailable rather than zero when the backend cannot answer', async () => {
    const m = mount(async () => null)
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(m.api.available.value).toBe(false)
    expect(m.api.cpuAvailable.value).toBe(false)
    expect(m.api.measured.value).toBe(true)
  })

  // A machine deep in swap can take longer than the fast interval, and queueing
  // sweeps would make that worse exactly when the panel was opened to find out
  // why it is slow.
  it('never runs two sweeps at once', async () => {
    let started = 0
    const releases: Array<() => void> = []
    const m = mount(
      () =>
        new Promise<ResourceUsageWire | null>((resolve) => {
          started += 1
          releases.push(() => resolve(wire()))
        })
    )
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toBe(1)
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS * 3)
    expect(started).toBe(1)
    releases.forEach((r) => r())
  })

  // The pill carries a figure with nothing open, which is what forces a
  // background cadence at all; a panel in front of the user gets the fast one.
  it('switches cadence when the panel opens', async () => {
    let calls = 0
    const m = mount(async () => {
      calls += 1
      return wire({ sampled_at: 1 + calls })
    })
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    m.open.value = true
    await nextTick()
    // Reopening restarts the loop with an immediate reading.
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_ACTIVE_MS)
    expect(calls).toBe(3)
  })

  // Shelling out to `ps` and `footprint` for an empty pid list is pure cost,
  // and a counter kept across an empty stretch would difference against a
  // reading from another era.
  it('stops sampling and forgets its counters with no panes', async () => {
    let calls = 0
    const m = mount(async () => {
      calls += 1
      return wire()
    })
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    m.panes.value = 0
    await nextTick()
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS * 2)
    expect(calls).toBe(1)
    expect(m.api.measured.value).toBe(false)
    expect(m.api.bytesByKey.value.size).toBe(0)
  })

  // A pane id reused after its pane went away must not inherit a stale counter
  // and report one enormous spike.
  it('drops the counters of panes that are gone', async () => {
    const rounds: ResourceUsageWire[] = [
      wire({ sampled_at: 1 }),
      wire({ sampled_at: 2, panes: [] }),
      wire({ sampled_at: 3, panes: [{ terminal_session_id: 'sess-a', pane_id: 'pane-a', bytes: 100, cpu_seconds: 9_999 }] }),
    ]
    let call = 0
    const m = mount(async () => rounds[Math.min(call++, rounds.length - 1)])
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS)
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS)
    expect(m.api.cpuPercentByKey.value.get('sess-a')).toBeNull()
  })

  it('stops its timer when the scope is disposed', async () => {
    let calls = 0
    const m = mount(async () => {
      calls += 1
      return wire()
    })
    await vi.advanceTimersByTimeAsync(0)
    m.dispose()
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS * 3)
    expect(calls).toBe(1)
  })
})
