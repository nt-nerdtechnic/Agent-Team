// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import TerminalPane from '../TerminalPane.vue'

// Coverage for the terminal's right-click menu (issue #12: right-click was
// inert app-wide). Main cannot read an xterm selection from the context-menu
// params — `.xterm` is `user-select: none`, so there is no DOM selection — so
// the pane sends `term.getSelection()` along with the request.
// useTerminal is mocked out: no xterm instance, no backend traffic.

const mockTerminal = vi.hoisted(() => ({ selection: '' }))

vi.mock('../../composables/useTerminal', async () => {
  const { ref } = await import('vue')
  return {
    useTerminal: () => ({
      mount: vi.fn(),
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      getSelection: () => mockTerminal.selection,
      displayStatus: ref('idle'),
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

const showTerminalContextMenu = vi.fn()

function mountPane(): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: { paneId: 'pane-1', title: 'Claude', backend: {}, cliProfiles: {} },
    global: { mocks: { $t: (key: string) => key } }
  })
}

/** Right-click natively so `defaultPrevented` is observable. */
function rightClick(el: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  el.dispatchEvent(event)
  return event
}

describe('TerminalPane – right-click context menu', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { showTerminalContextMenu }
  })

  afterEach(() => {
    wrapper.unmount()
    vi.clearAllMocks()
    mockTerminal.selection = ''
  })

  it('asks main for a menu, passing the terminal selection', () => {
    mockTerminal.selection = 'npm run build'
    wrapper = mountPane()

    rightClick(wrapper.find('.xterm-host').element)

    expect(showTerminalContextMenu).toHaveBeenCalledWith('npm run build')
  })

  it('still opens a menu with no selection (Paste stays reachable)', () => {
    wrapper = mountPane()

    rightClick(wrapper.find('.xterm-host').element)

    expect(showTerminalContextMenu).toHaveBeenCalledWith('')
  })

  it('suppresses the default menu so main does not open a second one', () => {
    wrapper = mountPane()

    const event = rightClick(wrapper.find('.xterm-host').element)

    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves the header right-click on its own pane menu', () => {
    wrapper = mountPane()

    rightClick(wrapper.find('header').element)

    expect(wrapper.emitted('context-menu')).toHaveLength(1)
    expect(showTerminalContextMenu).not.toHaveBeenCalled()
  })
})
