// @vitest-environment happy-dom
// A pane that is working right now is the one you want to reach, so it is
// lifted out of its day group into a group pinned at the top of the list.
// The rows the arrow keys walk must follow that rendered order — the flat
// filtered list no longer matches what is on screen.
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentHistoryModal from '../AgentHistoryModal.vue'
import type { SpawnHistoryEntry } from '../../lib/spawnHistory'

function entry(paneId: string, spawnedAt: string): SpawnHistoryEntry {
  return {
    paneId,
    agentKey: 'claude',
    agentLabel: 'Claude',
    customName: paneId,
    roleKey: 'dev' as SpawnHistoryEntry['roleKey'],
    roleLabel: 'Dev',
    command: 'claude',
    sessionId: `sess-${paneId}`,
    origin: 'manual',
    stageId: 'dev' as SpawnHistoryEntry['stageId'],
    workspacePath: '/ws',
    spawnedAt,
  }
}

// Newest first, the order App.vue hands the modal.
const HISTORY = [
  entry('newest-idle', new Date().toISOString()),
  entry('working', new Date().toISOString()),
  entry('oldest-idle', '2020-01-02T03:04:05Z'),
]

async function mountModal(activePaneIds: Set<string>) {
  const wrapper = mount(AgentHistoryModal, {
    props: {
      show: false,
      sessionHistory: HISTORY,
      paneCount: 3,
      revivingPaneId: '',
      unavailablePaneIds: new Set<string>(),
      activePaneIds,
      previewOpen: false,
      previewTitle: '',
      previewContent: '',
    },
    attachTo: document.body,
    global: {
      stubs: { teleport: true },
      mocks: { $t: (key: string) => key },
    },
  })
  await wrapper.setProps({ show: true })
  await flushPromises()
  return wrapper
}

const groupTitles = (wrapper: Awaited<ReturnType<typeof mountModal>>): string[] =>
  wrapper.findAll('.ah-group-title').map((el) => el.text())

const rowLabels = (wrapper: Awaited<ReturnType<typeof mountModal>>): string[] =>
  wrapper.findAll('.agent-history-row .ah-badge').map((el) => el.text())

describe('AgentHistoryModal working-now group', () => {
  it('pins a working pane above the day groups and drops it from its day group', async () => {
    const wrapper = await mountModal(new Set(['working']))

    expect(groupTitles(wrapper)).toEqual([
      'label.history-group-active',
      'label.history-group-today',
      'label.history-group-earlier',
    ])
    // Working first, even though a newer entry exists in today's group.
    expect(rowLabels(wrapper)).toEqual(['working', 'newest-idle', 'oldest-idle'])
    wrapper.unmount()
  })

  it('marks the pinned group so it reads as the live one', async () => {
    const wrapper = await mountModal(new Set(['working']))

    const titles = wrapper.findAll('.ah-group-title')
    expect(titles[0].classes()).toContain('running')
    expect(titles[1].classes()).not.toContain('running')
    wrapper.unmount()
  })

  it('shows the plain day grouping when nothing is working', async () => {
    const wrapper = await mountModal(new Set())

    expect(groupTitles(wrapper)).toEqual([
      'label.history-group-today',
      'label.history-group-earlier',
    ])
    expect(rowLabels(wrapper)).toEqual(['newest-idle', 'working', 'oldest-idle'])
    wrapper.unmount()
  })

  it('walks the rendered order with the arrow keys, not the unpinned order', async () => {
    const wrapper = await mountModal(new Set(['working']))

    // Opening selects the first rendered row, which is now the working pane.
    expect(wrapper.find('.agent-history-row.selected .ah-badge').text()).toBe('working')

    await wrapper.get('.history-modal').trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.find('.agent-history-row.selected .ah-badge').text()).toBe('newest-idle')

    await wrapper.get('.history-modal').trigger('keydown', { key: 'ArrowUp' })
    expect(wrapper.find('.agent-history-row.selected .ah-badge').text()).toBe('working')
    wrapper.unmount()
  })
})
