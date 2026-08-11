// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// Coverage for the Active Agents list drag-reorder (mirrors the pane-header
// drop target in TerminalPane.reorderDrop.test.ts): dropping one agent's line
// onto another agent-item (dataTransfer type 'application/x-pane-id') emits
// 'reorder-pane' with (draggedId, targetId); self-drops and non-pane payloads
// are ignored. shallowMount keeps the heavy child panes stubbed; the list
// itself is plain DOM. The agent list lives in the pipeline sidebar tab, so
// the persisted tab is seeded to 'pipeline'.

const minimalProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [
    { id: 'pane-a', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false },
    { id: 'pane-b', agentLabel: 'Codex', status: 'running', command: 'codex', origin: 'manual', isMinimized: false, isCommander: false }
  ],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
  autoAnswerEnabled: false,
  existingProject: null
} as unknown as Record<string, unknown>

/** DragEvent stand-in: happy-dom has no DataTransfer, so dispatch a plain
 *  cancelable Event with a stubbed dataTransfer attached. */
function dragEvent(type: string, paneId: string | null): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(ev, {
    dataTransfer: {
      types: paneId === null ? [] : ['application/x-pane-id'],
      getData: (t: string) => (t === 'application/x-pane-id' ? (paneId ?? '') : ''),
      setData: vi.fn(),
      effectAllowed: ''
    }
  })
  return ev
}

describe('ControlPane – reorder-pane drag & drop on the agent list', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: minimalProps,
      global: { mocks: { $t: (key: string) => key } }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
  })

  function item(idx: number): HTMLElement {
    return wrapper.findAll('.agent-item')[idx].element as HTMLElement
  }

  it('renders one agent-item per pane with a draggable agent-line', () => {
    const lines = wrapper.findAll('.agent-item .agent-line')
    expect(lines).toHaveLength(2)
    expect(lines[0].attributes('draggable')).toBe('true')
  })

  it('emits reorder-pane with (draggedId, targetId) on drop', async () => {
    item(1).dispatchEvent(dragEvent('drop', 'pane-a'))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('reorder-pane')).toEqual([['pane-a', 'pane-b']])
  })

  it('ignores a drop of an agent onto itself', async () => {
    item(0).dispatchEvent(dragEvent('drop', 'pane-a'))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('reorder-pane')).toBeUndefined()
  })

  it('ignores a drop without a pane-id payload (e.g. file drop)', async () => {
    item(0).dispatchEvent(dragEvent('drop', null))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('reorder-pane')).toBeUndefined()
  })

  it('shows drag-over feedback while a pane drag hovers, clears on dragleave', async () => {
    item(1).dispatchEvent(dragEvent('dragover', 'pane-a'))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.agent-item')[1].classes()).toContain('drag-over')

    item(1).dispatchEvent(dragEvent('dragleave', 'pane-a'))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.agent-item')[1].classes()).not.toContain('drag-over')
  })

  it('does not show drag-over feedback for a non-pane drag (no x-pane-id type)', async () => {
    item(1).dispatchEvent(dragEvent('dragover', null))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.agent-item')[1].classes()).not.toContain('drag-over')
  })

  it('does not show drag-over feedback on the item being dragged', async () => {
    const line = wrapper.findAll('.agent-item .agent-line')[0].element as HTMLElement
    line.dispatchEvent(dragEvent('dragstart', 'pane-a'))
    item(0).dispatchEvent(dragEvent('dragover', 'pane-a'))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.agent-item')[0].classes()).not.toContain('drag-over')

    // dragend resets the source flag, so a later foreign drag highlights again.
    line.dispatchEvent(dragEvent('dragend', 'pane-a'))
    item(0).dispatchEvent(dragEvent('dragover', 'pane-b'))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.agent-item')[0].classes()).toContain('drag-over')
  })
})
