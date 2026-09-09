// @vitest-environment happy-dom
// Opening the modal used to render whatever the last hydrate left in memory,
// with no way to ask for a fresh read and nothing on screen while one ran.
// These pin the refresh control, the arming delay in front of the loader (a
// reload that lands in a frame or two must not flash the list away and back),
// and the two display fixes that ride with it: a removed pane whose removal
// time was never recorded still reads as removed, and an mcp-spawned session
// is no longer labelled Manual.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentHistoryModal from '../AgentHistoryModal.vue'
import type { SpawnHistoryEntry } from '../../lib/spawnHistory'

function entry(overrides: Partial<SpawnHistoryEntry> = {}): SpawnHistoryEntry {
  return {
    paneId: 'aaaa1111-2222',
    agentKey: 'claude',
    agentLabel: 'Claude',
    roleKey: 'dev' as SpawnHistoryEntry['roleKey'],
    roleLabel: 'Dev',
    command: 'claude',
    sessionId: 'sess-1',
    origin: 'manual',
    stageId: 'dev' as SpawnHistoryEntry['stageId'],
    workspacePath: '/ws',
    spawnedAt: '2026-08-08T10:21:34Z',
    ...overrides,
  }
}

async function mountModal(props: Record<string, unknown> = {}) {
  const wrapper = mount(AgentHistoryModal, {
    props: {
      show: false,
      sessionHistory: [entry()],
      paneCount: 1,
      revivingPaneId: '',
      unavailablePaneIds: new Set<string>(),
      activePaneIds: new Set<string>(),
      previewOpen: false,
      previewTitle: '',
      previewContent: '',
      ...props,
    },
    global: {
      stubs: { teleport: true },
      mocks: {
        $t: (key: string, params?: Record<string, unknown>) =>
          params ? `${key} ${JSON.stringify(params)}` : key,
      },
    },
  })
  await wrapper.setProps({ show: true })
  await flushPromises()
  return wrapper
}

describe('AgentHistoryModal – refreshing the list', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('asks App for a fresh read when the refresh button is pressed', async () => {
    const wrapper = await mountModal()
    await wrapper.find('.ah-refresh-btn').trigger('click')
    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })

  it('disables the button while a refresh is running', async () => {
    const wrapper = await mountModal()
    expect(wrapper.find('.ah-refresh-btn').attributes('disabled')).toBeUndefined()
    await wrapper.setProps({ refreshing: true })
    expect(wrapper.find('.ah-refresh-btn').attributes('disabled')).toBeDefined()
  })

  it('shows the brand loader in place of the list once the refresh outlasts the arming delay', async () => {
    const wrapper = await mountModal()
    await wrapper.setProps({ refreshing: true })
    // Still within the arming window: the list stays put.
    expect(wrapper.find('.ah-refresh-loading').exists()).toBe(false)
    expect(wrapper.find('.agent-history-row').exists()).toBe(true)

    vi.advanceTimersByTime(200)
    await flushPromises()
    expect(wrapper.find('.ah-refresh-loading').exists()).toBe(true)
    // Replaced, not covered: two answers on screen at once reads as a glitch.
    expect(wrapper.find('.agent-history-row').exists()).toBe(false)
  })

  it('never renders the loader for a refresh that finishes inside the arming delay', async () => {
    const wrapper = await mountModal()
    await wrapper.setProps({ refreshing: true })
    vi.advanceTimersByTime(120)
    await wrapper.setProps({ refreshing: false })
    vi.advanceTimersByTime(500)
    await flushPromises()
    expect(wrapper.find('.ah-refresh-loading').exists()).toBe(false)
    expect(wrapper.find('.agent-history-row').exists()).toBe(true)
  })

  it('puts the list back when the refresh ends', async () => {
    const wrapper = await mountModal()
    await wrapper.setProps({ refreshing: true })
    vi.advanceTimersByTime(200)
    await flushPromises()
    expect(wrapper.find('.ah-refresh-loading').exists()).toBe(true)
    await wrapper.setProps({ refreshing: false })
    expect(wrapper.find('.ah-refresh-loading').exists()).toBe(false)
    expect(wrapper.find('.agent-history-row').exists()).toBe(true)
  })
})

describe('AgentHistoryModal – a removed pane with no removal time', () => {
  const noTime = entry({ removedTimeUnknown: true, spawnedAt: undefined })

  it('marks the row removed rather than active', async () => {
    const wrapper = await mountModal({ sessionHistory: [noTime] })
    expect(wrapper.find('.ah-dot').classes()).toContain('removed')
    expect(wrapper.find('.ah-dot').classes()).not.toContain('active')
  })

  it('says removed in the detail status', async () => {
    const wrapper = await mountModal({ sessionHistory: [noTime] })
    await wrapper.find('.agent-history-row').trigger('click')
    expect(wrapper.find('.ah-status').classes()).toContain('removed')
    expect(wrapper.find('.ah-status').text()).toBe('label.history-filter-removed')
  })

  it('names the removal without inventing a time for it', async () => {
    const wrapper = await mountModal({ sessionHistory: [noTime] })
    await wrapper.find('.agent-history-row').trigger('click')
    const labels = wrapper.findAll('.detail-label').map((n) => n.text())
    const values = wrapper.findAll('.detail-value').map((n) => n.text())
    const at = labels.indexOf('label.history-detail-removed')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(values[at]).toBe('—')
    // Same for the spawn time, and for the row's own timestamp column.
    expect(values[labels.indexOf('label.history-detail-spawned')]).toBe('—')
    expect(wrapper.find('.ah-time').text()).toBe('—')
  })

  it('offers the removed-entry actions, not the go-to-pane one', async () => {
    const wrapper = await mountModal({ sessionHistory: [noTime] })
    await wrapper.find('.agent-history-row').trigger('click')
    expect(wrapper.find('.ah-revive.ah-focus').exists()).toBe(false)
    expect(wrapper.find('.ah-revive.ah-delete').exists()).toBe(true)
  })

  it('ignores a double-click that would jump to a pane that is gone', async () => {
    const wrapper = await mountModal({ sessionHistory: [noTime] })
    await wrapper.find('.agent-history-row').trigger('dblclick')
    expect(wrapper.emitted('focus-pane')).toBeUndefined()
  })
})

describe('AgentHistoryModal – where the session came from', () => {
  async function originText(origin: SpawnHistoryEntry['origin']): Promise<string> {
    const wrapper = await mountModal({ sessionHistory: [entry({ origin })] })
    await wrapper.find('.agent-history-row').trigger('click')
    const labels = wrapper.findAll('.detail-label').map((n) => n.text())
    const values = wrapper.findAll('.detail-value').map((n) => n.text())
    return values[labels.indexOf('label.history-detail-origin')]
  }

  it('tells mcp apart from manual and pipeline', async () => {
    expect(await originText('mcp')).toBe('label.history-filter-mcp')
    expect(await originText('manual')).toBe('label.history-filter-manual')
    expect(await originText('pipeline')).toBe('label.history-filter-pipeline')
  })
})
