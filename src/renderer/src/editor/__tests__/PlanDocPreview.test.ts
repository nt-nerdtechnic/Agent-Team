// @vitest-environment happy-dom
// Tests for the interactive plan preview host: the srcdoc iframe is built
// with allow-scripts sandbox, stripped document scripts, a CSP meta, and the
// injected runtime; a refresh bump reloads in place; messages that fail the
// source check never emit; outline navigation posts into the frame.
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import PlanDocPreview from '../PlanDocPreview.vue'
import { i18n } from '../../i18n'

i18n.global.locale.value = 'en-US'

const PLAN_DOC = [
  '<!doctype html><html><head><title>t</title>',
  '<script type="application/json" id="plan-meta">',
  JSON.stringify({
    schemaVersion: 1,
    name: 'Test Plan',
    overview: '',
    stage: 'in-progress',
    approvedAt: null,
    todos: [{ id: 'phase-a', content: 'Phase A', status: 'pending' }],
    reviewNotes: [
      { id: 'n1', author: 'user', text: 'note', resolved: false, reply: '', anchor: 'Goals' },
    ],
  }),
  '</scr' + 'ipt>',
  '<script>alert("evil")</scr' + 'ipt>',
  '</head><body><section><h2>Goals</h2></section></body></html>',
].join('\n')

function makeBackend(content: string | null) {
  return {
    httpUrl: ref('http://127.0.0.1:1'),
    status: ref('connected'),
    send: vi.fn(async (type: string) => {
      if (type === 'fs.read_file') {
        return content === null
          ? { payload: { ok: false, error: 'missing' } }
          : { payload: { ok: true, content } }
      }
      return { payload: { ok: true } }
    }),
  }
}

