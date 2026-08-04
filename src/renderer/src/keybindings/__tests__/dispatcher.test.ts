// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useKeybindings, setUserRules, setContext } from '../useKeybindings'
import { registerCommand, _resetRegistry } from '../commandRegistry'

// Central keydown dispatcher tests: the window capture-phase listener installed
// by useKeybindings() (resolve rule → executeCommand → consume or fall through).
// Covers the 2026-07-16 shortcut-audit regressions:
// - shifted bindings must resolve although e.key reports the UPPERCASE letter
//   (the bug class that killed cmd+shift+s/n/t in a scattered handler)
// - consumed events must not leak to later listeners; unhandled events MUST
//   fall through untouched (fallthrough protection contract)
// - cmd+l is owned centrally when editorOpen, and released otherwise
// - 'mod' resolves per platform (meta on macOS, ctrl elsewhere)

const Host = defineComponent({
  setup() {
    useKeybindings()
    return () => h('div')
  },
})

let wrapper: VueWrapper
let probeEvents: KeyboardEvent[]
const probe = (e: KeyboardEvent): void => { probeEvents.push(e) }

function dispatch(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(e)
  return e
}

beforeEach(() => {
  _resetRegistry()
  setContext('editorOpen', false)
  setContext('editorTextFocus', false)
  setContext('terminalFocus', false)
  setContext('modalOpen', false)
  setContext('findOpen', false)
  wrapper = mount(Host)
  // Registered after mount, so the dispatcher's capture listener runs first
  // and stopImmediatePropagation can suppress this probe.
  probeEvents = []
  window.addEventListener('keydown', probe)
})

afterEach(() => {
  window.removeEventListener('keydown', probe)
  wrapper.unmount()
  setUserRules([])
  vi.unstubAllGlobals()
})

describe('dispatch and consumption', () => {
  it('executes a registered command and consumes the event', () => {
    const spy = vi.fn()
    registerCommand('workbench.action.showCommands', spy)
    const e = dispatch({ key: 'p', metaKey: true, shiftKey: true })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    expect(probeEvents).toHaveLength(0) // stopImmediatePropagation fired
  })

  it('falls through untouched when the matching rule has no registered handler', () => {
    const e = dispatch({ key: 't', metaKey: true, shiftKey: true }) // reopenClosedEditor: unregistered
    expect(e.defaultPrevented).toBe(false)
    expect(probeEvents).toHaveLength(1) // scattered handlers still see it
  })

  it('falls through untouched when no rule matches at all', () => {
    const e = dispatch({ key: 'q', metaKey: true, altKey: true })
    expect(e.defaultPrevented).toBe(false)
    expect(probeEvents).toHaveLength(1)
  })
})

