// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ExplorerPane from '../ExplorerPane.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { revealPath } from '../../composables/hostShell'

vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }),
}))

// The regression this guards: the pane used to call `window.agentTeam?.revealPath`
// directly, which is `undefined` inside the mini-IDE plugin view — optional
// chaining then made the menu item a silent no-op. Going through hostShell lets
// the plugin build swap in the capability-broker implementation.
vi.mock('../../composables/hostShell', () => ({ revealPath: vi.fn(async () => {}) }))

const FILE_ENTRY = {
  name: 'readme.md',
  rel_path: 'readme.md',
  is_dir: false,
  is_hidden: false,
  is_noise: false,
}

const t = (key: string): string => i18n.global.t(key)

describe('ExplorerPane – reveal in the OS file manager', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    vi.mocked(revealPath).mockClear()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  async function mountPane(): Promise<void> {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY] })
    wrapper = mount(ExplorerPane, {
      props: { workspacePath: '/ws', backend: mock.backend as never },
      global: { plugins: [i18n] },
    })
    await flushPromises()
  }

  it('reveals the right-clicked entry at its absolute path', async () => {
    await mountPane()
    await wrapper!.findAll('.exp-row')[0].trigger('contextmenu', { clientX: 10, clientY: 10 })
    await flushPromises()

    const item = wrapper!
      .findAll('.exp-ctx-item')
      .find((el) => el.text().trim() === t('action.reveal-in-finder'))
    expect(item).toBeDefined()

    await item!.trigger('click')
    await flushPromises()
    expect(revealPath).toHaveBeenCalledWith('/ws/readme.md')
  })

  it('does not reach for window.agentTeam', async () => {
    // A plugin view has no `agentTeam` bridge at all; the call must still land.
    expect((window as unknown as { agentTeam?: unknown }).agentTeam).toBeUndefined()
    await mountPane()
    await wrapper!.findAll('.exp-row')[0].trigger('contextmenu', { clientX: 10, clientY: 10 })
    await flushPromises()
    await wrapper!
      .findAll('.exp-ctx-item')
      .find((el) => el.text().trim() === t('action.reveal-in-finder'))!
      .trigger('click')
    await flushPromises()
    expect(revealPath).toHaveBeenCalledOnce()
  })
})