async function mountPreview(content: string | null = PLAN_DOC) {
  const backend = makeBackend(content)
  const wrapper = mount(PlanDocPreview, {
    props: {
      workspacePath: '/ws',
      relPath: '.agent-team/plans/test-plan_a1b2c3.html',
      backend: backend as never,
      refresh: 0,
    },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return { wrapper, backend }
}

describe('PlanDocPreview', () => {
  it('renders a srcdoc iframe sandboxed to allow-scripts with the runtime injected', async () => {
    const { wrapper } = await mountPreview()
    const frame = wrapper.find('iframe')
    expect(frame.exists()).toBe(true)
    expect(frame.attributes('sandbox')).toBe('allow-scripts')
    const srcdoc = frame.attributes('srcdoc') ?? ''
    // Document scripts are stripped, the data island survives, the CSP meta
    // and the nonce'd runtime are injected.
    expect(srcdoc).not.toContain('alert("evil")')
    expect(srcdoc).toContain('id="plan-meta"')
    expect(srcdoc).toContain('Content-Security-Policy')
    expect(srcdoc).toContain('todo-clicked')
    // The unresolved anchored note count is passed to the runtime.
    expect(srcdoc).toContain('"anchors":{"Goals":1}')
  })

  it('reloads the document in place when the refresh prop bumps', async () => {
    const { wrapper, backend } = await mountPreview()
    expect(backend.send).toHaveBeenCalledTimes(1)
    const before = wrapper.find('iframe').element

    await wrapper.setProps({ refresh: 1 })
    await flushPromises()

    expect(backend.send).toHaveBeenCalledTimes(2)
    expect(wrapper.find('iframe').element).toBe(before) // no remount
  })

  it('shows the error state with the backend reason and resolved path', async () => {
    const { wrapper } = await mountPreview(null)
    expect(wrapper.find('iframe').exists()).toBe(false)
    const error = wrapper.find('.pdp-error')
    expect(error.text()).toContain('Failed to load the plan document')
    expect(error.find('.pdp-error-reason').text()).toBe('missing')
    expect(error.find('.pdp-error-path').text()).toContain(
      '/ws › .agent-team/plans/test-plan_a1b2c3.html',
    )
  })

  it('ignores window messages whose source is not the preview frame', async () => {
    const { wrapper } = await mountPreview()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'todo-clicked', todoId: 'phase-a', alt: false },
      }),
    )
    await flushPromises()
    expect(wrapper.emitted('todo-clicked')).toBeUndefined()
    expect(wrapper.emitted('section-comment')).toBeUndefined()
  })

  it('scrollToAnchor posts a scroll-to message into the frame', async () => {
    const { wrapper } = await mountPreview()
    const frameWindow = (wrapper.find('iframe').element as HTMLIFrameElement).contentWindow
    if (!frameWindow) return // happy-dom without frame window support — covered by unit tests
    const postSpy = vi.spyOn(frameWindow, 'postMessage')
    ;(wrapper.vm as unknown as { scrollToAnchor: (a: string) => void }).scrollToAnchor('Goals')
    expect(postSpy).toHaveBeenCalledWith({ type: 'scroll-to', anchor: 'Goals' }, '*')
  })

  it('passes the inline edit/delete labels into the injected runtime', async () => {
    const { wrapper } = await mountPreview()
    const srcdoc = wrapper.find('iframe').attributes('srcdoc') ?? ''
    expect(srcdoc).toContain('"editLabel":"Edit"')
    expect(srcdoc).toContain('"deleteLabel":"Delete"')
    expect(srcdoc).toContain('"saveLabel":"Save"')
    expect(srcdoc).toContain('"cancelLabel":"Cancel"')
  })

  it('cancelEdit posts a cancel-edit message into the frame; isEditing starts false', async () => {
    const { wrapper } = await mountPreview()
    const vm = wrapper.vm as unknown as { isEditing: () => boolean; cancelEdit: () => void }
    expect(vm.isEditing()).toBe(false)
    const frameWindow = (wrapper.find('iframe').element as HTMLIFrameElement).contentWindow
    if (!frameWindow) return
    const postSpy = vi.spyOn(frameWindow, 'postMessage')
    vm.cancelEdit()
    expect(postSpy).toHaveBeenCalledWith({ type: 'cancel-edit' }, '*')
  })

  it('clears editing state when an external reload (loadDoc) runs', async () => {
    const { wrapper } = await mountPreview()
    const frameWindow = (wrapper.find('iframe').element as HTMLIFrameElement).contentWindow
    if (!frameWindow) return // covered by planRuntime message-handler unit tests
    const vm = wrapper.vm as unknown as { isEditing: () => boolean }
    // Enter editing state from the frame.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'section-editing', active: true },
        source: frameWindow,
      }),
    )
    await flushPromises()
    expect(vm.isEditing()).toBe(true)
    // An external refresh reloads the doc and must clear the stuck edit state.
    await wrapper.setProps({ refresh: 1 })
    await flushPromises()
    expect(vm.isEditing()).toBe(false)
  })

  it('emits validated section-edit/section-delete and tracks editing state from the frame', async () => {
    const { wrapper } = await mountPreview()
    const frameWindow = (wrapper.find('iframe').element as HTMLIFrameElement).contentWindow
    if (!frameWindow) return // covered by planRuntime message-handler unit tests
    const vm = wrapper.vm as unknown as { isEditing: () => boolean }
    const fire = (data: unknown): void => {
      window.dispatchEvent(new MessageEvent('message', { data, source: frameWindow }))
    }
    fire({ type: 'section-edit', anchor: 'Goals', html: '<p>x</p>' })
    fire({ type: 'section-delete', anchor: 'Goals' })
    fire({ type: 'section-editing', active: true })
    await flushPromises()
    expect(wrapper.emitted('section-edit')?.[0]).toEqual([{ anchor: 'Goals', html: '<p>x</p>' }])
    expect(wrapper.emitted('section-delete')?.[0]).toEqual(['Goals'])
    expect(vm.isEditing()).toBe(true)
  })
})
