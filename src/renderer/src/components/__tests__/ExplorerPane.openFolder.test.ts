// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ExplorerPane from '../ExplorerPane.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'

vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }),
}))

const DIR_ENTRY = {
  name: 'src',
  rel_path: 'src',
  is_dir: true,
  is_hidden: false,
  is_noise: false,
}

const FILE_ENTRY = {
  name: 'readme.md',
  rel_path: 'readme.md',
  is_dir: false,
  is_hidden: false,
  is_noise: false,
}

const t = (key: string): string => i18n.global.t(key)

function itemByLabel(wrapper: VueWrapper, key: string) {
  return wrapper.findAll('.exp-ctx-item').find((el) => el.text().trim() === t(key))
}

describe('ExplorerPane – open folder in editor', () => {
  let wrapper: VueWrapper | undefined
  let openFolderInEditor: ReturnType<typeof vi.fn>
  let listEditors: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openFolderInEditor = vi.fn().mockResolvedValue({ ok: true })
    listEditors = vi.fn().mockResolvedValue([
      { id: 'vscode', command: 'code', available: true },
      { id: 'cursor', command: 'cursor', available: false },
    ])
    ;(window as unknown as Record<string, unknown>).agentTeam = { openFolderInEditor, listEditors }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  async function mountPane() {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: [DIR_ENTRY, FILE_ENTRY] })
    wrapper = mount(ExplorerPane, {
      props: { workspacePath: '/ws', backend: mock.backend as never },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return mock
  }

  /** Right-click the nth rendered row and let the editor probe settle. */
  async function openMenuOnRow(index: number): Promise<void> {
    await wrapper!.findAll('.exp-row')[index].trigger('contextmenu', { clientX: 10, clientY: 10 })
    await flushPromises()
  }

  it('offers the folder-open items on a directory row', async () => {
    await mountPane()
    await openMenuOnRow(0)
    expect(wrapper!.find('.exp-ctx').exists()).toBe(true)
    expect(itemByLabel(wrapper!, 'action.open-in-default-editor')).toBeTruthy()
    expect(wrapper!.find('.exp-ctx-submenu').exists()).toBe(true)
  })

  it('does not offer them on a file row', async () => {
    await mountPane()
    await openMenuOnRow(1)
    expect(itemByLabel(wrapper!, 'action.open-in-default-editor')).toBeUndefined()
    expect(wrapper!.find('.exp-ctx-submenu').exists()).toBe(false)
  })

  it('opens the folder with the default editor using its absolute path', async () => {
    await mountPane()
    await openMenuOnRow(0)
    await itemByLabel(wrapper!, 'action.open-in-default-editor')!.trigger('click')
    expect(openFolderInEditor).toHaveBeenCalledWith('/ws/src', undefined)
    expect(wrapper!.find('.exp-ctx').exists()).toBe(false)
  })

  it('lists the host editors plus only the available detected ones', async () => {
    await mountPane()
    await openMenuOnRow(0)
    const labels = wrapper!.findAll('.exp-ctx-submenu .exp-ctx-item').map((el) => el.text().trim())
    expect(labels).toEqual([
      t('label.editor-mini-ide'),
      t('label.editor-system'),
      t('label.editor-vscode'),
    ])
  })

  it('routes a submenu pick to the chosen editor', async () => {
    await mountPane()
    await openMenuOnRow(0)
    const targets = wrapper!.findAll('.exp-ctx-submenu .exp-ctx-item')
    await targets[targets.length - 1].trigger('click')
    expect(openFolderInEditor).toHaveBeenCalledWith('/ws/src', 'vscode')
  })

  it('re-probes on reopen so a newly installed editor shows up', async () => {
    // Main caches detection, so the round trip is cheap; latching it here
    // instead would hide an editor installed since the menu first opened.
    await mountPane()
    await openMenuOnRow(0)
    document.dispatchEvent(new MouseEvent('click'))
    await openMenuOnRow(0)
    expect(listEditors).toHaveBeenCalledTimes(2)
  })

  it('hides the folder-open items when the host bridge is missing', async () => {
    delete (window as unknown as Record<string, unknown>).agentTeam
    await mountPane()
    await openMenuOnRow(0)
    expect(wrapper!.find('.exp-ctx').exists()).toBe(true)
    expect(itemByLabel(wrapper!, 'action.open-in-default-editor')).toBeUndefined()
    expect(wrapper!.find('.exp-ctx-submenu').exists()).toBe(false)
  })
})
