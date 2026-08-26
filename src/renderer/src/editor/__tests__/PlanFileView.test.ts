// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, config } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import PlanFileView from '../PlanFileView.vue'
import { i18n } from '@navide/ui-foundation'

// PlanFileView now uses vue-i18n for its inline edit controls; install it for
// every mount in this file (vitest isolates modules per file, so no leak).
i18n.global.locale.value = 'en-US'
config.global.plugins = [i18n]

const PLAN_RAW = `---
name: My Feature Plan
overview: A plan to test the component.
todos:
  - id: phase-a-task
    content: Build the parser.
    status: pending
  - id: phase-b-task
    content: Build the component.
    status: done
isProject: false
---

## Phase A — Parser

Description of phase A.

## Phase B — Component

Description of phase B.

## 修改檔案清單

- \`src/main/index.ts\` — update main process.
- \`src/renderer/src/App.vue\` — update renderer.
`

function makeBackend(content = PLAN_RAW) {
  return {
    status: ref('connected'),
    send: vi.fn(async (channel: string) => {
      if (channel === 'fs.read_file') return { payload: { ok: true, content } }
      if (channel === 'fs.write_file') return { payload: { ok: true } }
      return { payload: { ok: false } }
    }),
  }
}

// Stub useNotify so toast calls don't throw.
vi.mock('@navide/ui-foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/ui-foundation')>()),
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }),
}))

describe('PlanFileView – rendering', () => {
  it('renders the plan name and overview', async () => {
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: makeBackend() as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('My Feature Plan')
    expect(wrapper.text()).toContain('A plan to test the component.')
  })

  it('renders phase group headings', async () => {
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: makeBackend() as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Phase A — Parser')
    expect(wrapper.text()).toContain('Phase B — Component')
  })

  it('renders todo contents with status badges', async () => {
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: makeBackend() as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Build the parser.')
    expect(wrapper.text()).toContain('Build the component.')
    expect(wrapper.text()).toContain('pending')
    expect(wrapper.text()).toContain('done')
  })

  it('shows a progress fraction per group', async () => {
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: makeBackend() as never },
    })
    await flushPromises()
    // Phase A has 0/1 done; Phase B has 1/1 done.
    expect(wrapper.text()).toContain('0/1 done')
    expect(wrapper.text()).toContain('1/1 done')
  })

  it('shows an error message when content cannot be loaded', async () => {
    const backend = {
      send: vi.fn(async () => ({ payload: { ok: false, error: 'File not found' } })),
    }
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'missing.plan.md', backend: backend as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('File not found')
  })

  it('renders files without frontmatter as plain markdown', async () => {
    const backend = makeBackend(
      '# Not a plan file\n\n> a quoted line\n\nJust **bold** markdown with `chip`, see [Docs](https://example.com).\n\n- a bullet item\n1. first step\n'
    )
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'bad.plan.md', backend: backend as never },
    })
    await flushPromises()
    expect(wrapper.text()).not.toContain('Could not parse plan frontmatter')
    expect(wrapper.find('.pfv-line--heading').text()).toBe('Not a plan file')
    expect(wrapper.find('.pfv-line--bullet').text()).toBe('a bullet item')
    // Inline markdown: `code` becomes a chip, **bold** becomes <strong>, markers stripped.
    expect(wrapper.text()).not.toContain('**')
    expect(wrapper.find('.pfv-line code').text()).toBe('chip')
    expect(wrapper.find('.pfv-line strong').text()).toBe('bold')
    expect(wrapper.find('.pfv-line--ordered').text()).toContain('first step')
    // Heading level class, blockquote, and external link.
    expect(wrapper.find('.pfv-line--h1').text()).toBe('Not a plan file')
    expect(wrapper.find('.pfv-line--quote').text()).toBe('a quoted line')
    const link = wrapper.find('.pfv-link')
    expect(link.text()).toBe('Docs')
    expect(link.attributes('href')).toBe('https://example.com')
  })

  it('shows fallback message for an empty plan file', async () => {
    const backend = makeBackend('')
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'empty.plan.md', backend: backend as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Could not parse plan frontmatter')
  })

  it('renders non-phase markdown sections and modified files', async () => {
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: makeBackend() as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Modified Files')
    expect(wrapper.text()).toContain('src/main/index.ts')
    expect(wrapper.text()).toContain('src/renderer/src/App.vue')
  })

  it('waits for backend connection before reading', async () => {
    const backend = makeBackend()
    backend.status.value = 'connecting'
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Waiting for backend')
    expect(backend.send).not.toHaveBeenCalled()

    backend.status.value = 'connected'
    await nextTick()
    await flushPromises()
    expect(backend.send).toHaveBeenCalledWith('fs.read_file', {
      workspace_path: '/ws',
      rel_path: 'test.plan.md',
    })
  })
})

