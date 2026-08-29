// @vitest-environment happy-dom
// Every workspace heading carries a history button, and the modal now answers
// for the heading that opened it WITHOUT switching to that project. Two things
// follow: it has to say whose history is on screen, and kill-all — which
// sweeps the workspace on screen, not the one listed — must not be offered.
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

async function mountModal(props: Record<string, unknown> = {}) {
  const wrapper = mount(AgentHistoryModal, {
    props: {
      show: false,
      sessionHistory: [entry({ removedAt: '2026-08-08T11:00:00Z' })],
      paneCount: 3,
      revivingPaneId: '',
      unavailablePaneIds: new Set<string>(),
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

describe('AgentHistoryModal – whose history is on screen', () => {
  it('names the project when it is not the workspace on screen', async () => {
    const wrapper = await mountModal({ viewingWorkspace: 'beta' })
    expect(wrapper.find('.ah-ws-chip').text()).toBe('beta')
  })

  it('shows no chip for the ordinary case', async () => {
    // The workspace on screen needs no label — that is what the window is.
    const wrapper = await mountModal()
    expect(wrapper.find('.ah-ws-chip').exists()).toBe(false)
  })

  it('withholds kill-all while showing another project', async () => {
    // Kill-all sweeps the workspace ON SCREEN. Offering it here would kill the
    // panes of a project this list does not show, and kill is unrecoverable.
    const wrapper = await mountModal({ viewingWorkspace: 'beta' })
    expect(wrapper.find('.history-killall').exists()).toBe(false)
  })

  it('still offers kill-all for the workspace on screen', async () => {
    const wrapper = await mountModal()
    expect(wrapper.find('.history-killall').exists()).toBe(true)
  })
})
