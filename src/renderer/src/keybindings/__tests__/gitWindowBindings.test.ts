// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { KeyResolver } from '../keyResolver'
import { defaults } from '../defaults'
import { useKeybindings, setUserRules, setContext } from '../useKeybindings'
import { registerCommand, _resetRegistry } from '../commandRegistry'

// The standalone Git window (GitWindowApp) is the only surface that sets the
// 'gitWindow' context. Its rules share chords with workbench commands that this
// window never registers, so two things must hold and both break silently:
// - inside the Git window the git.* rule wins (it is declared last, and the
//   resolver reverses the list);
// - everywhere else the original workbench command still wins.
// Plus: every git chord yields to the embedded AiCliDock PTY when it has focus.

function keyEvent(key: string, mods: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, ...mods })
}

const GIT_CHORDS: { key: string; init: KeyboardEventInit; command: string }[] = [
  { key: 'F5', init: {}, command: 'git.refresh' },
  { key: 'r', init: { metaKey: true, shiftKey: true }, command: 'git.refresh' },
  { key: 'Enter', init: { metaKey: true }, command: 'git.commit' },
  { key: 'Enter', init: { metaKey: true, shiftKey: true }, command: 'git.amend' },
  { key: 'm', init: { metaKey: true, shiftKey: true }, command: 'git.generateMessage' },
  { key: 'a', init: { metaKey: true, shiftKey: true }, command: 'git.stageAll' },
  { key: 'u', init: { metaKey: true, shiftKey: true }, command: 'git.unstageAll' },
  { key: 'f', init: { metaKey: true, shiftKey: true }, command: 'git.fetch' },
  { key: 'l', init: { metaKey: true, shiftKey: true }, command: 'git.pull' },
  { key: 'p', init: { metaKey: true, shiftKey: true }, command: 'git.push' },
  { key: 's', init: { metaKey: true, shiftKey: true }, command: 'git.sync' },
  { key: 'l', init: { metaKey: true }, command: 'git.focusAgent' },
]

describe('Git window keybinding rules', () => {
  let resolver: KeyResolver

  beforeEach(() => {
    resolver = new KeyResolver(defaults)
  })

  it.each(GIT_CHORDS)('resolves $command inside the Git window', ({ key, init, command }) => {
    expect(resolver.resolve(keyEvent(key, init), { gitWindow: true })?.command).toBe(command)
  })

  it.each(GIT_CHORDS)('does not resolve $command in other windows', ({ key, init, command }) => {
    expect(resolver.resolve(keyEvent(key, init), {})?.command).not.toBe(command)
  })

  it('leaves the shared chords with their workbench commands elsewhere', () => {
    expect(resolver.resolve(keyEvent('p', { metaKey: true, shiftKey: true }), {})?.command)
      .toBe('workbench.action.showCommands')
    expect(resolver.resolve(keyEvent('a', { metaKey: true, shiftKey: true }), {})?.command)
      .toBe('workbench.action.toggleAIChat')
    // ⇧⌘R is reloadWindow outside this window now — rebuilding one pane moved
    // to ⌘R when the menu gave up the `reload` role.
    expect(resolver.resolve(keyEvent('r', { metaKey: true, shiftKey: true }), {})?.command)
      .toBe('workbench.action.reloadWindow')
    expect(resolver.resolve(keyEvent('r', { metaKey: true }), {})?.command)
      .toBe('workbench.action.rebuildFocusedPane')
  })

  it.each(GIT_CHORDS)('yields $command to the AI dock PTY on terminal focus', ({ key, init, command }) => {
    const ctx = { gitWindow: true, terminalFocus: true }
    expect(resolver.resolve(keyEvent(key, init), ctx)?.command).not.toBe(command)
  })
})

describe('Opening the Git window (cmd+shift+g)', () => {
  const resolver = new KeyResolver(defaults)
  const chord = (): KeyboardEvent => keyEvent('g', { metaKey: true, shiftKey: true })

  it('opens the Git window from the main window', () => {
    expect(resolver.resolve(chord(), { paneStage: true })?.command)
      .toBe('workbench.action.openGitWindow')
  })

  it('still focuses the Source Control sidebar inside the Mini IDE', () => {
    expect(resolver.resolve(chord(), { editorOpen: true })?.command)
      .toBe('workbench.action.focusSourceControl')
  })

  it('stays with find navigation while find is open', () => {
    expect(resolver.resolve(chord(), { paneStage: true, findOpen: true })?.command)
      .not.toBe('workbench.action.openGitWindow')
  })
})

// ── End to end through the real dispatcher ───────────────────────────────────

const Host = defineComponent({
  setup() {
    useKeybindings()
    return () => h('div')
  },
})

describe('Git window keybinding dispatch', () => {
  let wrapper: VueWrapper
  let push: ReturnType<typeof vi.fn>
  let probeEvents: KeyboardEvent[]
  const probe = (e: KeyboardEvent): void => { probeEvents.push(e) }

  function dispatch(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    window.dispatchEvent(e)
    return e
  }

  beforeEach(() => {
    _resetRegistry()
    setContext('gitWindow', true)
    setContext('terminalFocus', false)
    wrapper = mount(Host)
    push = vi.fn()
    registerCommand('git.push', push)
    probeEvents = []
    window.addEventListener('keydown', probe)
  })

  afterEach(() => {
    window.removeEventListener('keydown', probe)
    wrapper.unmount()
    setUserRules([])
    setContext('gitWindow', false)
    setContext('terminalFocus', false)
  })

  it('runs the command and consumes the event', () => {
    const e = dispatch('p', { metaKey: true, shiftKey: true })
    expect(push).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    expect(probeEvents).toHaveLength(0)
  })

  it('lets the chord reach the PTY while the AI dock has focus', () => {
    setContext('terminalFocus', true)
    const e = dispatch('p', { metaKey: true, shiftKey: true })
    expect(push).not.toHaveBeenCalled()
    // Falls back to showCommands, which this window never registers, so the
    // event stays untouched and xterm forwards it to the CLI.
    expect(e.defaultPrevented).toBe(false)
    expect(probeEvents).toHaveLength(1)
  })

  it('does not fire in a window that never flags itself as the Git window', () => {
    setContext('gitWindow', false)
    const e = dispatch('p', { metaKey: true, shiftKey: true })
    expect(push).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })
})
