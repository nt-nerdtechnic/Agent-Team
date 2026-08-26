// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ExplorerPane from '../ExplorerPane.vue'
import { i18n } from '@navide/ui-foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { BackendStatus } from '../../composables/useBackend'

// Stub useNotify so toast/alert/confirm calls don't throw (shared spies so
// tests can assert on them).
const notify = vi.hoisted(() => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }))
vi.mock('@navide/ui-foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/ui-foundation')>()),
  useNotify: () => notify,
}))

const FILE_ENTRY = {
  name: 'readme.md',
  rel_path: 'readme.md',
  is_dir: false,
  is_hidden: false,
  is_noise: false,
}

const DIR_ENTRY = {
  name: 'src',
  rel_path: 'src',
  is_dir: true,
  is_hidden: false,
  is_noise: false,
}

const SUB_DIR_ENTRY = {
  name: 'sub',
  rel_path: 'src/sub',
  is_dir: true,
  is_hidden: false,
  is_noise: false,
}

/** Minimal DataTransfer stand-in for drop events (happy-dom has no real one). */
function makeDataTransfer(text: string) {
  return { getData: () => text, types: ['text/plain'], files: [], dropEffect: '' }
}

function mountPane(backend: unknown) {
  return mount(ExplorerPane, {
    props: { workspacePath: '/ws', backend: backend as never },
    global: { plugins: [i18n] },
  })
}

function listDirCalls(sent: { type: string }[]): number {
  return sent.filter((s) => s.type === 'fs.list_dir').length
}

describe('ExplorerPane – connection states', () => {
  it('shows "Waiting for backend…" instead of "No items" while not connected', async () => {
    const { backend, sent } = createMockBackend('connecting' as BackendStatus)
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(wrapper.text()).toContain('Waiting for backend')
    expect(wrapper.text()).not.toContain('No items')
    expect(listDirCalls(sent)).toBe(0)
  })

  it('runs the initial load once the backend connects', async () => {
    const { backend, status, setResponse, sent } = createMockBackend('connecting' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY] })
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(listDirCalls(sent)).toBe(0)

    status.value = 'connected'
    await nextTick()
    await flushPromises()
    expect(listDirCalls(sent)).toBe(1)
    expect(wrapper.text()).toContain('readme.md')
  })

  it('shows "No items" only for a genuinely empty directory result', async () => {
    const { backend, setResponse } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [] })
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(wrapper.text()).toContain('No items to display')
    expect(wrapper.text()).not.toContain('Waiting for backend')
  })

  it('renders a truncated note when the listing was capped by the backend', async () => {
    const { backend, setResponse } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY], truncated: true })
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(wrapper.text()).toContain('List truncated')
    expect(wrapper.find('.exp-note.truncated').exists()).toBe(true)
  })

  it('renders an inline error note when expanding a dir fails', async () => {
    const { backend, setResponse } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [DIR_ENTRY] })
    const wrapper = mountPane(backend)
    await flushPromises()

    setResponse('fs.list_dir', { ok: false, error: 'permission denied' })
    await wrapper.find('.exp-row').trigger('click') // expand 'src'
    await flushPromises()

    const note = wrapper.find('.exp-note.error')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('Cannot load directory')
    expect(note.text()).toContain('permission denied')
  })

  it('re-runs the initial load on reconnect after a failed load', async () => {
    const { backend, status, setResponse, sent } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: false, error: 'boom' })
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(listDirCalls(sent)).toBe(1)
    expect(wrapper.text()).toContain('boom')

    // Socket drops: the failed tree reads as "waiting", not an empty dir.
    status.value = 'disconnected'
    await nextTick()
    expect(wrapper.text()).toContain('Waiting for backend')

    // Reconnect: initial load runs again and the tree renders.
    setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY] })
    status.value = 'connected'
    await nextTick()
    await flushPromises()
    expect(listDirCalls(sent)).toBe(2)
    expect(wrapper.text()).toContain('readme.md')
  })
})

