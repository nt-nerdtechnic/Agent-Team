// @vitest-environment happy-dom
// ResourceWindowApp (the Resource Manager window) — it owns no panes, so every
// assertion is on the seams it does have: the backend roster it lists from, the
// measurement sweep it merges in, and the main-process relay its two row
// actions go through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '../../i18n'

const wire = vi.hoisted(() => ({
  status: 'connected' as string,
  panes: [
    { pane_id: 'p1', name: 'Scan the code', workspace_label: 'Agent-Team', agent_key: 'claude', busy: false, offline: false },
    { pane_id: 'p2', name: 'Deploy notes', workspace_label: 'care-platform', agent_key: 'codex', busy: true, offline: false },
  ] as Array<Record<string, unknown>>,
  /** Grows by one second per sweep so the second reading yields a percentage. */
  sweep: 0,
  cpuSeconds: { p1: [10, 10.1], p2: [20, 21] } as Record<string, number[]>,
  bytes: { p1: 300 * 1024 * 1024, p2: 600 * 1024 * 1024 } as Record<string, number>,
  cpuCount: 4,
  machineMemory: 4 * 1024 * 1024 * 1024,
  available: true,
  cpuAvailable: true,
  calls: [] as Array<{ type: string }>,
  diskOk: true,
}))

vi.mock('../../composables/useBackend', () => {
  function payloadFor(type: string): unknown {
    if (type === 'agent_msg.list') return { panes: wire.panes }
    if (type === 'storage.usage') {
      return wire.diskOk
        ? { disk: { totalBytes: 500 * 1024 * 1024 * 1024, freeBytes: 120 * 1024 * 1024 * 1024 } }
        : {}
    }
    if (type === 'terminal.resource_usage') {
      const index = Math.min(wire.sweep, 1)
      const panes = wire.panes.map((p) => ({
        terminal_session_id: `sess-${p.pane_id}`,
        pane_id: p.pane_id,
        bytes: wire.bytes[p.pane_id as string] ?? 0,
        cpu_seconds: (wire.cpuSeconds[p.pane_id as string] ?? [0, 0])[index],
      }))
      const sampledAt = 1_000 + wire.sweep
      wire.sweep += 1
      return {
        available: wire.available,
        cpu_available: wire.cpuAvailable,
        sampled_at: sampledAt,
        panes,
        total_bytes: 0,
        cpu_count: wire.cpuCount,
        machine_memory_bytes: wire.machineMemory,
      }
    }
    return { ok: true }
  }
  return {
    useBackend: () => ({
      status: ref(wire.status),
      wsUrl: ref(''),
      httpUrl: ref(''),
      shell: ref(''),
      port: ref(0),
      pid: ref(0),
      lastError: ref(''),
      send: vi.fn(async (type: string) => {
        wire.calls.push({ type })
        return { id: 'r', type, ok: true, payload: payloadFor(type), error: null, timestamp: '' }
      }),
      on: vi.fn(() => () => {}),
      restart: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }),
  }
})

vi.mock('../../lib/settings', () => ({
  initSettingsBackend: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {}),
  settingsGet: vi.fn((key: string, fallback: unknown) =>
    key === 'agentTeam.idleReclaimMinutes' ? '45' : fallback
  ),
  settingsSet: vi.fn(),
}))

vi.mock('../../composables/useTheme', () => ({
  useTheme: () => ({ loadTheme: vi.fn() }),
}))

import ResourceWindowApp from '../../ResourceWindowApp.vue'

const paneAction = vi.fn(async () => ({ ok: true }) as { ok?: boolean; error?: string })

beforeEach(() => {
  wire.status = 'connected'
  wire.sweep = 0
  wire.available = true
  wire.cpuAvailable = true
  wire.calls = []
  wire.diskOk = true
  wire.panes = [
    { pane_id: 'p1', name: 'Scan the code', workspace_label: 'Agent-Team', agent_key: 'claude', busy: false, offline: false },
    { pane_id: 'p2', name: 'Deploy notes', workspace_label: 'care-platform', agent_key: 'codex', busy: true, offline: false },
  ]
  paneAction.mockReset()
  paneAction.mockResolvedValue({ ok: true })
  ;(window as unknown as { agentTeam: unknown }).agentTeam = { requestPaneAction: paneAction }
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  vi.useRealTimers()
})

