// @vitest-environment happy-dom
// Deleting an Agent History entry also unlinks its CLI transcript log, so the
// confirmation must state the loss first — it is fed by a backend dry-run and
// the real delete is only emitted after the user confirms.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AgentHistoryModal from '../AgentHistoryModal.vue'
import type {
  HistoryDeletePreview,
  HistoryDeleteTarget,
  SpawnHistoryEntry,
} from '../../lib/spawnHistory'

function entry(paneId: string, overrides: Partial<SpawnHistoryEntry> = {}): SpawnHistoryEntry {
  return {
    paneId,
    agentKey: 'claude',
    agentLabel: 'Claude',
    roleKey: 'dev' as SpawnHistoryEntry['roleKey'],
    roleLabel: 'Dev',
    command: 'claude',
    origin: 'manual',
    stageId: 'dev' as SpawnHistoryEntry['stageId'],
    workspacePath: '/ws',
    spawnedAt: '2026-07-01T00:00:00Z',
    removedAt: '2026-07-02T00:00:00Z',
    ...overrides,
  }
}

function mountModal(
  previewDelete?: (target: HistoryDeleteTarget) => Promise<HistoryDeletePreview | null>,
  sessionHistory: SpawnHistoryEntry[] = [entry('aaaa1111-2222')]
) {
  return mount(AgentHistoryModal, {
    props: {
      show: true,
      sessionHistory,
      paneCount: 0,
      revivingPaneId: '',
      unavailablePaneIds: new Set<string>(),
      activePaneIds: new Set<string>(),
      previewOpen: false,
      previewTitle: '',
      previewContent: '',
      previewDelete,
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

async function selectFirstEntry(wrapper: ReturnType<typeof mountModal>): Promise<void> {
  await wrapper.get('.agent-history-row').trigger('click')
}

describe('AgentHistoryModal delete confirmation', () => {
  it('dry-runs first and only emits delete after confirming', async () => {
    const previewDelete = vi.fn(async () => ({
      entries: 1,
      logFiles: 1,
      freedBytes: 2048,
    }))
    const wrapper = mountModal(previewDelete)
    await selectFirstEntry(wrapper)

    await wrapper.get('.ah-revive.ah-delete').trigger('click')
    await wrapper.vm.$nextTick()

    expect(previewDelete).toHaveBeenCalledWith({ mode: 'ids', paneIds: ['aaaa1111-2222'] })
    // Confirmation is up, nothing deleted yet.
    expect(wrapper.emitted('delete')).toBeUndefined()
    const notice = wrapper.get('[data-testid="history-delete-logs"]')
    expect(notice.text()).toContain('"files":1')
    expect(notice.text()).toContain('2.0 KB')

    await wrapper.get('.danger').trigger('click')

    expect(wrapper.emitted('delete')).toHaveLength(1)
    expect(previewDelete).toHaveBeenCalledTimes(1)
  })

  it('cancelling leaves the entry alone', async () => {
    const previewDelete = vi.fn(async () => ({ entries: 1, logFiles: 1, freedBytes: 10 }))
    const wrapper = mountModal(previewDelete)
    await selectFirstEntry(wrapper)

    await wrapper.get('.ah-revive.ah-delete').trigger('click')
    await wrapper.vm.$nextTick()
    // Last .history-close is the confirm dialog's cancel button (the modal
    // header's ✕ comes first in DOM order).
    const closers = wrapper.findAll('.history-close')
    await closers[closers.length - 1].trigger('click')

    expect(wrapper.emitted('delete')).toBeUndefined()
    expect(wrapper.find('[data-testid="history-delete-logs"]').exists()).toBe(false)
  })

  it('confirms without the figures when the dry-run fails', async () => {
    const previewDelete = vi.fn(async () => null)
    const wrapper = mountModal(previewDelete)
    await selectFirstEntry(wrapper)

    await wrapper.get('.ah-revive.ah-delete').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="history-delete-logs"]').exists()).toBe(false)
    await wrapper.get('.danger').trigger('click')
    expect(wrapper.emitted('delete')).toHaveLength(1)
  })

  it('skips the dialog when the dry-run says nothing would be removed', async () => {
    const previewDelete = vi.fn(async () => ({ entries: 0, logFiles: 0, freedBytes: 0 }))
    const wrapper = mountModal(previewDelete)
    await selectFirstEntry(wrapper)

    await wrapper.get('.ah-revive.ah-delete').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="history-delete-logs"]').exists()).toBe(false)
    expect(wrapper.emitted('delete')).toHaveLength(1)
  })

  it('dry-runs the bulk cleanup and reports the full-store count', async () => {
    const previewDelete = vi.fn(async () => ({
      entries: 12,
      logFiles: 9,
      freedBytes: 1024 * 1024,
    }))
    const wrapper = mountModal(previewDelete)

    await wrapper.get('.ah-cleanup-btn').trigger('click')
    await wrapper.get('.ah-cleanup-item').trigger('click')
    await wrapper.vm.$nextTick()

    expect(previewDelete).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'removed' })
    )
    expect(wrapper.emitted('cleanup')).toBeUndefined()
    // The dry-run count wins over the loaded-window count (1 entry here).
    expect(wrapper.text()).toContain('label.history-cleanup-confirm-count {"count":12}')
    expect(wrapper.get('[data-testid="history-cleanup-logs"]').text()).toContain('1.0 MB')

    await wrapper.get('.danger').trigger('click')

    expect(wrapper.emitted('cleanup')).toHaveLength(1)
  })

  // The dry-run is awaited, so the modal can close (or the selection can move)
  // while it is in flight. A late result must never resurrect or re-target a
  // destructive confirmation.
  it('never resurrects the cleanup confirmation after the modal closes', async () => {
    let resolvePreview!: (preview: HistoryDeletePreview) => void
    const previewDelete = vi.fn(
      () => new Promise<HistoryDeletePreview | null>((resolve) => { resolvePreview = resolve })
    )
    const wrapper = mountModal(previewDelete)

    await wrapper.get('.ah-cleanup-btn').trigger('click')
    await wrapper.get('.ah-cleanup-item').trigger('click')
    // Modal closed while the dry-run is still in flight.
    await wrapper.setProps({ show: false })
    resolvePreview({ entries: 12, logFiles: 9, freedBytes: 1024 })
    await flushPromises()

    expect(wrapper.text()).not.toContain('label.history-cleanup-confirm-count')
    // …and it must not be waiting to pop up the next time the modal opens.
    await wrapper.setProps({ show: true })
    await flushPromises()
    expect(wrapper.text()).not.toContain('label.history-cleanup-confirm-count')
    expect(wrapper.emitted('cleanup')).toBeUndefined()
  })

  it('keeps the delete dialog on the entry the dry-run ran for', async () => {
    let resolvePreview!: (preview: HistoryDeletePreview) => void
    const previewDelete = vi.fn(
      () => new Promise<HistoryDeletePreview | null>((resolve) => { resolvePreview = resolve })
    )
    const wrapper = mountModal(previewDelete, [
      entry('aaaa1111-2222', { customName: 'Alpha' }),
      entry('bbbb3333-4444', { customName: 'Bravo' }),
    ])
    const rows = wrapper.findAll('.agent-history-row')
    const alphaRow = rows.find((r) => r.text().includes('Alpha'))!
    const bravoRow = rows.find((r) => r.text().includes('Bravo'))!

    await alphaRow.trigger('click')
    await wrapper.get('.ah-revive.ah-delete').trigger('click')
    // Selection moves to another entry while Alpha's dry-run is in flight.
    await bravoRow.trigger('click')
    resolvePreview({ entries: 1, logFiles: 2, freedBytes: 4096 })
    await flushPromises()

    expect(previewDelete).toHaveBeenCalledWith({ mode: 'ids', paneIds: ['aaaa1111-2222'] })
    expect(wrapper.text()).toContain('label.history-delete-confirm {"name":"Alpha"}')
    expect(wrapper.text()).not.toContain('"name":"Bravo"')
    expect(wrapper.get('[data-testid="history-delete-logs"]').text()).toContain('4.0 KB')

    await wrapper.get('.danger').trigger('click')
    expect(wrapper.emitted('delete')).toHaveLength(1)
    expect((wrapper.emitted('delete')![0][0] as SpawnHistoryEntry).paneId).toBe('aaaa1111-2222')
  })

  it('still confirms the cleanup when the dry-run finds nothing in the store', async () => {
    // Mirror-only entries (or a peer that already cleaned) make the store
    // count 0 while the loaded window still shows them — the user must get a
    // dialog, and confirming re-syncs the list.
    const previewDelete = vi.fn(async () => ({ entries: 0, logFiles: 0, freedBytes: 0 }))
    const wrapper = mountModal(previewDelete)

    await wrapper.get('.ah-cleanup-btn').trigger('click')
    await wrapper.get('.ah-cleanup-item').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('label.history-cleanup-confirm-count {"count":1}')
    await wrapper.get('.danger').trigger('click')
    expect(wrapper.emitted('cleanup')).toHaveLength(1)
  })
})

// App.vue mounts backend/terminal/onboarding lifecycles, so it isn't
// practical to mount here (see App.logPreview.test.ts) — the source text
// guards the one mistake that would be catastrophic: a preview probe that
// forgets `dry_run` and therefore deletes what it was only asked about.
describe('App.vue previewHistoryDelete', () => {
  it('probes with dry_run set', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/App.vue'),
      'utf8'
    )
    const start = source.indexOf('async function previewHistoryDelete(')
    expect(start, 'previewHistoryDelete should exist').toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}', start))
    expect(body).toContain('dry_run: true')
    expect(body).toContain("'project.delete_spawn_history'")
  })
})
