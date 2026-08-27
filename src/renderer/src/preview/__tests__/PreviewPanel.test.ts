// @vitest-environment happy-dom
// The panel is a dispatcher: every body is an existing component, so what has
// to be pinned is the wiring, not the rendering. Two of these are safety
// tests — the read-only flag on DiffPane and the empty sandbox on inline HTML
// — because losing either turns a read-only panel into one that can write to
// the working tree or execute pushed markup.
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, shallowMount } from '@vue/test-utils'
import { ref } from 'vue'
import PreviewPanel from '../PreviewPanel.vue'
import InlineHtmlPreview from '../InlineHtmlPreview.vue'
import DiffPane from '../../editor/DiffPane.vue'
import FilePreviewPane from '../../editor/FilePreviewPane.vue'
import { usePreview } from '../usePreview'

const backend = {
  httpUrl: ref('http://127.0.0.1:1234'),
  send: async () => ({ ok: true, payload: {} }),
} as unknown as Parameters<typeof mountPanel>[0]

function mountPanel(_b?: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return shallowMount(PreviewPanel as any, {
    props: { backend, workspacePath: '/ws' },
    global: { mocks: { $t: (key: string) => key } },
  })
}

describe('PreviewPanel', () => {
  beforeEach(() => {
    usePreview().reset()
  })

  it('shows the empty state when nothing has been pushed', () => {
    const w = mountPanel()
    expect(w.find('.pv-empty').exists()).toBe(true)
    expect(w.find('.pv-hdr').exists()).toBe(false)
    w.unmount()
  })

  it('mounts FilePreviewPane for a file target with the paths it expects', async () => {
    usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'src/a.png' })
    const w = mountPanel()
    await w.vm.$nextTick()
    const fp = w.findComponent(FilePreviewPane)
    expect(fp.exists()).toBe(true)
    expect(fp.props('relPath')).toBe('src/a.png')
    expect(fp.props('workspacePath')).toBe('/ws')
    // The header shows the basename, not the whole path.
    expect(w.find('.pv-title').text()).toBe('a.png')
    w.unmount()
  })

  it('always mounts DiffPane read-only', async () => {
    usePreview().show({ kind: 'diff', workspacePath: '/ws', relPath: 'a.ts', staged: true })
    const w = mountPanel()
    await w.vm.$nextTick()
    const dp = w.findComponent(DiffPane)
    expect(dp.exists()).toBe(true)
    expect(dp.props('readonly')).toBe(true)
    expect(dp.props('staged')).toBe(true)
    expect(dp.props('filepath')).toBe('a.ts')
    w.unmount()
  })

  it('offers copy for inline content and open-in-editor for file-backed targets', async () => {
    const w = mountPanel()
    usePreview().show({ kind: 'snippet', content: 'const a = 1' })
    await w.vm.$nextTick()
    let labels = w.findAll('.pv-btn').map((b) => b.text())
    expect(labels).toContain('preview.copy')
    expect(labels).not.toContain('preview.open')

    usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'a.ts' })
    await w.vm.$nextTick()
    labels = w.findAll('.pv-btn').map((b) => b.text())
    expect(labels).toContain('preview.open')
    expect(labels).not.toContain('preview.copy')
    w.unmount()
  })

  it('flags a sandboxed HTML preview in the footer', async () => {
    usePreview().show({ kind: 'html', content: '<p>x</p>' })
    const w = mountPanel()
    await w.vm.$nextTick()
    expect(w.find('.pv-foot').text()).toContain('preview.sandboxed')
    w.unmount()
  })

  it('attributes agent pushes and stays silent for user actions', async () => {
    usePreview().show({ kind: 'markdown', content: '# t', source: 'agent', origin: 'claude' })
    const w = mountPanel()
    await w.vm.$nextTick()
    expect(w.find('.pv-foot').text()).toContain('claude')

    usePreview().show({ kind: 'markdown', content: '# t2', source: 'user' })
    await w.vm.$nextTick()
    expect(w.find('.pv-foot').text()).not.toContain('user')
    w.unmount()
  })

  it('refuses "open in editor" for a target from another workspace', async () => {
    // The payload's workspacePath is not validated anywhere upstream, so a
    // pushed target could otherwise aim a read-write editor window at an
    // arbitrary directory.
    usePreview().show({ kind: 'file', workspacePath: '/somewhere/else', relPath: 'id_rsa' })
    const w = mountPanel()
    await w.vm.$nextTick()
    expect(w.findAll('.pv-btn').map((b) => b.text())).not.toContain('preview.open')
    expect(w.find('.pv-foot').text()).toContain('preview.foreign-workspace')
    w.unmount()
  })

  it('still offers "open in editor" for the panel\'s own workspace', async () => {
    // Guard the guard: the refusal above must not be passing because the
    // button never renders.
    usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'a.ts' })
    const w = mountPanel()
    await w.vm.$nextTick()
    expect(w.findAll('.pv-btn').map((b) => b.text())).toContain('preview.open')
    expect(w.find('.pv-foot').text()).not.toContain('preview.foreign-workspace')
    w.unmount()
  })

  it('close clears the target back to the empty state', async () => {
    usePreview().show({ kind: 'snippet', content: 'x' })
    const w = mountPanel()
    await w.vm.$nextTick()
    await w.find('.pv-x').trigger('click')
    expect(w.find('.pv-empty').exists()).toBe(true)
    w.unmount()
  })
})

describe('InlineHtmlPreview', () => {
  it('renders pushed HTML in a fully locked-down iframe', () => {
    // Two independent layers. sandbox="" (no allow-*) stops scripts, forms and
    // same-origin access; the injected CSP stops subresource requests, which
    // the sandbox attribute does NOT cover — without it a pushed
    // <img src="http://…"> would still phone home.
    const w = mount(InlineHtmlPreview, { props: { content: '<p>hi</p>', title: 't' } })
    const frame = w.find('iframe')
    expect(frame.attributes('sandbox')).toBe('')
    const srcdoc = frame.attributes('srcdoc') ?? ''
    expect(srcdoc).toContain("default-src 'none'")
    expect(srcdoc).toContain('<p>hi</p>')
    // The CSP must precede the content, or the document has already started
    // fetching by the time the policy is parsed.
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<p>hi</p>'))
    w.unmount()
  })
})
