// @vitest-environment happy-dom
// Markdown plan body: renders `## section` prose from a .plan.md and routes
// inline section edit/delete through the injected PlanStore (never fs directly),
// mirroring PlanDocPreview's role for HTML plans.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, config, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import PlanMarkdownBody from '../PlanMarkdownBody.vue'
import { i18n } from '@navide/ui-foundation'
import { resolvePlanStore } from '../../composables/planStore'

i18n.global.locale.value = 'en-US'
config.global.plugins = [i18n]

const confirmMock = vi.fn(async () => true)
vi.mock('@navide/ui-foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/ui-foundation')>()),
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: confirmMock }),
}))

const MD_PLAN = `---
name: MD Plan
overview: ov
todos:
  - id: t1
    content: First
    status: pending
stage: in-review
---

## Phase A

Body A prose.

## Notes

Note body.
`

const PLAIN_MD = `# Just a doc

Some prose without frontmatter.
`

const REL = '.cursor/plans/demo.plan.md'

// Stateful backend: reads serve current content, writes update it + record.
function makeBackend(initial: string) {
  const state = { content: initial, writes: [] as string[] }
  const backend = {
    status: ref('connected'),
    send: vi.fn(async (channel: string, payload: Record<string, unknown>) => {
      if (channel === 'fs.read_file') return { payload: { ok: true, content: state.content, mtime: 1 } }
      if (channel === 'fs.write_file') {
        state.writes.push(payload.content as string)
        state.content = payload.content as string
        return { payload: { ok: true, mtime: 2 } }
      }
      return { payload: { ok: false } }
    }),
  }
  return { backend, state }
}

function mountBody(content: string): { wrapper: VueWrapper; state: { writes: string[] } } {
  const { backend, state } = makeBackend(content)
  const wrapper = mount(PlanMarkdownBody, {
    props: { workspacePath: '/ws', relPath: REL, backend: backend as never, refresh: 0 },
  })
  return { wrapper, state }
}

beforeEach(() => {
  confirmMock.mockReset().mockResolvedValue(true)
})

describe('PlanMarkdownBody – rendering', () => {
  it('renders each ## section heading and prose', async () => {
    const { wrapper } = mountBody(MD_PLAN)
    await flushPromises()
    const sections = wrapper.findAll('.pmb-section')
    expect(sections).toHaveLength(2)
    expect(wrapper.text()).toContain('Phase A')
    expect(wrapper.text()).toContain('Body A prose.')
    expect(wrapper.text()).toContain('Notes')
  })

  it('renders plain markdown (no frontmatter) read-only, with no edit buttons', async () => {
    const { wrapper } = mountBody(PLAIN_MD)
    await flushPromises()
    expect(wrapper.text()).toContain('Just a doc')
    expect(wrapper.text()).toContain('Some prose without frontmatter.')
    expect(wrapper.find('.pmb-section').exists()).toBe(false)
    expect(wrapper.find('.pmb-btn').exists()).toBe(false)
  })

  it('shows frontmatter todos in the body when a plan has no prose sections', async () => {
    const todoOnly = `---
name: Todo Only
overview: ov
todos:
  - id: t1
    content: Ship the thing
    status: pending
stage: draft
---
`
    const { wrapper } = mountBody(todoOnly)
    await flushPromises()
    // Not the empty state — the todo is rendered read-only in the body.
    expect(wrapper.text()).not.toContain('No content yet')
    expect(wrapper.find('.pmb-todos-section').exists()).toBe(true)
    expect(wrapper.text()).toContain('Ship the thing')
    // No prose sections, so the section CRUD controls are absent here.
    expect(wrapper.find('.pmb-section').exists()).toBe(false)
  })
})

