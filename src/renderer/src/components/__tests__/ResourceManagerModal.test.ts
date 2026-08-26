// @vitest-environment happy-dom
// ResourceManagerModal (the in-window Resource Manager) — it owns no pane state
// and no sampling loop, so every assertion is on the seams it does have: the
// backend roster it merges names from, the host's sweep it renders, and the
// main-process relay its two row actions go through.
//
// The differencing itself is useResourceUsage's and is tested there; here the
// sweep is a stub so each case can pin exact figures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { i18n } from '../../i18n'
import ResourceManagerModal from '../ResourceManagerModal.vue'

const MB = 1024 * 1024
const GB = 1024 * MB

const wire = vi.hoisted(() => ({
  status: 'connected' as string,
  panes: [] as Array<Record<string, unknown>>,
  diskOk: true,
  calls: [] as Array<{ type: string }>,
}))

function fakeBackend() {
  return {
    status: ref(wire.status),
    wsUrl: ref(''),
    httpUrl: ref(''),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async (type: string) => {
      wire.calls.push({ type })
      const payload =
        type === 'agent_msg.list'
          ? { panes: wire.panes }
          : type === 'storage.usage'
            ? wire.diskOk
              ? { disk: { totalBytes: 500 * GB, freeBytes: 120 * GB } }
              : {}
            : { ok: true }
      return { id: 'r', type, ok: true, payload, error: null, timestamp: '' }
    }),
    on: vi.fn(() => () => {}),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as never
}

/** The host's sampling loop, stubbed to exact figures. */
function fakeUsage(
  bytes: Record<string, number> = {},
  cpu: Record<string, number | null> = {},
  over: Partial<{ available: boolean; cpuAvailable: boolean; measured: boolean; cpuCount: number }> = {}
) {
  const bytesByPaneId = ref(new Map(Object.entries(bytes)))
  const cpuPercentByPaneId = ref(new Map(Object.entries(cpu)))
  const refresh = vi.fn(async () => undefined)
  return {
    api: {
      bytesByKey: ref(new Map<string, number>()),
      cpuPercentByKey: ref(new Map<string, number | null>()),
      bytesByPaneId,
      cpuPercentByPaneId,
      totalBytes: computed(() => 0),
      totalCpuPercent: computed(() => null),
      cpuShare: computed(() => null),
      memoryShare: computed(() => null),
      cpuCount: ref(over.cpuCount ?? 4),
      machineMemoryBytes: ref(4 * GB),
      available: ref(over.available ?? true),
      cpuAvailable: ref(over.cpuAvailable ?? true),
      measured: ref(over.measured ?? true),
      refresh,
      stop: vi.fn(),
    } as unknown as never,
    refresh,
  }
}

const paneAction = vi.fn(async () => ({ ok: true }) as { ok?: boolean; error?: string })

beforeEach(() => {
  wire.status = 'connected'
  wire.diskOk = true
  wire.calls = []
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
  document.body.innerHTML = ''
})

const DEFAULT_BYTES = { p1: 300 * MB, p2: 600 * MB }
const DEFAULT_CPU = { p1: 1, p2: 100 }

async function mountModal(
  opts: {
    open?: boolean
    bytes?: Record<string, number>
    cpu?: Record<string, number | null>
    usageOver?: Parameters<typeof fakeUsage>[2]
  } = {}
): Promise<{ w: VueWrapper; refresh: ReturnType<typeof vi.fn> }> {
  const usage = fakeUsage(opts.bytes ?? DEFAULT_BYTES, opts.cpu ?? DEFAULT_CPU, opts.usageOver)
  const w = mount(ResourceManagerModal, {
    props: {
      open: opts.open ?? true,
      backend: fakeBackend(),
      usage: usage.api,
      autoReclaimOn: true,
      autoReclaimMinutes: '45',
    },
    // The modal teleports to <body>; stubbing that keeps the tree inside the
    // wrapper, which is what every query here reads from.
    global: { plugins: [i18n], stubs: { teleport: true } },
  })
  await flushPromises()
  return { w, refresh: usage.refresh }
}

