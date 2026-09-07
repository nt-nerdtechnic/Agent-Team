// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// Coverage for the quota-limit badge: hidden by default, rendered while the
// pane's CLI has announced it is out of quota, and naming the reset time only
// when one was actually resolved. Unlike the login badge it is NOT a button —
// nothing the user can click here grants quota. Same useTerminal mock as
// TerminalPane.loginBadge.test.ts (no xterm instance, no backend traffic).

const mockTerminal = vi.hoisted(() => ({ displayStatus: null as unknown as Ref<string> }))

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  mockTerminal.displayStatus = ref('idle')
  return {
    ...actual,
    useTerminal: () => ({
      mount: vi.fn(),
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      displayStatus: mockTerminal.displayStatus,
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

function tMock(key: string): string {
  return key
}

function mountPane(props: Record<string, unknown>): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: {
      paneId: 'pane-1',
      title: 'Claude',
      terminalPort: createTerminalDockStub(),
      cliProfiles: {},
      ...props
    },
    global: { mocks: { $t: tMock } }
  })
}

describe('TerminalPane – quota-limit badge', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
    mockTerminal.displayStatus.value = 'idle'
  })

  it('does not render the badge by default', () => {
    wrapper = mountPane({})
    expect(wrapper.find('.usage-limit-inline').exists()).toBe(false)
  })

  it('renders while the limit stands and clears when the flag drops', async () => {
    wrapper = mountPane({ usageLimitHit: true, usageLimitUntil: Date.now() + 3600_000 })
    expect(wrapper.find('.usage-limit-inline').exists()).toBe(true)
    await wrapper.setProps({ usageLimitHit: false })
    expect(wrapper.find('.usage-limit-inline').exists()).toBe(false)
  })

  it('names the reset time only when one was resolved', async () => {
    wrapper = mountPane({ usageLimitHit: true, usageLimitUntil: Date.now() + 3600_000 })
    expect(wrapper.find('.usage-limit-inline').text()).toBe('pane.terminal.usage-limit-badge')
    // No resume time: say so rather than interpolate a blank into the timed
    // wording, which would read as "back at ".
    await wrapper.setProps({ usageLimitUntil: null })
    expect(wrapper.find('.usage-limit-inline').text()).toBe(
      'pane.terminal.usage-limit-badge-unknown'
    )
    expect(wrapper.find('.usage-limit-inline').attributes('title')).toBe(
      'pane.terminal.usage-limit-tooltip-unknown'
    )
  })

  it('is not a button — waiting out a quota window is not an action', () => {
    wrapper = mountPane({ usageLimitHit: true, usageLimitUntil: Date.now() + 3600_000 })
    expect(wrapper.find('.usage-limit-inline').attributes('role')).toBeUndefined()
  })
})
