// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SearchPane from '../SearchPane.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { WsResponse } from '../../composables/useBackend'

const notify = vi.hoisted(() => ({
  toast: vi.fn(),
  alert: vi.fn(),
  confirm: vi.fn(),
}))
vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => notify,
}))

beforeEach(() => {
  notify.toast.mockClear()
  notify.alert.mockClear()
  notify.confirm.mockReset()
})

function mountPane(backend: unknown) {
  return mount(SearchPane, {
    props: { workspacePath: '/ws', backend: backend as never },
    global: { plugins: [i18n] },
  })
}

const MATCH = { line: 1, col: 0, end: 3, text: 'foo bar' }
const FILE_RESULT = { rel_path: 'a.ts', name: 'a.ts', matches: [MATCH] }

function findResponse(payload: unknown): WsResponse {
  return { id: 't', type: 'search.find_in_files', ok: true, payload, error: null, timestamp: '' } as WsResponse
}

/** Replace the mock's instant send with one that resolves manually per call. */
function deferSend(mock: ReturnType<typeof createMockBackend>) {
  const pending: { type: string; resolve: (r: WsResponse) => void }[] = []
  ;(mock.backend as unknown as Record<string, unknown>).send = (type: string) =>
    new Promise<WsResponse>((resolve) => pending.push({ type, resolve }))
  return pending
}

describe('SearchPane – stale in-flight searches', () => {
  it('clearing the query drops an in-flight search response', async () => {
    const mock = createMockBackend('connected')
    const pending = deferSend(mock)
    const wrapper = mountPane(mock.backend)

    const input = wrapper.find('.sp-input')
    await input.setValue('foo')
    await input.trigger('keydown.enter') // doSearch immediately, bypassing debounce
    expect(pending).toHaveLength(1)

    // User clears the query while the search is still in flight.
    await input.setValue('')
    await flushPromises()

    // The stale response arrives afterwards — it must not repopulate the pane.
    pending[0].resolve(findResponse({ ok: true, results: [FILE_RESULT], total: 1 }))
    await flushPromises()

    expect(wrapper.text()).not.toContain('result(s)')
    expect(wrapper.findAll('.sp-file')).toHaveLength(0)
  })

  it('Esc (clearSearch) drops an in-flight search response', async () => {
    const mock = createMockBackend('connected')
    const pending = deferSend(mock)
    const wrapper = mountPane(mock.backend)

    const input = wrapper.find('.sp-input')
    await input.setValue('foo')
    await input.trigger('keydown.enter')
    expect(pending).toHaveLength(1)

    await input.trigger('keydown.esc')
    await flushPromises()

    pending[0].resolve(findResponse({ ok: true, results: [FILE_RESULT], total: 1 }))
    await flushPromises()

    expect(wrapper.text()).not.toContain('result(s)')
    expect(wrapper.findAll('.sp-file')).toHaveLength(0)
  })
})

describe('SearchPane – Replace All truncation guard', () => {
  it('disables Replace All and blocks the flow when results are truncated', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('search.find_in_files', {
      ok: true,
      results: [FILE_RESULT],
      total: 2000,
      truncated: true,
    })
    const wrapper = mountPane(mock.backend)

    await wrapper.find('.sp-expand').trigger('click') // show the replace row
    const input = wrapper.find('.sp-input')
    await input.setValue('foo')
    await input.trigger('keydown.enter')
    await flushPromises()

    const btn = wrapper.find('.sp-replace-all')
    expect(btn.attributes('disabled')).toBeDefined()

    // Enter in the replace input also routes through replaceAll — it must be
    // blocked with a warning instead of silently replacing a partial file set.
    notify.alert.mockClear()
    const replaceInput = wrapper.findAll('.sp-input')[1]
    await replaceInput.setValue('bar')
    await replaceInput.trigger('keydown.enter')
    await flushPromises()

    expect(notify.alert).toHaveBeenCalled()
    expect(notify.confirm).not.toHaveBeenCalled()
    expect(mock.sent.some((s) => s.type === 'search.replace_in_files')).toBe(false)
  })

  it('allows Replace All when results are not truncated', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('search.find_in_files', {
      ok: true,
      results: [FILE_RESULT],
      total: 1,
      truncated: false,
    })
    mock.setResponse('search.replace_in_files', { ok: true, changed: [{ rel_path: 'a.ts', count: 1 }], total: 1 })
    notify.confirm.mockResolvedValue(true)
    const wrapper = mountPane(mock.backend)

    await wrapper.find('.sp-expand').trigger('click')
    const input = wrapper.find('.sp-input')
    await input.setValue('foo')
    await input.trigger('keydown.enter')
    await flushPromises()

    const btn = wrapper.find('.sp-replace-all')
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    await flushPromises()

    expect(mock.sent.some((s) => s.type === 'search.replace_in_files')).toBe(true)
  })
})
