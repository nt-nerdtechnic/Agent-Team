// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import Welcome from '../Welcome.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { RecentWorkspace } from '../../composables/useRecentWorkspaces'

const RECENT: RecentWorkspace[] = [
  {
    path: '/Users/test/proj-a',
    name: 'proj-a',
    last_opened_at: new Date().toISOString(),
    pinned: false,
    last_known_state: '',
    last_known_task: '',
    exists: true,
  },
]

const t = (key: string): string => i18n.global.t(key)

function itemByLabel(wrapper: VueWrapper, key: string) {
  return wrapper.findAll('.ctx-menu .menu-item').find((el) => el.text().trim() === t(key))
}

describe('Welcome – recent workspace context menu', () => {
  let wrapper: VueWrapper | undefined
  let openFolderInEditor: ReturnType<typeof vi.fn>
  let listEditors: ReturnType<typeof vi.fn>
  let revealPath: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openFolderInEditor = vi.fn().mockResolvedValue({ ok: true })
    revealPath = vi.fn().mockResolvedValue({ ok: true })
    listEditors = vi.fn().mockResolvedValue([
      { id: 'vscode', command: 'code', available: false },
      { id: 'cursor', command: 'cursor', available: true },
    ])
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      openFolderInEditor,
      listEditors,
      revealPath,
      listOpenWorkspaces: vi.fn().mockResolvedValue([]),
      focusWorkspaceWindow: vi.fn().mockResolvedValue(false),
      onOpenWorkspacesChanged: () => () => {},
    }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  async function mountWelcome() {
    const mock = createMockBackend('connected')
    mock.setResponse('workspace.list_recent', { recent: RECENT, path: '/tmp/recent.json' })
    wrapper = mount(Welcome, {
      props: { backend: mock.backend as never },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return mock
  }

  async function openMenu(): Promise<void> {
    await wrapper!.find('.recent-item').trigger('contextmenu', { clientX: 20, clientY: 30 })
    await flushPromises()
  }

  it('opens a context menu on right-click without opening the workspace', async () => {
    await mountWelcome()
    await openMenu()
    expect(wrapper!.find('.ctx-menu').exists()).toBe(true)
    expect(wrapper!.emitted('select')).toBeUndefined()
  })

  it('opens the workspace folder with the default editor', async () => {
    await mountWelcome()
    await openMenu()
    await itemByLabel(wrapper!, 'action.open-in-default-editor')!.trigger('click')
    expect(openFolderInEditor).toHaveBeenCalledWith('/Users/test/proj-a', undefined)
    expect(wrapper!.find('.ctx-menu').exists()).toBe(false)
  })

  it('lists the host editors plus only the available detected ones', async () => {
    await mountWelcome()
    await openMenu()
    const labels = wrapper!.findAll('.ctx-submenu .menu-item').map((el) => el.text().trim())
    expect(labels).toEqual([
      t('label.editor-mini-ide'),
      t('label.editor-system'),
      t('label.editor-cursor'),
    ])
  })

  it('routes a submenu pick to the chosen editor', async () => {
    await mountWelcome()
    await openMenu()
    const targets = wrapper!.findAll('.ctx-submenu .menu-item')
    await targets[targets.length - 1].trigger('click')
    expect(openFolderInEditor).toHaveBeenCalledWith('/Users/test/proj-a', 'cursor')
  })

  it('reveals the folder in Finder', async () => {
    await mountWelcome()
    await openMenu()
    await itemByLabel(wrapper!, 'action.reveal-in-finder')!.trigger('click')
    expect(revealPath).toHaveBeenCalledWith('/Users/test/proj-a')
  })

  it('copies the workspace path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await mountWelcome()
    await openMenu()
    await itemByLabel(wrapper!, 'action.copy-path')!.trigger('click')
    expect(writeText).toHaveBeenCalledWith('/Users/test/proj-a')
  })

  it('closes on Escape and on a backdrop click', async () => {
    await mountWelcome()
    await openMenu()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper!.find('.ctx-menu').exists()).toBe(false)

    await openMenu()
    await wrapper!.find('.ctx-backdrop').trigger('click')
    expect(wrapper!.find('.ctx-menu').exists()).toBe(false)
  })

  it('re-probes on reopen so a newly installed editor shows up', async () => {
    // Main caches detection, so the round trip is cheap; latching it here
    // instead would hide an editor installed since the menu first opened.
    await mountWelcome()
    await openMenu()
    await wrapper!.find('.ctx-backdrop').trigger('click')
    await openMenu()
    expect(listEditors).toHaveBeenCalledTimes(2)
  })
})