describe('PlanMarkdownBody – section edit/delete via store', () => {
  it('saves a section edit through store.replaceSectionBody({kind:markdown})', async () => {
    const store = resolvePlanStore(REL)
    const spy = vi.spyOn(store, 'replaceSectionBody')
    try {
      const { wrapper, state } = mountBody(MD_PLAN)
      await flushPromises()

      // First section (Phase A): open the edit textarea.
      const firstSection = wrapper.findAll('.pmb-section')[0]
      const editBtn = firstSection.findAll('.pmb-btn').find((b) => b.text() === 'Edit')!
      await editBtn.trigger('click')
      const textarea = firstSection.find('.pmb-textarea')
      expect(textarea.exists()).toBe(true)
      // The textarea holds the section's raw markdown body (parsePlanFile keeps
      // the leading blank line after the heading).
      expect((textarea.element as HTMLTextAreaElement).value).toContain('Body A prose.')

      await textarea.setValue('Rewritten body.')
      const saveBtn = firstSection.findAll('.pmb-btn').find((b) => b.text() === 'Save')!
      await saveBtn.trigger('click')
      await flushPromises()

      expect(spy).toHaveBeenCalledTimes(1)
      const [, heading, body] = spy.mock.calls[0]
      expect(heading).toBe('Phase A')
      expect(body).toEqual({ kind: 'markdown', text: 'Rewritten body.' })
      // A real write went out and preserved the untouched section.
      expect(state.writes).toHaveLength(1)
      expect(state.writes[0]).toContain('Rewritten body.')
      expect(state.writes[0]).toContain('## Notes')
      expect(wrapper.emitted('updated')).toBeTruthy()
    } finally {
      spy.mockRestore()
    }
  })

  it('deletes a section through store.deleteSection after confirmation', async () => {
    const store = resolvePlanStore(REL)
    const spy = vi.spyOn(store, 'deleteSection')
    try {
      const { wrapper, state } = mountBody(MD_PLAN)
      await flushPromises()

      const notesSection = wrapper.findAll('.pmb-section')[1]
      const delBtn = notesSection.findAll('.pmb-btn').find((b) => b.text() === 'Delete')!
      await delBtn.trigger('click')
      await flushPromises()

      expect(confirmMock).toHaveBeenCalled()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][1]).toBe('Notes')
      expect(state.writes).toHaveLength(1)
      expect(state.writes[0]).not.toContain('## Notes')
      expect(state.writes[0]).toContain('## Phase A')
    } finally {
      spy.mockRestore()
    }
  })

  it('writes nothing when the delete confirmation is declined', async () => {
    const store = resolvePlanStore(REL)
    const spy = vi.spyOn(store, 'deleteSection')
    confirmMock.mockResolvedValueOnce(false)
    try {
      const { wrapper, state } = mountBody(MD_PLAN)
      await flushPromises()
      const delBtn = wrapper.findAll('.pmb-section')[1].findAll('.pmb-btn').find((b) => b.text() === 'Delete')!
      await delBtn.trigger('click')
      await flushPromises()
      expect(spy).not.toHaveBeenCalled()
      expect(state.writes).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('PlanMarkdownBody – ESC integration surface', () => {
  it('exposes isEditing()/cancelEdit() for the host ESC handler', async () => {
    const { wrapper } = mountBody(MD_PLAN)
    await flushPromises()
    const vm = wrapper.vm as unknown as { isEditing: () => boolean; cancelEdit: () => void }
    expect(vm.isEditing()).toBe(false)

    const editBtn = wrapper.findAll('.pmb-section')[0].findAll('.pmb-btn').find((b) => b.text() === 'Edit')!
    await editBtn.trigger('click')
    expect(vm.isEditing()).toBe(true)

    vm.cancelEdit()
    await flushPromises()
    expect(vm.isEditing()).toBe(false)
    expect(wrapper.find('.pmb-textarea').exists()).toBe(false)
  })
})

describe('PlanMarkdownBody – inline todo editing via store', () => {
  it('cycles a todo status through store.writeMeta', async () => {
    const store = resolvePlanStore(REL)
    const spy = vi.spyOn(store, 'writeMeta')
    try {
      const { wrapper, state } = mountBody(MD_PLAN)
      await flushPromises()

      const statusBtn = wrapper.find('.pmb-todos-section .pmb-todo-status')
      expect(statusBtn.text()).toBe('pending')
      await statusBtn.trigger('click')
      await flushPromises()

      expect(spy).toHaveBeenCalledTimes(1)
      expect(state.writes).toHaveLength(1)
      expect(state.writes[0]).toContain('in_progress')
      expect(wrapper.emitted('updated')).toBeTruthy()
    } finally {
      spy.mockRestore()
    }
  })

  it('edits todo text inline and writes it through the store', async () => {
    const store = resolvePlanStore(REL)
    const spy = vi.spyOn(store, 'writeMeta')
    try {
      const { wrapper, state } = mountBody(MD_PLAN)
      await flushPromises()

      const editBtn = wrapper
        .find('.pmb-todos-section')
        .findAll('.pmb-btn')
        .find((b) => b.text() === 'Edit')!
      await editBtn.trigger('click')
      const input = wrapper.find('.pmb-todo-input')
      expect(input.exists()).toBe(true)
      await input.setValue('Reworded todo')
      await wrapper.find('.pmb-todos-section .pmb-btn--primary').trigger('click')
      await flushPromises()

      expect(spy).toHaveBeenCalledTimes(1)
      expect(state.writes).toHaveLength(1)
      expect(state.writes[0]).toContain('Reworded todo')
      expect(wrapper.find('.pmb-todo-input').exists()).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})
