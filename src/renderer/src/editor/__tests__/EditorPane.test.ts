// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref, nextTick } from 'vue'
import EditorPane from '../EditorPane.vue'
import { i18n } from '@navide/ui-foundation'

// Monaco cannot run in happy-dom — replace the editor view with a stub that
// just renders the bound content.
vi.mock('../view/EditorViewMonaco.vue', () => ({
  default: defineComponent({
    name: 'EditorViewMonaco',
    props: { modelValue: { type: String, default: '' } },
    setup(props) {
      return () => h('div', { class: 'mock-monaco' }, props.modelValue)
    },
  }),
}))

// Stub useNotify so toast calls don't throw.
vi.mock('@navide/ui-foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/ui-foundation')>()),
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }),
}))

type Status = 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'

function makeBackend(initial: Status = 'connected') {
  return {
    status: ref<Status>(initial),
    lastError: ref(''),
    send: vi.fn(async (type: string) => {
      if (type === 'fs.read_file') {
        return { payload: { ok: true, content: 'hello world', encoding: 'UTF-8' } }
      }
      return { payload: { ok: true } }
    }),
    on: vi.fn(() => () => {}),
    restart: vi.fn(async () => undefined),
  }
}

function mountPane(backend: ReturnType<typeof makeBackend>) {
  return mount(EditorPane, {
    props: {
      workspacePath: '/ws',
      relPath: 'a.txt',
      name: 'a.txt',
      backend: backend as never,
    },
    global: { plugins: [i18n] },
  })
}

describe('EditorPane – connection states', () => {
  it('shows "Waiting for backend…" instead of "Loading…" while not connected', async () => {
    const backend = makeBackend('connecting')
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(wrapper.text()).toContain('Waiting for backend')
    expect(wrapper.text()).not.toContain('Loading…')
    expect(backend.send).not.toHaveBeenCalled()
  })

  it('shows an error with a retry button when backend status is error', async () => {
    const backend = makeBackend('error')
    backend.lastError.value = 'backend did not start'
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(wrapper.text()).toContain('backend did not start')
    const retry = wrapper.find('.ep-retry')
    expect(retry.exists()).toBe(true)
    await retry.trigger('click')
    expect(backend.restart).toHaveBeenCalled()
  })

  it('loads the file once the backend connects', async () => {
    const backend = makeBackend('connecting')
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(backend.send).not.toHaveBeenCalled()

    backend.status.value = 'connected'
    await nextTick()
    await flushPromises()
    expect(backend.send).toHaveBeenCalledWith('fs.read_file', {
      workspace_path: '/ws',
      rel_path: 'a.txt',
    })
    expect(wrapper.find('.mock-monaco').text()).toBe('hello world')
  })

  it('retries a failed load after reconnect instead of latching the error', async () => {
    const backend = makeBackend('connected')
    backend.send.mockRejectedValueOnce(new Error('request fs.read_file timeout'))
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(wrapper.text()).toContain('request fs.read_file timeout')

    backend.status.value = 'disconnected'
    await nextTick()
    backend.status.value = 'connected'
    await nextTick()
    await flushPromises()
    expect(wrapper.text()).not.toContain('request fs.read_file timeout')
    expect(wrapper.find('.mock-monaco').text()).toBe('hello world')
  })
})
