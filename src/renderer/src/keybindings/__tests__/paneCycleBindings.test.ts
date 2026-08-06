// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { KeyResolver } from '../keyResolver'
import { defaults } from '../defaults'
import { useKeybindings, setUserRules, setContext } from '../useKeybindings'
import { registerCommand, _resetRegistry } from '../commandRegistry'

// Ctrl+Tab / Ctrl+Shift+Tab cycle CLI panes. Three things must hold and each is
// easy to break from a distance:
// - the rules sit AFTER the editor-tab rules for the same chord, so priority
//   and the 'paneStage' guard decide which command wins per window;
// - windows without a pane stage must fall through to the editor rules. An
//   unhandled binding is NOT consumed, so a rule that wins in a window that
//   never registered the command leaks the Tab into that window's terminal;
// - bare Tab and Shift+Tab must stay untouched — the dispatcher's capture-phase
//   listener would otherwise swallow shell completion and Claude Code's
//   permission-mode toggle before xterm forwards them to the PTY.

function tabEvent(shift: boolean): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, shiftKey: shift, bubbles: true })
}

describe('Ctrl+Tab pane cycling rules', () => {
  let resolver: KeyResolver

  beforeEach(() => {
    resolver = new KeyResolver(defaults)
  })

  it('cycles panes in the window that owns the pane stage', () => {
    const ctx = { paneStage: true }
    expect(resolver.resolve(tabEvent(false), ctx)?.command).toBe('workbench.action.focusNextPane')
    expect(resolver.resolve(tabEvent(true), ctx)?.command).toBe('workbench.action.focusPreviousPane')
  })

  it('falls back to editor tab switching in a plugin window', () => {
    expect(resolver.resolve(tabEvent(false), {})?.command).toBe('workbench.action.openNextEditor')
    expect(resolver.resolve(tabEvent(true), {})?.command).toBe('workbench.action.openPreviousEditor')
  })

  it('still falls back when the Mini IDE has closed its last tab', () => {
    // Regression guard: editorOpen is !!activeKey, so it goes false with no
    // tabs open. Gating on '!editorOpen' would hand the chord to a command the
    // Mini IDE never registers, and the unconsumed Tab would reach its AI dock.
    const ctx = { editorOpen: false }
    expect(resolver.resolve(tabEvent(false), ctx)?.command).toBe('workbench.action.openNextEditor')
  })

  it('still cycles panes while a terminal has focus', () => {
    // CLI panes hold terminalFocus almost all the time; guarding on it would
    // make the shortcut unreachable.
    const ctx = { paneStage: true, terminalFocus: true }
    expect(resolver.resolve(tabEvent(false), ctx)?.command).toBe('workbench.action.focusNextPane')
  })

  it('does not cycle behind an open modal', () => {
    const ctx = { paneStage: true, modalOpen: true }
    expect(resolver.resolve(tabEvent(false), ctx)?.command).not.toBe('workbench.action.focusNextPane')
  })

  it('leaves bare Tab and Shift+Tab unbound', () => {
    const bare = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })
    const shiftOnly = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
    expect(resolver.resolve(bare, { paneStage: true })).toBeNull()
    expect(resolver.resolve(shiftOnly, { paneStage: true })).toBeNull()
  })
})

// ── End to end through the real dispatcher ───────────────────────────────────

const Host = defineComponent({
  setup() {
    useKeybindings()
    return () => h('div')
  },
})

describe('Ctrl+Tab pane cycling dispatch', () => {
  let wrapper: VueWrapper
  let probeEvents: KeyboardEvent[]
  let next: ReturnType<typeof vi.fn>
  let prev: ReturnType<typeof vi.fn>
  const probe = (e: KeyboardEvent): void => { probeEvents.push(e) }

  function dispatch(init: KeyboardEventInit): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    window.dispatchEvent(e)
    return e
  }

  beforeEach(() => {
    _resetRegistry()
    setContext('paneStage', true)
    setContext('editorOpen', false)
    setContext('modalOpen', false)
    setContext('terminalFocus', true)
    wrapper = mount(Host)
    next = vi.fn()
    prev = vi.fn()
    registerCommand('workbench.action.focusNextPane', next)
    registerCommand('workbench.action.focusPreviousPane', prev)
    // Registered after mount so the dispatcher's capture listener runs first.
    probeEvents = []
    window.addEventListener('keydown', probe)
  })

  afterEach(() => {
    window.removeEventListener('keydown', probe)
    wrapper.unmount()
    setUserRules([])
    setContext('paneStage', false)
    setContext('terminalFocus', false)
  })

  it('runs the forward command and consumes the event', () => {
    const e = dispatch({ key: 'Tab', ctrlKey: true })
    expect(next).toHaveBeenCalledTimes(1)
    expect(prev).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
    expect(probeEvents).toHaveLength(0)
  })

  it('runs the backward command on Ctrl+Shift+Tab', () => {
    const e = dispatch({ key: 'Tab', ctrlKey: true, shiftKey: true })
    expect(prev).toHaveBeenCalledTimes(1)
    expect(next).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
  })

  it('lets bare Tab through untouched so the PTY gets shell completion', () => {
    const e = dispatch({ key: 'Tab' })
    expect(next).not.toHaveBeenCalled()
    expect(prev).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    expect(probeEvents).toHaveLength(1)
  })

  it("lets Shift+Tab through so Claude Code's permission toggle still works", () => {
    const e = dispatch({ key: 'Tab', shiftKey: true })
    expect(next).not.toHaveBeenCalled()
    expect(prev).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    expect(probeEvents).toHaveLength(1)
  })

  it('does not cycle while a modal is open, and leaves the event alone', () => {
    setContext('modalOpen', true)
    const e = dispatch({ key: 'Tab', ctrlKey: true })
    expect(next).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    setContext('modalOpen', false)
  })

  it('does not cycle panes in a window without a pane stage', () => {
    setContext('paneStage', false)
    const e = dispatch({ key: 'Tab', ctrlKey: true })
    expect(next).not.toHaveBeenCalled()
    // Resolves to openNextEditor, which is unregistered here, so the event
    // falls through untouched — the plugin window's own handler decides.
    expect(e.defaultPrevented).toBe(false)
  })
})