describe('ResourceManagerModal', () => {
  it('lists every pane in the roster, whichever window owns it', async () => {
    const { w } = await mountModal()
    const names = w.findAll('[data-row="pane"] .rm-name').map((n) => n.text())
    expect(names).toContain('Scan the code')
    expect(names).toContain('Deploy notes')
    expect(w.text()).toContain('care-platform')
    w.unmount()
  })

  it('renders the host sweep onto each row', async () => {
    const { w } = await mountModal()
    const row = w.get('[data-pane="p2"]')
    expect(row.get('[data-part="memory"]').text()).toBe('600 MB')
    expect(row.get('[data-part="cpu"]').text()).toBe('100%')
    w.unmount()
  })

  // The first reading has nothing to difference against; the host reports null.
  it('dashes a pane whose CPU is not knowable yet', async () => {
    const { w } = await mountModal({ cpu: { p1: null, p2: null } })
    expect(w.get('[data-pane="p1"] [data-part="cpu"]').text()).toBe('—')
    w.unmount()
  })

  // 900 MB of 4 GB, and 101% of four cores.
  it('totals the rows and states the machine share', async () => {
    const { w } = await mountModal()
    expect(w.get('[data-metric="memory"] [data-part="value"]').text()).toBe('900 MB')
    expect(w.get('[data-metric="memory"]').text()).toContain('22%')
    expect(w.get('[data-metric="cpu"] [data-part="value"]').text()).toBe('101%')
    expect(w.get('[data-metric="cpu"]').text()).toContain('25%')
    w.unmount()
  })

  // registerPaneMessaging skips plain terminal panes, so the roster never lists
  // a shell running a build — which is exactly what you open this for.
  it('lists a measured pane the roster does not know about', async () => {
    const { w } = await mountModal({ bytes: { ...DEFAULT_BYTES, 'shell-1': 900 * MB } })
    const row = w.get('[data-pane="shell-1"]')
    expect(row.get('.rm-name').text()).toBe(i18n.global.t('resource.unnamed-pane'))
    expect(row.get('[data-part="memory"]').text()).toBe('900 MB')
    w.unmount()
  })

  it('counts that pane in the machine total', async () => {
    const { w } = await mountModal({ bytes: { ...DEFAULT_BYTES, 'shell-1': 900 * MB } })
    expect(w.get('[data-metric="memory"] [data-part="value"]').text()).toBe('1.8 GB')
    w.unmount()
  })

  it('filters to running and idle', async () => {
    const { w } = await mountModal()
    await w.get('[data-filter="running"]').trigger('click')
    expect(w.findAll('[data-row="pane"]')).toHaveLength(1)
    expect(w.get('[data-row="pane"] .rm-name').text()).toBe('Deploy notes')
    await w.get('[data-filter="idle"]').trigger('click')
    expect(w.get('[data-row="pane"] .rm-name').text()).toBe('Scan the code')
    w.unmount()
  })

  // Named so the two orders differ: p2 holds twice the memory, p1 sorts first.
  it('sorts by memory by default and by name on request', async () => {
    wire.panes = [
      { pane_id: 'p1', name: 'Alpha scan', workspace_label: 'ws', agent_key: 'claude', busy: false, offline: false },
      { pane_id: 'p2', name: 'Zeta deploy', workspace_label: 'ws', agent_key: 'codex', busy: false, offline: false },
    ]
    const { w } = await mountModal()
    expect(w.findAll('[data-row="pane"] .rm-name').map((n) => n.text())).toEqual([
      'Zeta deploy',
      'Alpha scan',
    ])
    await w.get('[data-act="sort"]').setValue('name')
    expect(w.findAll('[data-row="pane"] .rm-name').map((n) => n.text())).toEqual([
      'Alpha scan',
      'Zeta deploy',
    ])
    w.unmount()
  })

  // Focusing and reclaiming only exist in the window that owns the pane — and
  // the relay covers this window too, so one path serves both.
  it('relays a jump and closes, because you are going to look at that pane', async () => {
    const { w } = await mountModal()
    await w.get('[data-pane="p1"] .rm-jump').trigger('click')
    await flushPromises()
    expect(paneAction).toHaveBeenCalledWith({ paneId: 'p1', action: 'focus' })
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('relays a reclaim and re-measures on success, staying open', async () => {
    const { w, refresh } = await mountModal()
    await w.get('[data-pane="p1"] [data-act="reclaim"]').trigger('click')
    await flushPromises()
    expect(paneAction).toHaveBeenCalledWith({ paneId: 'p1', action: 'reclaim' })
    expect(refresh).toHaveBeenCalled()
    expect(w.emitted('close')).toBeUndefined()
    w.unmount()
  })

  // A busy pane refuses; the row says so rather than the click doing nothing.
  it('explains a refused reclaim on the row', async () => {
    paneAction.mockResolvedValue({ error: 'blocked' })
    const { w } = await mountModal()
    await w.get('[data-pane="p2"] [data-act="reclaim"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-pane="p2"] [data-part="notice"]').text()).toBe(
      i18n.global.t('resource.reclaim-blocked')
    )
    w.unmount()
  })

  it('says the pane is gone when no window claims it', async () => {
    paneAction.mockResolvedValue({ error: 'not-found' })
    const { w } = await mountModal()
    await w.get('[data-pane="p1"] [data-act="reclaim"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-pane="p1"] [data-part="notice"]').text()).toBe(
      i18n.global.t('resource.pane-gone')
    )
    w.unmount()
  })

  // Showing an unmeasured pane as 0 reads as "this one is free".
  it('dashes the figures when the platform cannot measure', async () => {
    const { w } = await mountModal({ usageOver: { available: false, cpuAvailable: false } })
    expect(w.get('[data-metric="memory"] [data-part="value"]').text()).toBe('—')
    expect(w.get('[data-pane="p1"] [data-part="cpu"]').text()).toBe('—')
    expect(w.text()).toContain(i18n.global.t('resource.unavailable'))
    w.unmount()
  })

  it('says so when nothing is running', async () => {
    wire.panes = []
    const { w } = await mountModal({ bytes: {}, cpu: {} })
    expect(w.get('[data-row="empty"]').text()).toBe(i18n.global.t('resource.window-empty'))
    w.unmount()
  })

  // Read-only: it is set in Settings › General, and explains what will happen
  // to the idle rows on its own.
  it('reports the auto-reclaim setting it does not own', async () => {
    const { w } = await mountModal()
    expect(w.text()).toContain('45')
    w.unmount()
  })

  // A closed modal polling the roster is pure cost.
  it('does not touch the backend while closed', async () => {
    const { w } = await mountModal({ open: false })
    expect(wire.calls.some((c) => c.type === 'agent_msg.list')).toBe(false)
    await w.setProps({ open: true })
    await flushPromises()
    expect(wire.calls.some((c) => c.type === 'agent_msg.list')).toBe(true)
    w.unmount()
  })

  it('does not poll while the backend is away', async () => {
    wire.status = 'starting'
    const { w } = await mountModal()
    expect(wire.calls.some((c) => c.type === 'agent_msg.list')).toBe(false)
    w.unmount()
  })

  // The scan walks several large trees, so it is a button rather than part of
  // the sampling loop — nothing should ask for it on its own.
  it('does not scan the disk until asked', async () => {
    const { w } = await mountModal()
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
    const { w } = await mountModal()
    await w.get('[data-act="scan-disk"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-part="disk"]').text()).toBe(i18n.global.t('resource.disk-failed'))
    w.unmount()
  })

  it('closes on its own button', async () => {
    const { w } = await mountModal()
    await w.get('[data-act="close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('renders no untranslated i18n keys in either locale', async () => {
    for (const locale of ['zh-TW', 'en-US'] as const) {
      i18n.global.locale.value = locale
      const { w } = await mountModal()
      expect(w.text()).not.toMatch(/resource\.[a-z-]+/)
      w.unmount()
    }
    i18n.global.locale.value = 'en-US'
  })
})
