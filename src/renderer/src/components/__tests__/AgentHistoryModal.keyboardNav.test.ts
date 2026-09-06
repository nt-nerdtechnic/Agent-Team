// @vitest-environment happy-dom
// ↑/↓ browse the history list. The handler sits on the modal root, so it must
// not steal keys from the inputs nested inside it: the rename box and the
// log-search box (which steps matches with ↑/↓) keep their own arrows. Enter
// is left alone everywhere — rows keep their native "select this row", and in
// the search box it must not fire an action out from under a search.
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentHistoryModal from '../AgentHistoryModal.vue'
import type { SpawnHistoryEntry } from '../../lib/spawnHistory'

function entry(paneId: string, overrides: Partial<SpawnHistoryEntry> = {}): SpawnHistoryEntry {
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
    spawnedAt: '2026-08-08T10:21:34Z',
    ...overrides,
  }
}

async function mountModal(
  sessionHistory: SpawnHistoryEntry[],
  // The log-search box is disabled until a log loads, so tests that assert it
  // keeps its own arrow keys must supply one — otherwise the event never lands
  // and the assertion passes for the wrong reason.
  fetchHistoryLog?: () => Promise<{ title: string; content: string } | null>
) {
  const wrapper = mount(AgentHistoryModal, {
    props: {
      show: false,
      sessionHistory,
      paneCount: 1,
      revivingPaneId: '',
      unavailablePaneIds: new Set<string>(),
      activePaneIds: new Set<string>(),
      previewOpen: false,
      previewTitle: '',
      previewContent: '',
      fetchHistoryLog,
    },
    attachTo: document.body,
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

function selectedLabel(wrapper: Awaited<ReturnType<typeof mountModal>>): string {
  return wrapper.get('.agent-history-row.selected').text()
}

describe('AgentHistoryModal keyboard browsing', () => {
  it('walks the list with ArrowDown / ArrowUp', async () => {
    const wrapper = await mountModal([entry('alpha'), entry('bravo'), entry('charlie')])
    // Newest-first: the first entry is auto-selected on open.
    expect(selectedLabel(wrapper)).toContain('alpha')

    await wrapper.get('.history-modal').trigger('keydown', { key: 'ArrowDown' })
    expect(selectedLabel(wrapper)).toContain('bravo')

    await wrapper.get('.history-modal').trigger('keydown', { key: 'ArrowDown' })
    expect(selectedLabel(wrapper)).toContain('charlie')

    await wrapper.get('.history-modal').trigger('keydown', { key: 'ArrowUp' })
    expect(selectedLabel(wrapper)).toContain('bravo')
  })

  it('stops at the ends instead of wrapping', async () => {
    const wrapper = await mountModal([entry('alpha'), entry('bravo')])

    await wrapper.get('.history-modal').trigger('keydown', { key: 'ArrowUp' })
    expect(selectedLabel(wrapper)).toContain('alpha')

    await wrapper.get('.history-modal').trigger('keydown', { key: 'ArrowDown' })
    await wrapper.get('.history-modal').trigger('keydown', { key: 'ArrowDown' })
    expect(selectedLabel(wrapper)).toContain('bravo')
  })

  it('arrows work from the search field, but Enter there does nothing', async () => {
    const wrapper = await mountModal([entry('alpha'), entry('bravo')])
    const search = wrapper.get('.agent-history-search-input')

    await search.trigger('keydown', { key: 'ArrowDown' })
    expect(selectedLabel(wrapper)).toContain('bravo')

    // Enter used to run the selected row's primary action from here, which
    // jumped to that pane and took the modal down with it — while the query
    // was still being typed.
    await search.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('focus-pane')).toBeUndefined()
    expect(wrapper.emitted('resume')).toBeUndefined()
    expect(selectedLabel(wrapper)).toContain('bravo')
  })

  it('Enter while searching leaves a removed entry alone as well', async () => {
    const wrapper = await mountModal([entry('alpha', { removedAt: '2026-08-08T11:00:00Z' })])

    await wrapper.get('.agent-history-search-input').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('resume')).toBeUndefined()
    expect(wrapper.emitted('focus-pane')).toBeUndefined()
  })

  it('leaves the log-search box its own arrow keys', async () => {
    const wrapper = await mountModal(
      [entry('alpha'), entry('bravo')],
      async () => ({ title: 'alpha', content: 'line one\nline two' })
    )
    const logSearch = wrapper.get('.ah-log-search-input')
    expect(logSearch.attributes('disabled')).toBeUndefined()

    await logSearch.trigger('keydown', { key: 'ArrowDown' })

    // Selection must not have moved — those arrows step log matches.
    expect(selectedLabel(wrapper)).toContain('alpha')
  })

  it('leaves the filter dropdowns their own arrow keys', async () => {
    const wrapper = await mountModal([entry('alpha'), entry('bravo')])
    const select = wrapper.get('.history-filter-select').element

    // Dispatched natively rather than via trigger(): preventDefault is what
    // would stop the dropdown from changing its option, so the test has to see
    // the event itself, not just the (unmoved) selection.
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    select.dispatchEvent(ev)
    await flushPromises()

    expect(ev.defaultPrevented).toBe(false)
    expect(selectedLabel(wrapper)).toContain('alpha')
  })

  it('leaves rows their native Enter (select, not jump)', async () => {
    const wrapper = await mountModal([entry('alpha'), entry('bravo')])

    await wrapper.findAll('.agent-history-row')[1].trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('focus-pane')).toBeUndefined()
  })
})