describe('shifted bindings with uppercase e.key (audit issue 1 regression)', () => {
  it('cmd+shift+s resolves saveAll although e.key is "S"', () => {
    setContext('editorOpen', true)
    const spy = vi.fn()
    registerCommand('workbench.action.saveAll', spy)
    const e = dispatch({ key: 'S', metaKey: true, shiftKey: true })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
  })

  it('cmd+shift+n resolves newWindow although e.key is "N"', () => {
    const spy = vi.fn()
    registerCommand('workbench.action.newWindow', spy)
    dispatch({ key: 'N', metaKey: true, shiftKey: true })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('cmd+shift+t resolves reopenClosedEditor although e.key is "T"', () => {
    const spy = vi.fn()
    registerCommand('workbench.action.reopenClosedEditor', spy)
    dispatch({ key: 'T', metaKey: true, shiftKey: true })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('when-clause gating', () => {
  it('cmd+shift+s does NOT fire saveAll without editorOpen, and the event falls through', () => {
    const spy = vi.fn()
    registerCommand('workbench.action.saveAll', spy)
    const e = dispatch({ key: 'S', metaKey: true, shiftKey: true })
    expect(spy).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    expect(probeEvents).toHaveLength(1)
  })

  it('cmd+s is suppressed while terminalFocus is set (audit issue 6 guard)', () => {
    setContext('editorOpen', true)
    const spy = vi.fn()
    registerCommand('editor.action.save', spy)
    setContext('terminalFocus', true)
    const e1 = dispatch({ key: 's', metaKey: true })
    expect(spy).not.toHaveBeenCalled()
    expect(e1.defaultPrevented).toBe(false)
    setContext('terminalFocus', false)
    dispatch({ key: 's', metaKey: true })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('escape is consumed as closeModal only while modalOpen', () => {
    const spy = vi.fn()
    registerCommand('workbench.action.closeModal', spy)
    const e1 = dispatch({ key: 'Escape' })
    expect(spy).not.toHaveBeenCalled()
    expect(e1.defaultPrevented).toBe(false)
    setContext('modalOpen', true)
    const e2 = dispatch({ key: 'Escape' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(e2.defaultPrevented).toBe(true)
  })

  it('escape reaches an embedded terminal instead of closing the modal', () => {
    // The Pipeline Manager modal embeds a CLI dock: while its terminal holds
    // focus, Esc is the CLI's interrupt key and must not be swallowed.
    const spy = vi.fn()
    registerCommand('workbench.action.closeModal', spy)
    setContext('modalOpen', true)
    setContext('terminalFocus', true)
    const e1 = dispatch({ key: 'Escape' })
    expect(spy).not.toHaveBeenCalled()
    expect(e1.defaultPrevented).toBe(false)
    setContext('terminalFocus', false)
    dispatch({ key: 'Escape' })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('cmd+l ownership (audit issue 3 regression)', () => {
  it('dispatches gotoLine when editorOpen', () => {
    setContext('editorOpen', true)
    const spy = vi.fn()
    registerCommand('editor.action.gotoLine', spy)
    const e = dispatch({ key: 'l', metaKey: true })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
  })

  it('releases cmd+l to downstream handlers when no editor is open', () => {
    const spy = vi.fn()
    registerCommand('editor.action.gotoLine', spy)
    const e = dispatch({ key: 'l', metaKey: true })
    expect(spy).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    expect(probeEvents).toHaveLength(1)
  })
})

describe('chord handling', () => {
  it('consumes the chord prefix so it never leaks, then executes on the second key', () => {
    const spy = vi.fn()
    registerCommand('workbench.action.openKeyboardShortcuts', spy)
    const first = dispatch({ key: 'k', metaKey: true })
    expect(first.defaultPrevented).toBe(true)
    expect(probeEvents).toHaveLength(0) // prefix must not reach bubble handlers
    expect(spy).not.toHaveBeenCalled()
    const second = dispatch({ key: 's', metaKey: true }) // cmd+k cmd+s
    expect(spy).toHaveBeenCalledTimes(1)
    expect(second.defaultPrevented).toBe(true)
  })
})

describe('ctrl+digit CLI quick-select resolves via physical key (IME leak fix)', () => {
  it('consumes ctrl+2 even when an IME reports e.key as "Process"', () => {
    const spy = vi.fn()
    registerCommand('controlPane.selectCliType2', spy)
    const e = dispatch({ key: 'Process', code: 'Digit2', ctrlKey: true })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    expect(probeEvents).toHaveLength(0) // never leaks to the focused terminal
  })

  it('still resolves ctrl+3 on the normal path where e.key is the digit', () => {
    const spy = vi.fn()
    registerCommand('controlPane.selectCliType3', spy)
    const e = dispatch({ key: '3', code: 'Digit3', ctrlKey: true })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
  })

  it('resolves the numpad digit too when e.key is unidentified', () => {
    const spy = vi.fn()
    registerCommand('controlPane.selectCliType4', spy)
    dispatch({ key: 'Unidentified', code: 'Numpad4', ctrlKey: true })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('IME composition guard', () => {
  it('ignores mid-composition keydowns entirely (no resolve, no chord, falls through)', () => {
    const spy = vi.fn()
    registerCommand('workbench.action.showCommands', spy)
    const e = dispatch({ key: 'p', metaKey: true, shiftKey: true, isComposing: true })
    expect(spy).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    expect(probeEvents).toHaveLength(1)
  })

  it('a composing chord prefix does not start a pending chord', () => {
    const spy = vi.fn()
    registerCommand('workbench.action.openKeyboardShortcuts', spy)
    const first = dispatch({ key: 'k', metaKey: true, isComposing: true })
    expect(first.defaultPrevented).toBe(false)
    // The next key must resolve standalone, not as a chord second key.
    const second = dispatch({ key: 's', metaKey: true })
    expect(spy).not.toHaveBeenCalled()
    expect(second.defaultPrevented).toBe(false)
  })

  it('still resolves ctrl+digit "Process" events when not composing (leak-fix intact)', () => {
    const spy = vi.fn()
    registerCommand('controlPane.selectCliType2', spy)
    const e = dispatch({ key: 'Process', code: 'Digit2', ctrlKey: true, isComposing: false })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
  })
})

describe('mod key cross-platform (audit issue 7)', () => {
  it('a "mod" rule matches ctrl on non-mac and meta on mac', () => {
    const spy = vi.fn()
    registerCommand('test.modBinding', spy)

    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: '' })
    setUserRules([{ key: 'mod+9', command: 'test.modBinding' }]) // parsed under Win32
    dispatch({ key: '9', metaKey: true })
    expect(spy).not.toHaveBeenCalled()
    dispatch({ key: '9', ctrlKey: true })
    expect(spy).toHaveBeenCalledTimes(1)

    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' })
    setUserRules([{ key: 'mod+9', command: 'test.modBinding' }]) // re-parsed under macOS
    dispatch({ key: '9', ctrlKey: true })
    expect(spy).toHaveBeenCalledTimes(1) // ctrl no longer matches
    dispatch({ key: '9', metaKey: true })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