describe('PlanFileView – checkbox interaction', () => {
  it('clicking a pending todo cycles it to in-progress and saves', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()

    // Find the first todo row (phase-a-task which is 'pending').
    const todos = wrapper.findAll('.pfv-todo')
    expect(todos.length).toBeGreaterThan(0)
    await todos[0].trigger('click')
    await flushPromises()

    // fs.write_file should have been called.
    const writeCall = (backend.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === 'fs.write_file'
    )
    expect(writeCall).toBeDefined()

    // The written content should have the updated status.
    const writtenContent: string = writeCall![1].content
    expect(writtenContent).toContain('status: in_progress')
  })

  it('adds a new todo via + New', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()

    await wrapper.find('.pfv-new-btn').trigger('click')
    await wrapper.find('.pfv-new-input').setValue('A brand new task')
    await wrapper.find('.pfv-new-input').trigger('keydown.enter')
    await flushPromises()

    const writeCall = (backend.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === 'fs.write_file'
    )
    expect(writeCall).toBeDefined()
    const writtenContent: string = writeCall![1].content
    expect(writtenContent).toContain('content: A brand new task')
    expect(writtenContent).toContain('- id: todo-3')
  })

  it('does not add a new todo while the IME is composing', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()

    await wrapper.find('.pfv-new-btn').trigger('click')
    await wrapper.find('.pfv-new-input').setValue('Composing task')
    await wrapper.find('.pfv-new-input').trigger('keydown', { key: 'Enter', isComposing: true })
    await flushPromises()

    const writeCall = (backend.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === 'fs.write_file'
    )
    expect(writeCall).toBeUndefined()
  })

  it('removes a todo via its remove button', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()

    await wrapper.findAll('.pfv-todo-remove')[0].trigger('click')
    await flushPromises()

    const writeCall = (backend.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === 'fs.write_file'
    )
    expect(writeCall).toBeDefined()
    const writtenContent: string = writeCall![1].content
    expect(writtenContent).not.toContain('Build the parser.')
    expect(writtenContent).toContain('Build the component.')
  })

  it('clicking a done todo cycles it back to pending', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()

    // The second todo (phase-b-task) is 'done'.
    const todos = wrapper.findAll('.pfv-todo')
    await todos[1].trigger('click')
    await flushPromises()

    const writeCall = (backend.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === 'fs.write_file'
    )
    const writtenContent: string = writeCall![1].content
    expect(writtenContent).toContain('status: pending')
  })
})