/** Mounts and settles the first roster + measurement round. */
async function mountWindow(): Promise<VueWrapper> {
  const w = mount(ResourceWindowApp, { global: { plugins: [i18n] } })
  await flushPromises()
  return w
}

/** Drives a second sweep so CPU has an interval to divide by. */
async function secondSweep(w: VueWrapper): Promise<void> {
  await w.get('[data-act="refresh"]').trigger('click')
  await flushPromises()
}

describe('ResourceWindowApp', () => {
  it('lists every pane in the roster, whichever window owns it', async () => {
    const w = await mountWindow()
    const names = w.findAll('[data-row="pane"] .rw-name').map((n) => n.text())
    expect(names).toContain('Scan the code')
    expect(names).toContain('Deploy notes')
    expect(w.text()).toContain('care-platform')
    w.unmount()
  })

  it('merges the measurement onto the row by pane id', async () => {
    const w = await mountWindow()
    const row = w.get('[data-pane="p2"]')
    expect(row.get('[data-part="memory"]').text()).toBe('600 MB')
    w.unmount()
  })

  // The first reading has nothing to difference against.
  it('shows CPU from the second sweep onwards', async () => {
    const w = await mountWindow()
    expect(w.get('[data-pane="p2"] [data-part="cpu"]').text()).toBe('—')
    await secondSweep(w)
    expect(w.get('[data-pane="p2"] [data-part="cpu"]').text()).toBe('100%')
    w.unmount()
  })

  // 900 MB of 4 GB, and one busy core of four.
  it('totals the rows and states the machine share', async () => {
    const w = await mountWindow()
    expect(w.get('[data-metric="memory"] [data-part="value"]').text()).toBe('900 MB')
    expect(w.get('[data-metric="memory"]').text()).toContain('22%')
    await secondSweep(w)
    expect(w.get('[data-metric="cpu"] [data-part="value"]').text()).toBe('110%')
    expect(w.get('[data-metric="cpu"]').text()).toContain('27%')
    w.unmount()
  })

  it('filters to running and idle', async () => {
    const w = await mountWindow()
    await w.get('[data-filter="running"]').trigger('click')
    expect(w.findAll('[data-row="pane"]')).toHaveLength(1)
    expect(w.get('[data-row="pane"] .rw-name').text()).toBe('Deploy notes')
    await w.get('[data-filter="idle"]').trigger('click')
    expect(w.get('[data-row="pane"] .rw-name').text()).toBe('Scan the code')
    w.unmount()
  })

  // Named so the two orders differ: p2 holds twice the memory, p1 sorts first
  // alphabetically.
  it('sorts by memory by default and by name on request', async () => {
    wire.panes = [
      { pane_id: 'p1', name: 'Alpha scan', workspace_label: 'ws', agent_key: 'claude', busy: false, offline: false },
      { pane_id: 'p2', name: 'Zeta deploy', workspace_label: 'ws', agent_key: 'codex', busy: false, offline: false },
    ]
    const w = await mountWindow()
    expect(w.findAll('[data-row="pane"] .rw-name').map((n) => n.text())).toEqual([
      'Zeta deploy',
      'Alpha scan',
    ])
    await w.get('[data-act="sort"]').setValue('name')
    expect(w.findAll('[data-row="pane"] .rw-name').map((n) => n.text())).toEqual([
      'Alpha scan',
      'Zeta deploy',
    ])
    w.unmount()
  })

  // Focusing and reclaiming only exist in the window that owns the pane.
  it('relays a jump to the owning window', async () => {
    const w = await mountWindow()
    await w.get('[data-pane="p1"] .rw-jump').trigger('click')
    expect(paneAction).toHaveBeenCalledWith({ paneId: 'p1', action: 'focus' })
    w.unmount()
  })

  it('relays a reclaim and re-measures on success', async () => {
    const w = await mountWindow()
    wire.calls = []
    await w.get('[data-pane="p1"] [data-act="reclaim"]').trigger('click')
    await flushPromises()
    expect(paneAction).toHaveBeenCalledWith({ paneId: 'p1', action: 'reclaim' })
    expect(wire.calls.some((c) => c.type === 'terminal.resource_usage')).toBe(true)
    w.unmount()
  })

  // A busy pane refuses; the row says so rather than the click doing nothing.
  it('explains a refused reclaim on the row', async () => {
    paneAction.mockResolvedValue({ error: 'blocked' })
    const w = await mountWindow()
    await w.get('[data-pane="p2"] [data-act="reclaim"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-pane="p2"] [data-part="notice"]').text()).toBe(
      i18n.global.t('resource.reclaim-blocked')
    )
    w.unmount()
  })

  it('says the pane is gone when no window claims it', async () => {
    paneAction.mockResolvedValue({ error: 'not-found' })
    const w = await mountWindow()
    await w.get('[data-pane="p1"] [data-act="reclaim"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-pane="p1"] [data-part="notice"]').text()).toBe(
      i18n.global.t('resource.pane-gone')
    )
    w.unmount()
  })

  // Showing an unmeasured pane as 0 reads as "this one is free".
  it('dashes the figures when the platform cannot measure', async () => {
    wire.available = false
    wire.cpuAvailable = false
    const w = await mountWindow()
    expect(w.get('[data-metric="memory"] [data-part="value"]').text()).toBe('—')
    expect(w.get('[data-pane="p1"] [data-part="cpu"]').text()).toBe('—')
    expect(w.text()).toContain(i18n.global.t('resource.unavailable'))
    w.unmount()
  })

  it('says so when nothing is running', async () => {
    wire.panes = []
    const w = await mountWindow()
    expect(w.get('[data-row="empty"]').text()).toBe(i18n.global.t('resource.window-empty'))
    w.unmount()
  })

  // Read-only: it is set in the main window's Settings, and explains what will
  // happen to the idle rows on its own.
  it('reports the auto-reclaim setting it does not own', async () => {
    const w = await mountWindow()
    expect(w.text()).toContain('45')
    w.unmount()
  })

  it('does not sweep while the backend is away', async () => {
    wire.status = 'starting'
    const w = await mountWindow()
    expect(wire.calls.some((c) => c.type === 'agent_msg.list')).toBe(false)
    w.unmount()
  })

  it('renders no untranslated i18n keys in either locale', async () => {
    for (const locale of ['zh-TW', 'en-US'] as const) {
      i18n.global.locale.value = locale
      const w = await mountWindow()
      expect(w.text()).not.toMatch(/resource\.[a-z-]+/)
      w.unmount()
    }
    i18n.global.locale.value = 'en-US'
  })

  // The scan walks several large trees, so it is a button rather than part of
  // the sampling loop — nothing should ask for it on its own.
  it('does not scan the disk until asked', async () => {
    const w = await mountWindow()
    expect(wire.calls.some((c) => c.type === 'storage.usage')).toBe(false)
    expect(w.get('[data-part="disk"]').text()).toBe(i18n.global.t('resource.disk-unscanned'))

    await w.get('[data-act="scan-disk"]').trigger('click')
    await flushPromises()
    expect(wire.calls.some((c) => c.type === 'storage.usage')).toBe(true)
    expect(w.get('[data-part="disk"]').text()).toContain('120 GB')
    w.unmount()
  })

  it('says the scan failed rather than showing nothing', async () => {
    wire.diskOk = false
    const w = await mountWindow()
    await w.get('[data-act="scan-disk"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-part="disk"]').text()).toBe(i18n.global.t('resource.disk-failed'))
    w.unmount()
  })
})
