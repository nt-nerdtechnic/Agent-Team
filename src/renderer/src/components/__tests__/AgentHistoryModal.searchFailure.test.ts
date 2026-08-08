// @vitest-environment happy-dom
// The log-content search reads files through the backend and can fail. Folding
// a failure into an empty result set makes the list read as a definitive "no
// session mentions this" when nothing was actually scanned.
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AgentHistoryModal from '../AgentHistoryModal.vue'
import type { SpawnHistoryEntry } from '../../lib/spawnHistory'

function entry(): SpawnHistoryEntry {
  return {
    paneId: 'aaaa1111-2222',
    agentKey: 'claude',
    agentLabel: 'Claude',
    roleKey: 'dev' as SpawnHistoryEntry['roleKey'],
    roleLabel: 'Dev',
    command: 'claude',
    origin: 'manual',
    stageId: 'dev' as SpawnHistoryEntry['stageId'],
    workspacePath: '/ws',
    spawnedAt: '2026-08-08T10:21:34Z',
  }
}

async function mountModal(
  searchHistoryLogContent: (entries: SpawnHistoryEntry[], q: string) => Promise<Set<string>>
) {
  const wrapper = mount(AgentHistoryModal, {
    props: {
      show: false,
      sessionHistory: [entry()],
      paneCount: 0,
      revivingPaneId: '',
      unavailablePaneIds: new Set<string>(),
      previewOpen: false,
      previewTitle: '',
      previewContent: '',
      searchHistoryLogContent,
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

describe('AgentHistoryModal content-search failure', () => {
  it('warns that results are metadata-only when the log scan fails', async () => {
    vi.useFakeTimers()
    try {
      const search = vi.fn(async () => {
        throw new Error('backend down')
      })
      const wrapper = await mountModal(search)

      await wrapper.get(".agent-history-search-input").setValue('needle')
      await vi.advanceTimersByTimeAsync(400)
      await flushPromises()

      expect(search).toHaveBeenCalled()
      expect(wrapper.find('.ah-search-failed').exists()).toBe(true)
      expect(wrapper.text()).toContain('label.history-search-failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows no warning when the scan succeeds with zero matches', async () => {
    vi.useFakeTimers()
    try {
      const search = vi.fn(async () => new Set<string>())
      const wrapper = await mountModal(search)

      await wrapper.get(".agent-history-search-input").setValue('needle')
      await vi.advanceTimersByTimeAsync(400)
      await flushPromises()

      expect(search).toHaveBeenCalled()
      expect(wrapper.find('.ah-search-failed').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the warning once a later search succeeds', async () => {
    vi.useFakeTimers()
    try {
      let fail = true
      const search = vi.fn(async () => {
        if (fail) throw new Error('backend down')
        return new Set<string>(['aaaa1111-2222'])
      })
      const wrapper = await mountModal(search)

      await wrapper.get(".agent-history-search-input").setValue('needle')
      await vi.advanceTimersByTimeAsync(400)
      await flushPromises()
      expect(wrapper.find('.ah-search-failed').exists()).toBe(true)

      fail = false
      await wrapper.get(".agent-history-search-input").setValue('needle2')
      await vi.advanceTimersByTimeAsync(400)
      await flushPromises()

      expect(wrapper.find('.ah-search-failed').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