describe('PlanFileView – todo text editing', () => {
  it('edits a todo\'s text and saves the new content', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()

    await wrapper.findAll('.pfv-todo-edit')[0].trigger('click')
    const input = wrapper.find('.pfv-todo-edit-input')
    expect(input.exists()).toBe(true)
    await input.setValue('Rewritten task text')
    await input.trigger('keydown', { key: 'Enter', isComposing: false })
    await flushPromises()

    const writeCall = (backend.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === 'fs.write_file'
    )
    expect(writeCall).toBeDefined()
    const writtenContent: string = writeCall![1].content
    expect(writtenContent).toContain('content: Rewritten task text')
    // The original body/heading and the untouched todo remain.
    expect(writtenContent).toContain('content: Build the component.')
  })

  it('does not submit a todo edit while the IME is composing', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()

    await wrapper.findAll('.pfv-todo-edit')[0].trigger('click')
    const input = wrapper.find('.pfv-todo-edit-input')
    await input.setValue('Composing text')
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    await flushPromises()

    const writeCall = (backend.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === 'fs.write_file'
    )
    expect(writeCall).toBeUndefined()
  })

  it('does not save an empty todo edit', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()

    await wrapper.findAll('.pfv-todo-edit')[0].trigger('click')
    const input = wrapper.find('.pfv-todo-edit-input')
    await input.setValue('   ')
    await input.trigger('keydown', { key: 'Enter', isComposing: false })
    await flushPromises()

    const writeCall = (backend.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === 'fs.write_file'
    )
    expect(writeCall).toBeUndefined()
  })
})

describe('PlanFileView – section body editing', () => {
  it('edits a document section and writes it back, preserving the rest', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()

    // The only non-phase document section is "修改檔案清單".
    const section = wrapper.find('.pfv-doc-section')
    expect(section.exists()).toBe(true)
    await section.find('.pfv-inline-btn').trigger('click') // Edit
    const textarea = wrapper.find('.pfv-section-textarea')
    expect(textarea.exists()).toBe(true)
    await textarea.setValue('Replaced section body line.')
    await wrapper.find('.pfv-inline-btn--primary').trigger('click') // Save
    await flushPromises()

    const writeCall = (backend.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === 'fs.write_file'
    )
    expect(writeCall).toBeDefined()
    const content: string = writeCall![1].content
    // New body present under its heading; frontmatter + other sections intact.
    expect(content).toContain('## 修改檔案清單')
    expect(content).toContain('Replaced section body line.')
    expect(content).toContain('name: My Feature Plan')
    expect(content).toContain('Description of phase A.')
    // Old file-list content is gone from that section.
    expect(content).not.toContain('update main process.')
  })

  it('sends an optimistic-lock read before writing a section', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()

    await wrapper.find('.pfv-doc-section .pfv-inline-btn').trigger('click')
    await wrapper.find('.pfv-section-textarea').setValue('Fresh body.')
    await wrapper.find('.pfv-inline-btn--primary').trigger('click')
    await flushPromises()

    // A read precedes the write so the section merge runs against fresh content.
    const calls = (backend.send as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) => c[0])
    const writeIdx = calls.lastIndexOf('fs.write_file')
    expect(writeIdx).toBeGreaterThan(0)
    expect(calls.slice(0, writeIdx)).toContain('fs.read_file')
  })
})

describe('PlanFileView – readonly (snapshot preview)', () => {
  it('never writes when a todo is clicked in readonly mode', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'snap.plan.md', backend: backend as never, readonly: true },
    })
    await flushPromises()

    const todos = wrapper.findAll('.pfv-todo')
    expect(todos.length).toBeGreaterThan(0)
    await todos[0].trigger('click')
    await flushPromises()

    const wrote = (backend.send as ReturnType<typeof vi.fn>).mock.calls.some(
      (c: string[]) => c[0] === 'fs.write_file'
    )
    expect(wrote).toBe(false)
  })

  it('hides the + New and section Edit controls in readonly mode', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'snap.plan.md', backend: backend as never, readonly: true },
    })
    await flushPromises()

    expect(wrapper.find('.pfv-new-btn').exists()).toBe(false)
    expect(wrapper.find('.pfv-doc-section .pfv-inline-btn').exists()).toBe(false)
    // Content still renders read-only.
    expect(wrapper.findAll('.pfv-todo').length).toBeGreaterThan(0)
  })
})
