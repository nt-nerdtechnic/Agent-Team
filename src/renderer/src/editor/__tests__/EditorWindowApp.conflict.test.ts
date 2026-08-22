// @vitest-environment happy-dom
// ConflictPane's `mergeAborted` guard used to be dead code here: the mini-IDE
// mounted the pane without ever passing the prop, so a merge aborted in
// another window left the tab happily writing to a file git no longer
// considered unmerged. This window owns no git composable (GitPane keeps its
// own), so the unmerged paths come from `git.list_conflicts`, re-read on the
// backend's `git.changed` broadcast.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import EditorWindowApp from '../../EditorWindowApp.vue'
import { registerCommand } from '../../keybindings/useKeybindings'
import { i18n } from '../../i18n'

i18n.global.locale.value = 'en-US'

const WS = '/ws'

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
vi.mock('../PlanFileView.vue', () => stub('PlanFileView'))
vi.mock('../EditorPane.vue', () => stub('EditorPane'))
vi.mock('../DiffPane.vue', () => stub('DiffPane'))
vi.mock('../BranchDiffPane.vue', () => stub('BranchDiffPane'))
vi.mock('../FilePreviewPane.vue', () => stub('FilePreviewPane'))
vi.mock('../ConflictPane.vue', () =>
  stub('ConflictPane', ['workspacePath', 'filepath', 'name', 'backend', 'mergeAborted']))

// The unmerged paths `git.list_conflicts` answers with, per test.
const conflicts = vi.hoisted(() => ({ ok: true, paths: [] as string[] }))
const sends = vi.hoisted(() => ({ calls: [] as { type: string; payload: Record<string, unknown> }[] }))
// The backend broadcast listeners the window registers at mount.
const listeners = vi.hoisted(() => new Map<string, (p: unknown) => void>())

vi.mock('../../composables/useBackend', () => ({
  useBackend: () => ({
    status: ref('connected'),
    wsUrl: ref(''),
    httpUrl: ref('http://127.0.0.1:1'),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
      sends.calls.push({ type, payload })
      if (type === 'git.list_conflicts') {
        return {
          ok: true,
          payload: {
            ok: conflicts.ok,
            conflicts: conflicts.paths.map((p) => ({ path: p, kind: 'both-modified' })),
          },
        }
      }
      return { ok: true, payload: { ok: true } }
    }),
    on: vi.fn((type: string, cb: (p: unknown) => void) => {
      listeners.set(type, cb)
      return () => listeners.delete(type)
    }),
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
  initKeybindingsPort: vi.fn(),
  useKeybindings: vi.fn(),
  registerCommand: vi.fn(),
  setContext: vi.fn(),
  executeCommand: vi.fn(),
}))

beforeEach(() => {
  vi.useRealTimers()
  conflicts.ok = true
  conflicts.paths = ['src/c.ts']
  sends.calls.length = 0
  listeners.clear()
  Object.assign(window, {
    agentTeam: {
      onSwitchEditorSidebar: vi.fn(),
      onOpenEditorFile: vi.fn(),
      onOpenEditorDiff: vi.fn(),
      onOpenEditorBranchDiff: vi.fn(),
      pickFile: vi.fn(async () => ({ ok: false })),
      realpath: vi.fn(async (p: string) => p),
      openEditorWindow: vi.fn(async () => undefined),
    },
    nav: { onOpenTarget: () => () => {} },
  })
})