describe('ExplorerPane – drag to move', () => {
  function renameCalls(sent: { type: string; payload: Record<string, unknown> }[]) {
    return sent.filter((s) => s.type === 'fs.rename')
  }

  it('moves a file dropped onto a folder row via fs.rename', async () => {
    const { backend, setResponse, sent } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY, DIR_ENTRY] })
    setResponse('fs.rename', { ok: true })
    const wrapper = mountPane(backend)
    await flushPromises()

    await wrapper.find('[data-rel="src"]').trigger('drop', {
      dataTransfer: makeDataTransfer('/ws/readme.md'),
    })
    await flushPromises()

    const renames = renameCalls(sent)
    expect(renames).toHaveLength(1)
    expect(renames[0].payload).toMatchObject({ src_path: 'readme.md', dst_path: 'src/readme.md' })
  })

  it('does not rename when dropped onto the item\'s current parent', async () => {
    const { backend, setResponse, sent } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY, DIR_ENTRY] })
    const wrapper = mountPane(backend)
    await flushPromises()

    // readme.md already lives at the root; dropping on the tree background no-ops.
    await wrapper.find('.exp-tree').trigger('drop', {
      dataTransfer: makeDataTransfer('/ws/readme.md'),
    })
    await flushPromises()

    expect(renameCalls(sent)).toHaveLength(0)
  })

  it('does not rename when a folder is dropped onto its own descendant', async () => {
    const { backend, setResponse, sent } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [DIR_ENTRY] })
    const wrapper = mountPane(backend)
    await flushPromises()

    setResponse('fs.list_dir', { ok: true, entries: [SUB_DIR_ENTRY] })
    await wrapper.find('[data-rel="src"]').trigger('click') // expand 'src'
    await flushPromises()

    await wrapper.find('[data-rel="src/sub"]').trigger('drop', {
      dataTransfer: makeDataTransfer('/ws/src'),
    })
    await flushPromises()

    expect(renameCalls(sent)).toHaveLength(0)
  })

  it('surfaces a name collision as an error alert without overwriting', async () => {
    notify.alert.mockClear()
    const { backend, setResponse, sent } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY, DIR_ENTRY] })
    setResponse('fs.rename', { ok: false, error: 'destination already exists' })
    const wrapper = mountPane(backend)
    await flushPromises()

    await wrapper.find('[data-rel="src"]').trigger('drop', {
      dataTransfer: makeDataTransfer('/ws/readme.md'),
    })
    await flushPromises()

    expect(renameCalls(sent)).toHaveLength(1)
    expect(notify.alert).toHaveBeenCalledWith('destination already exists', { title: 'Error' })
  })
})

describe('ExplorerPane – entry-renamed emission', () => {
  it('emits entry-renamed after a successful drag-to-move', async () => {
    const { backend, setResponse } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY, DIR_ENTRY] })
    setResponse('fs.rename', { ok: true })
    const wrapper = mountPane(backend)
    await flushPromises()

    await wrapper.find('[data-rel="src"]').trigger('drop', {
      dataTransfer: makeDataTransfer('/ws/readme.md'),
    })
    await flushPromises()

    expect(wrapper.emitted('entry-renamed')).toEqual([
      [{ oldRel: 'readme.md', newRel: 'src/readme.md' }],
    ])
  })

  it('does not emit entry-renamed when the move fails', async () => {
    const { backend, setResponse } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY, DIR_ENTRY] })
    setResponse('fs.rename', { ok: false, error: 'destination already exists' })
    const wrapper = mountPane(backend)
    await flushPromises()

    await wrapper.find('[data-rel="src"]').trigger('drop', {
      dataTransfer: makeDataTransfer('/ws/readme.md'),
    })
    await flushPromises()

    expect(wrapper.emitted('entry-renamed')).toBeUndefined()
  })

  it('emits entry-renamed after a successful inline rename', async () => {
    const { backend, setResponse } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY] })
    setResponse('fs.rename', { ok: true })
    const wrapper = mountPane(backend)
    await flushPromises()

    await wrapper.find('[data-rel="readme.md"]').trigger('contextmenu')
    const renameBtn = wrapper
      .findAll('.exp-ctx-item')
      .find((b) => b.text() === 'Rename')
    expect(renameBtn).toBeDefined()
    await renameBtn!.trigger('click')

    const input = wrapper.find('.exp-prompt-input')
    await input.setValue('index.md')
    await input.trigger('keydown.enter')
    await flushPromises()

    expect(wrapper.emitted('entry-renamed')).toEqual([
      [{ oldRel: 'readme.md', newRel: 'index.md' }],
    ])
  })
})
