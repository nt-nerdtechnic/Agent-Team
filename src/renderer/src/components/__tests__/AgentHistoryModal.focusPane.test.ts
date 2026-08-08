// @vitest-environment happy-dom
// An active history entry has a pane that is still running, so the useful
// action is to jump to it — resuming would start a second session. Active
// entries previously showed no actions at all (the whole block was gated on
// removedAt), so "open full log" was unreachable for them too.
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
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

async function mountModal(sessionHistory: SpawnHistoryEntry[]) {
  const wrapper = mount(AgentHistoryModal, {
    props: {
      show: false,
      sessionHistory,
      paneCount: 1,
      revivingPaneId: '',
      unavailablePaneIds: new Set<string>(),
      previewOpen: false,
      previewTitle: '',
      previewContent: '',
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

describe('AgentHistoryModal go-to-pane action', () => {
  it('offers go-to-pane (not resume, not delete) for an active entry', async () => {
    const wrapper = await mountModal([entry()])

    const focusBtn = wrapper.find('.ah-focus')
    expect(focusBtn.exists()).toBe(true)
    expect(focusBtn.text()).toContain('action.open-pane')
    // Resuming a live session would fork a second one; deleting a live
    // record is ambiguous while its pane keeps running.
    expect(wrapper.text()).not.toContain('action.resume-session')
    expect(wrapper.find('.ah-delete').exists()).toBe(false)

    await focusBtn.trigger('click')
    const emitted = wrapper.emitted('focus-pane')
    expect(emitted).toHaveLength(1)
    expect((emitted![0][0] as SpawnHistoryEntry).paneId).toBe('aaaa1111-2222')
  })

  it('keeps the full-log action reachable for active entries', async () => {
    const wrapper = await mountModal([entry()])

    const preview = wrapper.find('.ah-preview')
    expect(preview.exists()).toBe(true)
    await preview.trigger('click')
    expect(wrapper.emitted('preview')).toHaveLength(1)
  })

  it('offers resume and delete (not go-to-pane) for a removed entry', async () => {
    const wrapper = await mountModal([entry({ removedAt: '2026-08-08T11:00:00Z' })])

    expect(wrapper.find('.ah-focus').exists()).toBe(false)
    expect(wrapper.text()).toContain('action.resume-session')
    expect(wrapper.find('.ah-delete').exists()).toBe(true)
  })

  it('double-clicking an active row jumps to its pane', async () => {
    const wrapper = await mountModal([entry()])

    await wrapper.get('.agent-history-row').trigger('dblclick')

    expect(wrapper.emitted('focus-pane')).toHaveLength(1)
  })

  it('double-clicking a removed row does nothing (its pane is gone)', async () => {
    const wrapper = await mountModal([entry({ removedAt: '2026-08-08T11:00:00Z' })])

    await wrapper.get('.agent-history-row').trigger('dblclick')

    expect(wrapper.emitted('focus-pane')).toBeUndefined()
  })
})

describe('AgentHistoryModal closeTopLayer', () => {
  it('closes the cleanup dropdown before reporting the modal can close', async () => {
    const wrapper = await mountModal([entry()])
    const vm = wrapper.vm as unknown as { closeTopLayer: () => boolean }

    // Nothing open: Escape belongs to the modal itself.
    expect(vm.closeTopLayer()).toBe(false)

    await wrapper.get('.ah-cleanup-btn').trigger('click')
    expect(wrapper.find('.ah-menu-backdrop').exists()).toBe(true)

    expect(vm.closeTopLayer()).toBe(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ah-menu-backdrop').exists()).toBe(false)
    expect(vm.closeTopLayer()).toBe(false)
  })

  it('closes the kill-all confirmation before the modal', async () => {
    const wrapper = await mountModal([entry()])
    const vm = wrapper.vm as unknown as { closeTopLayer: () => boolean }

    await wrapper.get('.history-killall').trigger('click')
    expect(wrapper.text()).toContain('label.kill-all-confirm-title')

    expect(vm.closeTopLayer()).toBe(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('label.kill-all-confirm-title')
  })
})