async function mountApp(): Promise<VueWrapper> {
  window.history.replaceState({}, '', `/?window=editor&workspace_path=${WS}`)
  const wrapper = mount(EditorWindowApp, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

/** GitPane's `open-conflict` emit is the production path into a conflict tab. */
async function openConflict(wrapper: VueWrapper, filepath: string): Promise<void> {
  wrapper.findComponent({ name: 'GitPane' }).vm.$emit('open-conflict', { filepath })
  await flushPromises()
}

function pane(wrapper: VueWrapper) {
  return wrapper.findComponent({ name: 'ConflictPane' })
}

describe('EditorWindowApp – conflict tabs know when the merge is gone', () => {
  it('reads the unmerged paths when a conflict tab opens', async () => {
    const wrapper = await mountApp()
    expect(sends.calls.some((c) => c.type === 'git.list_conflicts')).toBe(false)

    await openConflict(wrapper, 'src/c.ts')
    const call = sends.calls.find((c) => c.type === 'git.list_conflicts')
    expect(call).toBeDefined()
    expect(call!.payload).toEqual({ workspace_path: WS })
  })

  it('passes mergeAborted=false while the file is still unmerged', async () => {
    const wrapper = await mountApp()
    await openConflict(wrapper, 'src/c.ts')
    expect(pane(wrapper).exists()).toBe(true)
    expect(pane(wrapper).props('filepath')).toBe('src/c.ts')
    expect(pane(wrapper).props('mergeAborted')).toBe(false)
  })

  it('flips mergeAborted when a git.changed broadcast shows the merge is over', async () => {
    vi.useFakeTimers()
    const wrapper = await mountApp()
    await openConflict(wrapper, 'src/c.ts')
    expect(pane(wrapper).props('mergeAborted')).toBe(false)

    conflicts.paths = []
    listeners.get('git.changed')?.({ workspace_path: WS })
    // Debounced like useGit's own listener — nothing happens before it fires.
    await flushPromises()
    expect(pane(wrapper).props('mergeAborted')).toBe(false)

    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(pane(wrapper).props('mergeAborted')).toBe(true)
    vi.useRealTimers()
  })

  it('only aborts the file that left the list', async () => {
    conflicts.paths = ['src/c.ts', 'src/d.ts']
    const wrapper = await mountApp()
    await openConflict(wrapper, 'src/c.ts')
    await openConflict(wrapper, 'src/d.ts')

    conflicts.paths = ['src/d.ts']
    await openConflict(wrapper, 'src/d.ts') // re-open reuses the tab and re-reads
    await flushPromises()

    const panes = wrapper.findAllComponents({ name: 'ConflictPane' })
    expect(panes).toHaveLength(2)
    expect(panes.map((p) => [p.props('filepath'), p.props('mergeAborted')])).toEqual([
      ['src/c.ts', true],
      ['src/d.ts', false],
    ])
  })

  it('never declares a merge aborted off a failed read', async () => {
    conflicts.ok = false
    const wrapper = await mountApp()
    await openConflict(wrapper, 'src/c.ts')
    expect(pane(wrapper).props('mergeAborted')).toBe(false)
  })

  it('ignores git.changed while no conflict tab is open', async () => {
    const wrapper = await mountApp()
    expect(wrapper.findComponent({ name: 'ConflictPane' }).exists()).toBe(false)
    listeners.get('git.changed')?.({ workspace_path: WS })
    await flushPromises()
    expect(sends.calls.some((c) => c.type === 'git.list_conflicts')).toBe(false)
  })
})

// ⌘W reached this window for the first time when main/menu.ts stopped
// installing the `close` role on macOS — until then the menu closed the whole
// window and the rule never ran. onAppKeydown's old bubble-phase handler
// declined while a text input had focus; the command has to do the same, or
// ⌘W in the find box closes the tab out from under it.
describe('EditorWindowApp – closeActiveEditor yields to a focused text input', () => {
  /** The last handler registered for a command — one per mount. */
  function handlerFor(id: string): (() => unknown) | undefined {
    const calls = vi.mocked(registerCommand).mock.calls.filter(([cid]) => cid === id)
    return calls.at(-1)?.[1] as (() => unknown) | undefined
  }

  it('declines, so the keystroke still reaches the input', async () => {
    const wrapper = await mountApp()
    await openConflict(wrapper, 'src/c.ts')
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    try {
      // Exactly `false` is the dispatcher's "not handled" signal: it is what
      // keeps preventDefault() from firing.
      expect(handlerFor('workbench.action.closeActiveEditor')!()).toBe(false)
      await flushPromises()
      expect(pane(wrapper).exists()).toBe(true)
    } finally {
      input.remove()
    }
  })

  it('still closes the tab when focus is anywhere else', async () => {
    const wrapper = await mountApp()
    await openConflict(wrapper, 'src/c.ts')
    expect(pane(wrapper).exists()).toBe(true)
    expect(handlerFor('workbench.action.closeActiveEditor')!()).not.toBe(false)
    await flushPromises()
    expect(pane(wrapper).exists()).toBe(false)
  })

  it('still runs from the command palette, which dispatches after it closes', async () => {
    // The palette lists this command (PALETTE_COMMANDS) and runs it as
    // `closePalette(); Promise.resolve().then(() => executeCommand(id))` — the
    // close lands first, so its search box is detached and focus has fallen
    // back to <body> before the guard above looks. A detached input is never
    // document.activeElement, so the guard cannot strand the palette entry.
    const wrapper = await mountApp()
    await openConflict(wrapper, 'src/c.ts')
    const paletteInput = document.createElement('input')
    document.body.appendChild(paletteInput)
    paletteInput.focus()
    paletteInput.remove()
    expect(document.activeElement?.tagName).not.toBe('INPUT')

    expect(handlerFor('workbench.action.closeActiveEditor')!()).not.toBe(false)
    await flushPromises()
    expect(pane(wrapper).exists()).toBe(false)
  })
})
