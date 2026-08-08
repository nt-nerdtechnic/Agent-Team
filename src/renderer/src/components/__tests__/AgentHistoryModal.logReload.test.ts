// @vitest-environment happy-dom
// A pane spawned while Agent History is open gets auto-selected before its log
// path is known and before the backend has created the log file. The first read
// therefore finds nothing; the modal must read again once the path arrives,
// otherwise "No log found for this session" sticks for a session that is very
// much alive.
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AgentHistoryModal from '../AgentHistoryModal.vue'
import type { SpawnHistoryEntry } from '../../lib/spawnHistory'

function entry(overrides: Partial<SpawnHistoryEntry> = {}): SpawnHistoryEntry {
  return {
    paneId: 'dd069b40-1111',
    agentKey: 'claude',
    agentLabel: 'Claude',
    roleKey: 'dev' as SpawnHistoryEntry['roleKey'],
    roleLabel: 'Dev',
    command: 'claude',
    origin: 'manual',
    stageId: 'dev' as SpawnHistoryEntry['stageId'],
    workspacePath: '/ws',
    spawnedAt: '2026-08-08T10:21:34Z',
    ...overrides,
  }
}

function mountModal(
  fetchHistoryLog: (e: SpawnHistoryEntry) => Promise<{ title: string; content: string } | null>,
  sessionHistory: SpawnHistoryEntry[]
) {
  // App.vue keeps this modal mounted and toggles `show`, so open it after
  // mount — auto-selection only runs once the modal is actually open.
  return mount(AgentHistoryModal, {
    props: {
      show: false,
      sessionHistory,
      paneCount: 0,
      revivingPaneId: '',
      unavailablePaneIds: new Set<string>(),
      previewOpen: false,
      previewTitle: '',
      previewContent: '',
      fetchHistoryLog,
    },
    global: {
      stubs: { teleport: true },
      mocks: {
        $t: (key: string, params?: Record<string, unknown>) =>
          params ? `${key} ${JSON.stringify(params)}` : key,
      },
    },
  })
}

describe('AgentHistoryModal log reload', () => {
  it('re-reads the log when outputLogFile is back-filled onto the selected entry', async () => {
    // Resolves to null until the log path exists — exactly what the spawn-time
    // fallback does when the file has not been created yet.
    const fetchHistoryLog = vi.fn(async (e: SpawnHistoryEntry) =>
      e.outputLogFile ? { title: 'Plan', content: 'hello from the pty' } : null
    )
    const wrapper = mountModal(fetchHistoryLog, [entry()])
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(fetchHistoryLog).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.ah-log-empty').exists()).toBe(true)

    // Spawn completes: App.vue back-fills the real path onto the same entry.
    await wrapper.setProps({
      sessionHistory: [entry({ outputLogFile: '/ws/.agent-team/manual/20260808/claude-dd069b40.log' })],
    })
    await flushPromises()

    expect(fetchHistoryLog).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.ah-log-empty').exists()).toBe(false)
    expect(wrapper.text()).toContain('hello from the pty')
  })

  // "No log found" was shown for missing AND unreadable logs alike, which sent
  // the reader looking for a deleted file when the real cause was an IO error.
  it('shows the real read error instead of the generic "no log" message', async () => {
    const fetchHistoryLog = vi.fn(async () => {
      throw new Error('label.history-log-read-failed {"path":"/ws/log.log"}')
    })
    const wrapper = mountModal(fetchHistoryLog, [entry({ outputLogFile: '/ws/log.log' })])
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.text()).toContain('label.history-log-read-failed')
    expect(wrapper.text()).toContain('/ws/log.log')
    expect(wrapper.text()).not.toContain('label.history-log-none')
    expect(wrapper.find('.ah-log-error').exists()).toBe(true)
  })

  it('still says "no log" when there is genuinely no log path', async () => {
    const fetchHistoryLog = vi.fn(async () => null)
    const wrapper = mountModal(fetchHistoryLog, [entry()])
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.text()).toContain('label.history-log-none')
    expect(wrapper.find('.ah-log-error').exists()).toBe(false)
  })

  it('does not re-read when an unrelated field of the selected entry changes', async () => {
    const fetchHistoryLog = vi.fn(async () => ({ title: 'Plan', content: 'body' }))
    const wrapper = mountModal(fetchHistoryLog, [entry({ outputLogFile: '/ws/log.log' })])
    await wrapper.setProps({ show: true })
    await flushPromises()
    expect(fetchHistoryLog).toHaveBeenCalledTimes(1)

    await wrapper.setProps({
      sessionHistory: [entry({ outputLogFile: '/ws/log.log', autoName: 'renamed' })],
    })
    await flushPromises()

    expect(fetchHistoryLog).toHaveBeenCalledTimes(1)
  })
})
