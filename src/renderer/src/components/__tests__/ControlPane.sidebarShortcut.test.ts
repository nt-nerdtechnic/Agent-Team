// @vitest-environment happy-dom
// Cmd+1..5 sidebar-tab switching.
//
// These used to be a bare `document.addEventListener('keydown')` inside
// ControlPane, outside the keybinding system — which meant Settings could
// neither list nor rebind them, and unbinding Cmd+1 there still left the
// listener switching tabs. They are ordinary commands now
// (`controlPane.selectSidebarTab1..5`, bound in defaults.ts under
// `paneStage && !editorOpen`), so this drives them through the real
// capture-phase dispatcher instead of dispatching on `document`.
//
// Every behavioural guarantee from the old listener is still asserted here:
// bare Cmd must not blank the panel, out-of-range digits and Cmd+Shift+<n> must
// be ignored, and the shortcut must not fire while a text field has focus.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { shallowMount, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import ControlPane from '../ControlPane.vue'
import { useKeybindings, setContext, _resetKeybindingsState } from '../../keybindings/useKeybindings'
import { _resetRegistry } from '../../keybindings/commandRegistry'

const minimalProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: {},
  autoAnswerEnabled: false,
  existingProject: null
} as unknown as Record<string, unknown>

/** Hosts the shared capture-phase dispatcher the real app installs in App.vue. */
const Dispatcher = defineComponent({
  setup() {
    useKeybindings()
    return () => h('div')
  },
})

function keydown(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

/** Active tab off the nav: 0=agents, 1=pipeline, 2=explorer, 3=git, 4=plans. */
function activeTab(wrapper: VueWrapper): 'agents' | 'pipeline' | 'explorer' | 'git' | 'plans' | null {
  const order = ['agents', 'pipeline', 'explorer', 'git', 'plans'] as const
  const btns = wrapper.findAll('.sidebar-tabs .tab-btn')
  const idx = btns.findIndex((b) => b.classes().includes('active'))
  return idx >= 0 ? order[idx] : null
}

describe('ControlPane – Cmd+number sidebar shortcut', () => {
  let wrapper: VueWrapper
  let dispatcher: VueWrapper

  beforeEach(() => {
    _resetRegistry()
    _resetKeybindingsState()
    sessionStorage.setItem('agentTeam.sidebarTab', 'explorer')
    dispatcher = mount(Dispatcher)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: minimalProps,
      global: { mocks: { $t: (key: string) => key } }
    })
    // The main window is the only one that sets this; the rules are scoped to it.
    setContext('paneStage', true)
    setContext('editorOpen', false)
  })

  afterEach(() => {
    wrapper.unmount()
    dispatcher.unmount()
    sessionStorage.clear()
  })

  it('starts on the explorer tab', () => {
    expect(activeTab(wrapper)).toBe('explorer')
  })

  it('bare Cmd (key=Meta) does NOT change or blank the tab', async () => {
    keydown({ key: 'Meta', metaKey: true })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('explorer')
  })

  it('Cmd+4 switches to the git tab', async () => {
    keydown({ key: '4', metaKey: true, code: 'Digit4' })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('git')
  })

  it('Cmd+5 switches to the plans tab', async () => {
    keydown({ key: '5', metaKey: true, code: 'Digit5' })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('plans')
  })

  it('Cmd+1 switches to the agents tab', async () => {
    keydown({ key: '4', metaKey: true, code: 'Digit4' })
    await wrapper.vm.$nextTick()
    keydown({ key: '1', metaKey: true, code: 'Digit1' })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('agents')
  })

  it('Cmd+3 switches back to the explorer tab', async () => {
    keydown({ key: '4', metaKey: true, code: 'Digit4' })
    await wrapper.vm.$nextTick()
    keydown({ key: '3', metaKey: true, code: 'Digit3' })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('explorer')
  })

  it('out-of-range Cmd+6 is ignored', async () => {
    keydown({ key: '6', metaKey: true, code: 'Digit6' })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('explorer')
  })

  it('Cmd+Shift+3 is ignored (modifier guard keeps the OS screenshot binding free)', async () => {
    keydown({ key: '3', metaKey: true, shiftKey: true, code: 'Digit3' })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('explorer')
  })

  it('does not fire while a text field has focus', async () => {
    // The central dispatcher does not look at e.target, so this guard lives in
    // the command handler. Losing it would hijack Cmd+4 while typing.
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    keydown({ key: '4', metaKey: true, code: 'Digit4' })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('explorer')

    input.remove()
  })

  it('still fires from the xterm helper textarea, which is not real text entry', async () => {
    const ta = document.createElement('textarea')
    ta.className = 'xterm-helper-textarea'
    document.body.appendChild(ta)
    ta.focus()

    keydown({ key: '4', metaKey: true, code: 'Digit4' })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('git')

    ta.remove()
  })

  it('is scoped to the main window: no paneStage, no tab switch', async () => {
    setContext('paneStage', false)
    keydown({ key: '4', metaKey: true, code: 'Digit4' })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('explorer')
  })
})
