// @vitest-environment happy-dom
// Files opened from outside the editor window's workspace carry their own
// workspace root (`wsPath` = the file's parent directory). These tests pin the
// consequences: tab identity is (workspace, relPath), each pane reads/writes
// against its own tab's root, and an explorer rename in the window's workspace
// can never repoint a tab that belongs to another root.
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import EditorWindowApp from '../../EditorWindowApp.vue'
import { i18n } from '../../i18n'

i18n.global.locale.value = 'en-US'

function stub(name: string, props: string[] = []) {
  return {
    __esModule: true,
    default: defineComponent({
      name,
      props,
      inheritAttrs: false,
      render: () => h('div', { class: `stub-${name}` }),
    }),
  }
}

vi.mock('../../components/ExplorerPane.vue', () => stub('ExplorerPane'))
vi.mock('../../components/SearchPane.vue', () => stub('SearchPane'))
vi.mock('../../components/GitPane.vue', () => stub('GitPane'))
vi.mock('../../components/ProblemsPane.vue', () => stub('ProblemsPane'))
vi.mock('../../components/AiCliTerminal.vue', () => stub('AiCliTerminal'))
vi.mock('../../components/NotificationHost.vue', () => stub('NotificationHost'))
// Declared props so the host's per-tab bindings are assertable.
vi.mock('../EditorPane.vue', () => stub('EditorPane', ['workspacePath', 'relPath', 'name']))
vi.mock('../PlanFileView.vue', () => stub('PlanFileView', ['workspacePath', 'relPath']))
vi.mock('../DiffPane.vue', () => stub('DiffPane'))
vi.mock('../ConflictPane.vue', () => stub('ConflictPane'))
vi.mock('../BranchDiffPane.vue', () => stub('BranchDiffPane'))
vi.mock('../FilePreviewPane.vue', () => stub('FilePreviewPane', ['workspacePath', 'relPath']))

vi.mock('../../composables/useBackend', () => ({
  useBackend: () => ({
    status: ref('connected'),
    wsUrl: ref(''),
    httpUrl: ref('http://127.0.0.1:1'),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async () => ({ payload: { ok: true } })),
    on: vi.fn(() => () => {}),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  }),
}))

vi.mock('../../lib/settings', () => ({
  initSettingsBackend: vi.fn(),
  settingsGet: vi.fn((_key: string, def: unknown) => def),
  settingsSet: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {}),
}))

vi.mock('../../composables/useNotify', () => ({
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }),
}))

vi.mock('../../composables/useTheme', () => ({
  useTheme: () => ({ theme: ref('dark'), setTheme: vi.fn(), loadTheme: vi.fn() }),
  BUILTIN_THEMES: [],
}))

vi.mock('../../keybindings/useKeybindings', () => ({
  useKeybindings: vi.fn(),
  registerCommand: vi.fn(),
  setContext: vi.fn(),
  executeCommand: vi.fn(),
}))

async function mountApp(): Promise<VueWrapper> {
  const wrapper = mount(EditorWindowApp, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

// The harness has no ?workspace_path=, so the window workspace is '' and any
// tab with a wsPath of its own counts as external.
async function open(wrapper: VueWrapper, filepath: string, wsPath?: string): Promise<void> {
  wrapper.findComponent({ name: 'ExplorerPane' }).vm.$emit('open-file', { filepath, wsPath })
  await flushPromises()
}

function panes(wrapper: VueWrapper) {
  return wrapper.findAllComponents({ name: 'EditorPane' })
}

describe('EditorWindowApp – files outside the workspace', () => {
  it('opens same-named files from two roots as two independent tabs', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'notes.txt')
    await open(wrapper, 'notes.txt', '/ext/dir')

    const tabs = wrapper.findAll('.ide-tab')
    expect(tabs).toHaveLength(2)
    expect(tabs.map((t) => t.find('.ide-tab-name').text())).toEqual(['notes.txt', 'notes.txt'])
    expect(panes(wrapper)).toHaveLength(2)
  })

  it('reuses the tab when the same external file is opened again', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'notes.txt', '/ext/dir')
    await open(wrapper, 'notes.txt', '/ext/dir')
    expect(wrapper.findAll('.ide-tab')).toHaveLength(1)
  })

  it('gives each pane its own tab workspace, so saves target the right root', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'notes.txt')
    await open(wrapper, 'notes.txt', '/ext/dir')

    const [inside, outside] = panes(wrapper)
    expect(inside.props('workspacePath')).toBe('')
    expect(inside.props('relPath')).toBe('notes.txt')
    // The external pane reads and writes through its own parent directory —
    // the backend's root check passes and the file resolves to /ext/dir/notes.txt.
    expect(outside.props('workspacePath')).toBe('/ext/dir')
    expect(outside.props('relPath')).toBe('notes.txt')
  })

  it('shows the absolute path in the tab tooltip for an external file only', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'docs/notes.txt')
    await open(wrapper, 'notes.txt', '/ext/dir')

    const tabs = wrapper.findAll('.ide-tab')
    expect(tabs[0].attributes('title')).toBe('docs/notes.txt')
    expect(tabs[1].attributes('title')).toBe('/ext/dir/notes.txt')
  })

  it('does not repoint an external tab when the explorer renames a same-named file', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'notes.txt')
    await open(wrapper, 'notes.txt', '/ext/dir')

    wrapper
      .findComponent({ name: 'ExplorerPane' })
      .vm.$emit('entry-renamed', { oldRel: 'notes.txt', newRel: 'renamed.txt' })
    await flushPromises()

    const [inside, outside] = panes(wrapper)
    expect(inside.props('relPath')).toBe('renamed.txt')
    // Rewriting this one would silently redirect its next save into the
    // workspace copy of the file.
    expect(outside.props('relPath')).toBe('notes.txt')
    expect(outside.props('workspacePath')).toBe('/ext/dir')
  })

  it('keeps per-tab view mode independent for same-named files', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'notes.md')
    await open(wrapper, 'notes.md', '/ext/dir')

    // The external tab is active; toggling preview must not flip the other one.
    await wrapper.find('.ide-tab-act--preview-toggle').trigger('click')
    const preview = wrapper.findAllComponents({ name: 'PlanFileView' })
    expect(preview).toHaveLength(1)
    expect(preview[0].props('workspacePath')).toBe('/ext/dir')
    expect(panes(wrapper)).toHaveLength(1)
  })
})
