// @vitest-environment happy-dom
/**
 * ESC belongs to the embedded AI CLI while that panel has focus.
 *
 * The shipped rule is `escape → workbench.action.closeModal` when
 * `planWindow && !terminalFocus`, and the dispatcher consumes (preventDefault +
 * stopImmediatePropagation) every key it executes. So a Plan window that never
 * publishes `terminalFocus` closes itself on the keystroke the user pressed to
 * cancel a prompt, and the PTY never receives the ESC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { SafeAiCliPanel, type AiCliSessionController } from '@navide/plugin-ui'
import { i18n } from '@navide/plugin-ui/foundation'
import { setContext } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest, _resetKeybindingsState, _resetRegistry } from '@navide/plugin-ui/shared/testing'
import { installPlansKeybindings } from '../src/plansKeybindings'

const { FakeTerminal } = vi.hoisted(() => {
  class FakeTerminal {
    cols = 80
    rows = 24
    /** xterm's real helper textarea: what focus and keystrokes actually reach. */
    textarea: HTMLTextAreaElement | null = null
    constructor(_options: unknown) {}
    loadAddon(addon: { activate?: (terminal: FakeTerminal) => void }) { addon.activate?.(this) }
    open(host: HTMLElement) {
      this.textarea = host.ownerDocument.createElement('textarea')
      host.appendChild(this.textarea)
    }
    write() {}
    focus() { this.textarea?.focus() }
    onData() { return { dispose: vi.fn() } }
    dispose() {}
  }
  return { FakeTerminal }
})

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate() {}
    fit() {}
    dispose() {}
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

function makeController(): AiCliSessionController {
  return {
    get sessionId() { return null },
    get profileId() { return null },
    listProfiles: vi.fn(async () => [{ id: 'claude', label: 'Claude Code' }]),
    resume: vi.fn(async () => null),
    start: vi.fn(async () => 'session-1'),
    send: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    dispose: vi.fn(),
    onOutput() { return () => undefined },
    onExit() { return () => undefined },
  }
}

/** The Plan window surface: the shared dispatcher plus the embedded CLI panel. */
function mountPlanWindow(closeModal: () => boolean | undefined) {
  const Window = defineComponent({
    setup() {
      installPlansKeybindings({ quickOpen: () => undefined, closeModal })
      return () => h(SafeAiCliPanel, { controller: makeController() })
    },
  })
  return mount(Window, { attachTo: document.body, global: { plugins: [i18n] } })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  __resetSettingsForTest()
  _resetRegistry()
  _resetKeybindingsState()
})

afterEach(() => {
  setContext('planWindow', false)
  setContext('terminalFocus', false)
})

describe('Plan window ESC and the embedded AI CLI', () => {
  it('leaves ESC to the CLI panel while it has focus', async () => {
    const closeModal = vi.fn(() => undefined)
    const wrapper = mountPlanWindow(closeModal)
    await flushPromises()

    const textarea = wrapper.find('.navide-safe-ai-cli__terminal textarea').element
    textarea.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    const reachedPanel: string[] = []
    textarea.addEventListener('keydown', (event) => reachedPanel.push((event as KeyboardEvent).key))
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    textarea.dispatchEvent(escape)

    expect(closeModal).not.toHaveBeenCalled()
    // Both halves of "the PTY receives it": the dispatcher neither cancelled the
    // default nor cut the propagation short of the panel.
    expect(escape.defaultPrevented).toBe(false)
    expect(reachedPanel).toEqual(['Escape'])

    wrapper.unmount()
  })

  it('still closes the window on ESC once focus leaves the panel', async () => {
    const closeModal = vi.fn(() => undefined)
    const wrapper = mountPlanWindow(closeModal)
    await flushPromises()

    const textarea = wrapper.find('.navide-safe-ai-cli__terminal textarea').element
    textarea.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }))

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(escape)

    expect(closeModal).toHaveBeenCalledOnce()
    expect(escape.defaultPrevented).toBe(true)

    wrapper.unmount()
  })
})
