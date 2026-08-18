// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import type { DisplayStatus } from '../../composables/useTerminal'

// The pane-header status pill — the badge the user actually reads. Every value
// displayStatus can report has to reach it with its own data-status hook,
// because that attribute is the ONLY thing the per-status CSS selects on: a
// status with no rule renders as the neutral default, which is how 'awaiting'
// and 'idle' once looked identical. useTerminal is mocked out (no xterm, no
// backend) the same way TerminalPane.loginBadge.test.ts does it.

const mockTerminal = vi.hoisted(() => ({
  displayStatus: null as unknown as Ref<string>,
  awaitingKind: null as unknown as Ref<string | null>,
}))

vi.mock('../../composables/useTerminal', async () => {
  const { ref } = await import('vue')
  mockTerminal.displayStatus = ref('idle')
  mockTerminal.awaitingKind = ref(null)
  return {
    useTerminal: () => ({
      mount: vi.fn(),
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      displayStatus: mockTerminal.displayStatus,
      awaitingKind: mockTerminal.awaitingKind,
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

function tMock(key: string): string {
  return key
}

function mountPane(status: DisplayStatus, kind: 'permission' | 'question' | null = null): VueWrapper {
  mockTerminal.displayStatus.value = status
  mockTerminal.awaitingKind.value = kind
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: { paneId: 'pane-1', title: 'Claude', backend: {} },
    global: { mocks: { $t: tMock } }
  })
}

// Listed by hand, then checked against the union below.
const ALL_DISPLAY_STATUSES = [
  'idle',
  'starting',
  'running',
  'exited',
  'error',
  'stopped',
  'awaiting',
] as const satisfies readonly DisplayStatus[]

// Compile-time exhaustiveness: a new displayStatus value that is not listed
// above makes `Missing` that literal instead of never, and `true` stops being
// assignable — the build fails naming exactly what was forgotten.
type MissingDisplayStatus = Exclude<DisplayStatus, (typeof ALL_DISPLAY_STATUSES)[number]>
const _allDisplayStatusesCovered: MissingDisplayStatus extends never
  ? true
  : MissingDisplayStatus = true

describe('TerminalPane — status pill', () => {
  // Optional: the exhaustiveness check below is a type assertion and mounts
  // nothing, so the teardown has to tolerate a test that never made a wrapper.
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    mockTerminal.displayStatus.value = 'idle'
  })

  it('covers every value displayStatus can report', () => {
    expect(_allDisplayStatusesCovered).toBe(true)
  })

  it.each(ALL_DISPLAY_STATUSES)('carries data-status="%s" for the CSS to select on', (status) => {
    wrapper = mountPane(status)
    expect(wrapper!.get('.status').attributes('data-status')).toBe(status)
  })

  it('prints a translated label for awaiting, not the raw status word', () => {
    // The one badge that addresses the READER rather than describing the agent,
    // so it is the one badge that gets translated. Every other status prints
    // its own name (asserted below via data-status + the stopped case).
    wrapper = mountPane('awaiting', 'question')
    expect(wrapper!.get('.status').text()).toBe('pane.terminal.awaiting-status-badge')
  })

  it('prints the same label whichever kind of wait it is', () => {
    // The merge, asserted: a permission prompt and a question are one badge.
    // What separates them is the tooltip below, not the word on the pill.
    wrapper = mountPane('awaiting', 'permission')
    const permission = wrapper!.get('.status').text()
    wrapper!.unmount()
    wrapper = mountPane('awaiting', 'question')
    expect(wrapper!.get('.status').text()).toBe(permission)
  })

  it('still abbreviates stopped to STOP', () => {
    // The one status whose text is not its own name; hoisting the badge text
    // must not have lost the special case.
    wrapper = mountPane('stopped')
    expect(wrapper!.get('.status').text()).toBe('STOP')
  })

  it('explains which kind of wait it is on hover', () => {
    // One badge, two reasons. The distinction is not worth a second pill but is
    // worth a sentence: sharing awaiting's copy would send the user looking for
    // a permission prompt that is not there.
    wrapper = mountPane('awaiting', 'question')
    const key = wrapper!.get('.status').attributes('title')
    expect(key).toBe('pane.terminal.question-status-tooltip')

    wrapper!.unmount()
    wrapper = mountPane('awaiting', 'permission')
    expect(wrapper!.get('.status').attributes('title')).toBe(
      'pane.terminal.awaiting-status-tooltip'
    )
  })

  it('leaves the self-evident statuses without a tooltip', () => {
    wrapper = mountPane('running')
    expect(wrapper!.get('.status').attributes('title') ?? '').toBe('')
  })
})
