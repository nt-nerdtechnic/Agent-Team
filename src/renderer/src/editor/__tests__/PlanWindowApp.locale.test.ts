// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, defineComponent, h } from 'vue'
import PlanWindowApp from '../../PlanWindowApp.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { seedSettings, settingsGet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '../../../../../packages/plugin-ui/src/shared/testing'

const backendListeners = new Map<string, Set<(p: unknown) => void>>()

vi.mock('../../composables/useBackend', () => ({
  useBackend: () => ({
    status: ref('connected'),
    wsUrl: ref(''),
    httpUrl: ref('http://127.0.0.1:1'),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async (type: string) => {
      if (type === 'ui.settings.get') return { ok: true, payload: { settings: {} } }
      return { ok: true, payload: { ok: true } }
    }),
    on: vi.fn((type: string, cb: (p: unknown) => void) => {
      if (!backendListeners.has(type)) backendListeners.set(type, new Set())
      backendListeners.get(type)!.add(cb)
      return () => backendListeners.get(type)?.delete(cb)
    }),
  }),
}))

vi.mock('../../plugins/plans/resolvePlanRoot', () => ({
  resolvePlanRoot: vi.fn(async () => '/tmp/demo-ws'),
}))

vi.mock('@navide/plugin-shell', () => ({
  AiCliDock: defineComponent({
    name: 'AiCliDock',
    render: () => h('div', { class: 'stub-dock' }),
  }),
  aiTerminalPaneId: vi.fn(() => 'dock-id'),
  buildPlanCliContext: vi.fn(async () => ''),
}))

vi.mock('../../editor/PlansPane.vue', () => ({
  default: defineComponent({
    name: 'PlansPane',
    render: () => h('div', { class: 'stub-plans-pane' }),
  }),
}))

describe('PlanWindowApp locale propagation', () => {
  let languageCallback: ((locale: string) => void) | null = null

  beforeEach(() => {
    __resetSettingsForTest()
    backendListeners.clear()
    i18n.global.locale.value = 'zh-TW'
    languageCallback = null
    window.agentTeam = {
      ...(window.agentTeam ?? {}),
      onLanguageChanged: (cb: (locale: string) => void) => {
        languageCallback = cb
      },
    } as unknown as typeof window.agentTeam
  })

  it('receives current Host locale from query before first render', () => {
    window.history.replaceState({}, '', 'http://localhost:3000/?window=plans&workspace_path=/tmp/demo-ws&locale=en-US')
    const wrapper = mount(PlanWindowApp, { global: { plugins: [i18n] } })

    expect(i18n.global.locale.value).toBe('en-US')
    expect(settingsGet('agent-team:language', '')).toBe('en-US')
    wrapper.unmount()
  })

  it('falls back to seeded settings when query locale is absent', () => {
    seedSettings({ 'agent-team:language': 'en-US' })
    window.history.replaceState({}, '', 'http://localhost:3000/?window=plans&workspace_path=/tmp/demo-ws')
    const wrapper = mount(PlanWindowApp, { global: { plugins: [i18n] } })

    expect(i18n.global.locale.value).toBe('en-US')
    wrapper.unmount()
  })

  it('updates locale at runtime via agentTeam.onLanguageChanged', () => {
    window.history.replaceState({}, '', 'http://localhost:3000/?window=plans&workspace_path=/tmp/demo-ws&locale=zh-TW')
    const wrapper = mount(PlanWindowApp, { global: { plugins: [i18n] } })
    expect(i18n.global.locale.value).toBe('zh-TW')

    expect(languageCallback).toBeDefined()
    languageCallback!('en-US')

    expect(i18n.global.locale.value).toBe('en-US')

    // Ignores unsupported runtime locales
    languageCallback!('fr-FR')
    expect(i18n.global.locale.value).toBe('en-US')

    wrapper.unmount()
  })

  it('updates locale at runtime via settings broadcast', () => {
    window.history.replaceState({}, '', 'http://localhost:3000/?window=plans&workspace_path=/tmp/demo-ws&locale=zh-TW')
    const wrapper = mount(PlanWindowApp, { global: { plugins: [i18n] } })
    expect(i18n.global.locale.value).toBe('zh-TW')

    const settingsListeners = backendListeners.get('ui.settings_changed')
    expect(settingsListeners).toBeDefined()
    for (const listener of settingsListeners!) {
      listener({ source: 'host', settings: { 'agent-team:language': 'en-US' } })
    }

    expect(i18n.global.locale.value).toBe('en-US')
    wrapper.unmount()
  })
})
