// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import Welcome from '../Welcome.vue'
import { i18n } from '../../i18n'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { RecentWorkspace } from '../../composables/useRecentWorkspaces'

// The same picker serves two places: the startup screen, where there is
// nothing behind it to dismiss to, and the sidebar's Workspace ＋, where it
// sits over a window that is already working. Only the second can be closed.

const RECENT: RecentWorkspace[] = [
  {
    path: '/Users/test/proj-a',
    name: 'proj-a',
    last_opened_at: new Date().toISOString(),
    pinned: false,
    last_known_state: '',
    last_known_task: '',
    exists: true
  }
]

describe('Welcome – dismissible mode', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      listOpenWorkspaces: vi.fn().mockResolvedValue([]),
      focusWorkspaceWindow: vi.fn().mockResolvedValue(false),
      onOpenWorkspacesChanged: () => () => {}
    }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  async function mountWelcome(props: Record<string, unknown> = {}): Promise<void> {
    const mock = createMockBackend('connected')
    mock.setResponse('workspace.list_recent', { recent: RECENT, path: '/tmp/recent.json' })
    mock.setResponse('workspace.touch', { recent: RECENT })
    wrapper = mount(Welcome, {
      props: { backend: mock.backend, ...props },
      global: { plugins: [i18n] }
    })
    await flushPromises()
  }

  it('has no way out at startup', async () => {
    await mountWelcome()
    expect(wrapper!.find('.w-close').exists()).toBe(false)
    // A backdrop click and Escape are both inert — nothing to go back to.
    await wrapper!.find('.welcome-overlay').trigger('click')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper!.emitted('close')).toBeUndefined()
  })

  it('closes three ways when opened from the sidebar', async () => {
    await mountWelcome({ dismissible: true })
    await wrapper!.find('.w-close').trigger('click')
    expect(wrapper!.emitted('close')).toHaveLength(1)

    await wrapper!.find('.welcome-overlay').trigger('click')
    expect(wrapper!.emitted('close')).toHaveLength(2)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper!.emitted('close')).toHaveLength(3)
  })

  it('a click on the card itself does not close it', async () => {
    await mountWelcome({ dismissible: true })
    await wrapper!.find('.welcome-card').trigger('click')
    expect(wrapper!.emitted('close')).toBeUndefined()
  })

  it('keeps every picker control in both modes', async () => {
    // Browse / New / Home and the recent list are the whole point of reusing
    // this component rather than building a second picker.
    for (const props of [{}, { dismissible: true }]) {
      await mountWelcome(props)
      expect(wrapper!.findAll('.w-open-btns button')).toHaveLength(3)
      expect(wrapper!.findAll('.recent-item')).toHaveLength(1)
      expect(wrapper!.find('.pin').exists()).toBe(true)
      wrapper!.unmount()
    }
  })

  it('still reports the pick through select', async () => {
    await mountWelcome({ dismissible: true })
    await wrapper!.find('.recent-item').trigger('click')
    await flushPromises()
    expect(wrapper!.emitted('select')?.[0]).toEqual(['/Users/test/proj-a'])
  })

  it('drops its Escape listener when it goes away', async () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    await mountWelcome({ dismissible: true })
    wrapper!.unmount()
    wrapper = undefined
    expect(remove.mock.calls.some(([type]) => type === 'keydown')).toBe(true)
    remove.mockRestore()
  })
})
