// @vitest-environment happy-dom
// AiChatDock — the shared right-side AI chat shell (rail toggle + resize +
// lazily mounted AIChatPane) used by the editor / plan / git windows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { i18n } from '../../i18n'

i18n.global.locale.value = 'en-US'

const settingsState = vi.hoisted(() => ({
  stored: {} as Record<string, string>,
  sets: [] as { key: string; value: string }[],
}))

vi.mock('../../lib/settings', () => ({
  settingsGet: vi.fn((key: string, def: string) => settingsState.stored[key] ?? def),
  settingsSet: vi.fn((key: string, value: string) => {
    settingsState.sets.push({ key, value })
  }),
}))

// Async-loaded by the dock (defineAsyncComponent) — the stub keeps the real
// pane's heavy static deps (mermaid/katex) out of the test bundle. It exposes
// a spy so the dock's `pane` expose path is testable.
const paneSpies = vi.hoisted(() => ({ focusInput: vi.fn() }))
vi.mock('../AIChatPane.vue', () => ({
  __esModule: true,
  default: defineComponent({
    name: 'AIChatPane',
    props: {
      workspacePath: String,
      backend: Object,
      // Typed Boolean so the bare `embedded` attribute casts to true.
      embedded: Boolean,
      active: Boolean,
      getEditorContent: Function,
      getEditorSelection: Function,
      getActiveRelPath: Function,
      getOpenFiles: Function,
      insertTextAtCursor: Function,
      openFile: Function,
      saveDirtyFiles: Function,
    },
    inheritAttrs: false,
    setup(_, { expose }) {
      expose(paneSpies)
      return () => h('div', { class: 'stub-AIChatPane' })
    },
  }),
}))

import AiChatDock from '../AiChatDock.vue'

const backend = {
  status: ref('connected'),
  wsUrl: ref(''),
  httpUrl: ref(''),
  shell: ref(''),
  port: ref(0),
  pid: ref(0),
  lastError: ref(''),
  send: vi.fn(async () => ({ payload: { ok: true } })),
  on: vi.fn(() => () => {}),
  restart: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
} as unknown as InstanceType<typeof AiChatDock>['$props']['backend']

const mounted: VueWrapper[] = []
function mountDock(props: Record<string, unknown> = {}): VueWrapper {
  const wrapper = mount(AiChatDock, {
    props: { widthKey: 'test-ai-panel-width', workspacePath: '/tmp/ws', backend, ...props },
    global: { plugins: [i18n] },
  })
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => {
  settingsState.stored = {}
  settingsState.sets.length = 0
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('AiChatDock — lazy mount + keep-alive toggle', () => {
  it('renders only the rail until first open; the pane never pre-mounts', async () => {
    const wrapper = mountDock()
    await flushPromises()
    expect(wrapper.find('.ai-dock-rail-btn').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'AIChatPane' }).exists()).toBe(false)
    // Closed shell: the panel is hidden via v-show.
    const panelEl = wrapper.find('.ai-dock-panel').element as HTMLElement
    expect(panelEl.style.display).toBe('none')
  })

  it('mounts the pane on first toggle and keeps the instance alive when closed', async () => {
    const wrapper = mountDock()
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    await flushPromises()
    const pane = wrapper.findComponent({ name: 'AIChatPane' })
    expect(pane.exists()).toBe(true)
    expect(pane.props('workspacePath')).toBe('/tmp/ws')
    expect(pane.props('embedded')).toBe(true)
    expect(pane.props('active')).toBe(true)
    const panelEl = wrapper.find('.ai-dock-panel').element as HTMLElement
    expect(panelEl.style.display).not.toBe('none')

    // Closing hides via v-show but keeps the instance (chat state preserved).
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    const paneAfter = wrapper.findComponent({ name: 'AIChatPane' })
    expect(paneAfter.exists()).toBe(true)
    expect(paneAfter.props('active')).toBe(false)
    expect(panelEl.style.display).toBe('none')
  })

  it('supports v-model:open (host-driven opening mounts the pane)', async () => {
    const wrapper = mountDock({ open: false, 'onUpdate:open': (v: boolean) => wrapper.setProps({ open: v }) })
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'AIChatPane' }).exists()).toBe(true)
    // The rail button reports back through the model.
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    expect((wrapper.props() as { open?: boolean }).open).toBe(false)
  })

  it('exposes the inner pane instance for host imperative calls', async () => {
    const wrapper = mountDock()
    expect((wrapper.vm as unknown as { pane: unknown }).pane).toBeNull()
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    await flushPromises()
    const pane = (wrapper.vm as unknown as { pane: { focusInput: () => void } }).pane
    expect(pane).toBeTruthy()
    pane.focusInput()
    expect(paneSpies.focusInput).toHaveBeenCalled()
  })
})

describe('AiChatDock — width persistence', () => {
  it('reads the persisted width from widthKey, clamped to 280–600', () => {
    settingsState.stored['test-ai-panel-width'] = '9999'
    const wide = mountDock()
    expect((wide.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('600px')

    settingsState.stored['test-ai-panel-width'] = '10'
    const narrow = mountDock()
    expect((narrow.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('280px')
  })

  it('falls back to defaultWidth when nothing is persisted', () => {
    const wrapper = mountDock({ defaultWidth: 320 })
    expect((wrapper.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('320px')
  })

  it('tracks drag on the handle (clamped) and persists the width on release', async () => {
    const wrapper = mountDock()
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    await wrapper.find('.ai-dock-resize-handle').trigger('mousedown')
    // width = clamp(window.innerWidth - clientX); happy-dom innerWidth = 1024.
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: window.innerWidth - 400 }))
    await flushPromises()
    expect((wrapper.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('400px')
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 }))
    await flushPromises()
    expect((wrapper.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('600px')
    document.dispatchEvent(new MouseEvent('mouseup'))
    expect(settingsState.sets).toEqual([{ key: 'test-ai-panel-width', value: '600' }])
  })
})

describe('AiChatDock — editor callback pass-through', () => {
  it('forwards the optional editor bridge callbacks verbatim to AIChatPane', async () => {
    const callbacks = {
      getEditorContent: () => 'content',
      getEditorSelection: () => 'sel',
      getActiveRelPath: () => 'a.ts',
      getOpenFiles: () => ['a.ts'],
      insertTextAtCursor: vi.fn(),
      openFile: vi.fn(),
      saveDirtyFiles: vi.fn(async () => undefined),
    }
    const wrapper = mountDock(callbacks)
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    await flushPromises()
    const pane = wrapper.findComponent({ name: 'AIChatPane' })
    for (const key of Object.keys(callbacks)) {
      expect(pane.props(key), key).toBe(callbacks[key as keyof typeof callbacks])
    }
  })

  it('leaves the callbacks undefined when the host passes none (plan/git windows)', async () => {
    const wrapper = mountDock()
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    await flushPromises()
    const pane = wrapper.findComponent({ name: 'AIChatPane' })
    expect(pane.props('getEditorContent')).toBeUndefined()
    expect(pane.props('openFile')).toBeUndefined()
  })
})
