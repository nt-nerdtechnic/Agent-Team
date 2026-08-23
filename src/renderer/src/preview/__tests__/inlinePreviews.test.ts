// @vitest-environment happy-dom
// The two file-less bodies. Both render content an agent produced, so the
// tests pin the parts that decide whether that content is readable (line
// numbering, fence handling) and whether a failure degrades or blanks out.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SnippetPreview from '../SnippetPreview.vue'
import MarkdownPreview from '../MarkdownPreview.vue'

// mermaid is a dynamic import inside the component, so it has to be mocked at
// module level — vi.doMock inside a test lands too late once another case has
// already pulled the real module in.
const mermaidState = vi.hoisted(() => ({ fail: false }))
vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: () =>
      mermaidState.fail
        ? Promise.reject(new Error('bad syntax'))
        : Promise.resolve({ svg: '<svg data-testid="diagram"></svg>' }),
  },
}))

// The block renders after two awaits (import, then render); loop rather than
// guessing a single tick.
async function settle(w: { vm: { $nextTick: () => Promise<void> } }) {
  for (let i = 0; i < 6; i += 1) {
    await flushPromises()
    await w.vm.$nextTick()
  }
}

describe('SnippetPreview', () => {
  it('numbers every line', () => {
    const w = mount(SnippetPreview, { props: { content: 'a\nb\nc' } })
    const nums = w.findAll('.sp-ln').map((n) => n.text())
    expect(nums).toEqual(['1', '2', '3'])
    w.unmount()
  })

  it('does not invent a trailing empty line', () => {
    // Files normally end with a newline; showing a phantom last line would
    // misreport the snippet's length.
    const w = mount(SnippetPreview, { props: { content: 'a\nb\n' } })
    expect(w.findAll('.sp-ln')).toHaveLength(2)
    w.unmount()
  })

  it('renders content as text, never as markup', () => {
    const w = mount(SnippetPreview, { props: { content: '<img onerror=x>' } })
    expect(w.find('img').exists()).toBe(false)
    expect(w.text()).toContain('<img onerror=x>')
    w.unmount()
  })

  it('handles empty content without crashing', () => {
    const w = mount(SnippetPreview, { props: { content: '' } })
    expect(w.findAll('.sp-ln')).toHaveLength(1)
    w.unmount()
  })
})

describe('MarkdownPreview', () => {
  beforeEach(() => {
    mermaidState.fail = false
  })

  it('renders headings, bullets and paragraphs', () => {
    const w = mount(MarkdownPreview, {
      props: { content: '# Title\n\nsome text\n\n- one\n- two' },
    })
    expect(w.find('.mp-h').text()).toBe('Title')
    expect(w.findAll('.mp-li')).toHaveLength(2)
    expect(w.text()).toContain('some text')
    w.unmount()
  })

  it('renders a non-mermaid fence as a code block', () => {
    const w = mount(MarkdownPreview, { props: { content: '```ts\nconst a = 1\n```' } })
    expect(w.find('.mp-code').text()).toContain('const a = 1')
    w.unmount()
  })

  it('renders a mermaid fence as a diagram', async () => {
    mermaidState.fail = false
    const w = mount(MarkdownPreview, { props: { content: '```mermaid\ngraph TD;A-->B;\n```' } })
    await settle(w)
    expect(w.find('[data-testid="diagram"]').exists()).toBe(true)
    w.unmount()
  })

  it('falls back to a code block when mermaid fails', async () => {
    // A diagram that cannot render must leave the source visible rather than
    // an empty gap the user cannot diagnose.
    mermaidState.fail = true
    const w = mount(MarkdownPreview, { props: { content: '```mermaid\nnot a diagram\n```' } })
    await settle(w)
    expect(w.find('.mp-code').text()).toContain('not a diagram')
    expect(w.find('[data-testid="diagram"]').exists()).toBe(false)
    w.unmount()
  })
})
