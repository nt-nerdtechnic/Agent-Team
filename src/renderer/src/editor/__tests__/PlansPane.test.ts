// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import PlansPane from '../PlansPane.vue'
import { i18n } from '../../i18n'
import { parseHtmlPlanMeta } from '../../composables/usePlanHtml'
import { parsePlanMeta } from '../../composables/usePlanFile'

i18n.global.locale.value = 'en-US'

// Collapse state now persists to localStorage per workspace; happy-dom shares
// one localStorage across the file, so reset it before each test to keep the
// default-collapse assumptions (e.g. Archived folded) isolated.
beforeEach(() => localStorage.clear())

// Markdown plan carrying an explicit stage (unified list groups it by stage,
// same as HTML plans — not the legacy Active/Completed split).
const MD_REVIEW_PLAN = `---
name: MD Review Plan
overview: Awaiting review.
stage: in-review
todos:
  - id: phase-a
    content: First
    status: done
  - id: phase-b
    content: Second
    status: pending
---

# MD Review Plan
`

// Markdown doc with no frontmatter — listed as a doc, promotable to a plan.
const MD_DOC = `# Email Attachments

Support attaching files to outgoing email.

More detail here.
`

const ACTIVE_PLAN = `---
name: Active Plan
overview: Work still pending.
todos:
  - id: phase-a
    content: Do work.
    status: pending
isProject: false
---
`

const DONE_PLAN = `---
name: Done Plan
overview: Completed work.
todos:
  - id: phase-a
    content: Done work.
    status: completed
isProject: false
---
`

function htmlPlan(meta: Record<string, unknown>): string {
  return `<!doctype html>
<html><head><title>x</title>
<script type="application/json" id="plan-meta">
${JSON.stringify(meta, null, 2)}
</script>
</head><body></body></html>`
}

const HTML_REVIEW_PLAN = htmlPlan({
  schemaVersion: 1,
  name: 'HTML Review Plan',
  overview: 'Awaiting review.',
  stage: 'in-review',
  approvedAt: null,
  todos: [
    { id: 'phase-a', content: 'First', status: 'done' },
    { id: 'phase-b', content: 'Second', status: 'pending' },
  ],
  reviewNotes: [],
})

const HTML_DONE_PLAN = htmlPlan({
  schemaVersion: 1,
  name: 'HTML Done Plan',
  overview: 'Shipped.',
  stage: 'done',
  approvedAt: '2026-07-01T00:00:00Z',
  todos: [{ id: 'phase-a', content: 'All done', status: 'done' }],
  reviewNotes: [],
})

const HTML_DRAFT_PLAN = htmlPlan({
  schemaVersion: 1,
  name: 'HTML Draft Plan',
  overview: 'Still being written.',
  stage: 'draft',
  approvedAt: null,
  todos: [{ id: 'phase-a', content: 'First', status: 'pending' }],
  reviewNotes: [],
})

const HTML_EMPTY_PLAN = htmlPlan({
  schemaVersion: 1,
  name: 'HTML Empty Plan',
  overview: 'No todos yet.',
  stage: 'draft',
  approvedAt: null,
  todos: [],
  reviewNotes: [],
})

const HTML_DOC = '<!doctype html><html><body>no meta here</body></html>'

const notify = {
  toast: vi.fn(),
  confirm: vi.fn(async () => true),
}

vi.mock('../../composables/useNotify', () => ({
  useNotify: () => notify,
}))

interface MockEntry {
  name: string
  rel_path: string
  is_dir: boolean
}

function makeBackend(opts?: {
  htmlEntries?: MockEntry[]
  htmlFiles?: Record<string, string>
  htmlListError?: string
  readFailures?: string[]
  dirEntries?: Record<string, MockEntry[]>
  customFiles?: Record<string, string>
  /** Per-rel-path mtimes echoed by fs.read_file (for the last-updated sort). */
  mtimes?: Record<string, number>
}) {
  // Tracks concurrent .agent-team reads so tests can assert parallel fan-out.
  const htmlReads = { inflight: 0, max: 0 }
  // Same, for legacy markdown reads under .cursor/plans.
  const mdReads = { inflight: 0, max: 0 }
  const renames: { src: string; dst: string }[] = []
  const writes: { rel: string; content: string }[] = []
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  return {
    status: ref('connected'),
    htmlReads,
    mdReads,
    renames,
    writes,
    on: (type: string, cb: (p: unknown) => void) => {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(cb)
      return () => set!.delete(cb)
    },
    /** Simulate a backend broadcast to `on()` subscribers. */
    emit: (type: string, payload: unknown) => listeners.get(type)?.forEach((cb) => cb(payload)),
    send: vi.fn(async (channel: string, payload: Record<string, unknown>) => {
      if (channel === 'fs.list_dir') {
        const rel = payload.rel_path as string
        if (opts?.dirEntries && opts.dirEntries[rel]) {
          return { payload: { ok: true, entries: opts.dirEntries[rel] } }
        }
        if (rel === '.cursor/plans') {
          return {
            payload: {
              ok: true,
              entries: [
                { name: 'active.plan.md', rel_path: '.cursor/plans/active.plan.md', is_dir: false },
                { name: 'done.plan.md', rel_path: '.cursor/plans/done.plan.md', is_dir: false },
              ],
            },
          }
        }
        if (rel === '.agent-team/plans') {
          if (opts?.htmlListError) return { payload: { ok: false, error: opts.htmlListError } }
          if (!opts?.htmlEntries) return { payload: { ok: false, error: 'not a directory' } }
          return { payload: { ok: true, entries: opts.htmlEntries } }
        }
        return { payload: { ok: false, error: 'not a directory' } }
      }
      if (channel === 'fs.read_file') {
        const rel = payload.rel_path as string
        if (opts?.customFiles && rel in opts.customFiles) {
          return { payload: { ok: true, content: opts.customFiles[rel], mtime: opts?.mtimes?.[rel] ?? 100 } }
        }
        if (rel.startsWith('.agent-team/')) {
          htmlReads.inflight++
          htmlReads.max = Math.max(htmlReads.max, htmlReads.inflight)
          await Promise.resolve()
          htmlReads.inflight--
          if (opts?.readFailures?.includes(rel)) return { payload: { ok: false, error: 'read failed' } }
        }
        if (rel.startsWith('.cursor/')) {
          mdReads.inflight++
          mdReads.max = Math.max(mdReads.max, mdReads.inflight)
          await Promise.resolve()
          mdReads.inflight--
        }
        const mtime = opts?.mtimes?.[rel]
        const mtimeField = mtime !== undefined ? { mtime } : {}
        if (opts?.htmlFiles && rel in opts.htmlFiles) {
          return { payload: { ok: true, content: opts.htmlFiles[rel], ...mtimeField } }
        }
        return {
          payload: {
            ok: true,
            content: rel === '.cursor/plans/done.plan.md' ? DONE_PLAN : ACTIVE_PLAN,
            ...mtimeField,
          },
        }
      }
      if (channel === 'fs.delete') return { payload: { ok: true } }
      if (channel === 'fs.rename') {
        renames.push({ src: payload.src_path as string, dst: payload.dst_path as string })
        return { payload: { ok: true } }
      }
      if (channel === 'fs.write_file') {
        writes.push({ rel: payload.rel_path as string, content: payload.content as string })
        return { payload: { ok: true } }
      }
      return { payload: { ok: false, error: 'unexpected' } }
    }),
  }
}

// The pane defaults to the flat, last-updated-first list. Specs below that
// assert on the stage-grouped layout opt into it explicitly; the flat default
// has its own describe block at the end of this file.
function mountPane(backend: ReturnType<typeof makeBackend>) {
  localStorage.setItem('navide.plans.group./ws', 'stage')
  return mount(PlansPane, {
    props: { workspacePath: '/ws', backend: backend as never },
    global: { plugins: [i18n] },
  })
}

describe('PlansPane', () => {
  it('lists active and completed plans', async () => {
    const wrapper = mountPane(makeBackend())
    await flushPromises()
    expect(wrapper.text()).toContain('Active Plan')
    expect(wrapper.text()).toContain('Done Plan')
    expect(wrapper.text()).toContain('1/1 done')
  })

  it('emits open-file when a plan is clicked', async () => {
    const wrapper = mountPane(makeBackend())
    await flushPromises()
    await wrapper.find('.plan-row').trigger('click')
    expect(wrapper.emitted('open-file')?.[0]).toEqual([
      { filepath: '.cursor/plans/active.plan.md', name: 'active.plan.md' },
    ])
  })

  it('deletes completed plans', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await wrapper.findAll('.plans-link-btn').find((b) => b.text() === 'Delete all')!.trigger('click')
    await flushPromises()
    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.cursor/plans/done.plan.md',
    })
  })

  it('lists HTML plans grouped by stage alongside unaffected legacy plans', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
          { name: 'shipped_d4e5f6.html', rel_path: '.agent-team/plans/shipped_d4e5f6.html', is_dir: false },
        ],
        htmlFiles: {
          '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN,
          '.agent-team/plans/shipped_d4e5f6.html': HTML_DONE_PLAN,
        },
      })
    )
    await flushPromises()

    // Legacy markdown plans unaffected.
    expect(wrapper.text()).toContain('Active Plan')
    expect(wrapper.text()).toContain('Done Plan')

    // HTML plans appear under their stage groups with progress and stage chip.
    const sectionTexts = wrapper.findAll('.plans-section').map((s) => s.text())
    const reviewSection = sectionTexts.find((t) => t.includes('In Review'))
    expect(reviewSection).toBeDefined()
    expect(reviewSection).toContain('HTML Review Plan')
    expect(reviewSection).toContain('1/2 done')
    expect(reviewSection).toContain('in-review')

    const doneSection = sectionTexts.find((t) => t.includes('HTML Done Plan'))
    expect(doneSection).toBeDefined()
    expect(doneSection).toContain('Done')
    expect(doneSection).toContain('1/1 done')
  })

  it('renders a stage-colored progressbar on rows with todos and none for zero-todo plans', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
          { name: 'empty_9z8y7x.html', rel_path: '.agent-team/plans/empty_9z8y7x.html', is_dir: false },
        ],
        htmlFiles: {
          '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN,
          '.agent-team/plans/empty_9z8y7x.html': HTML_EMPTY_PLAN,
        },
      })
    )
    await flushPromises()

    const rows = wrapper.findAll('.plan-row')
    const reviewRow = rows.find((r) => r.text().includes('HTML Review Plan'))!
    const bar = reviewRow.find('[role="progressbar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('aria-valuenow')).toBe('1')
    expect(bar.attributes('aria-valuemin')).toBe('0')
    expect(bar.attributes('aria-valuemax')).toBe('2')
    expect(bar.classes()).toContain('plan-progress-bar--in-review')
    // The done/total text label stays alongside the bar.
    expect(reviewRow.text()).toContain('1/2 done')

    // Zero-todo plan keeps its text but renders no fake 0% bar.
    const emptyRow = rows.find((r) => r.text().includes('HTML Empty Plan'))!
    expect(emptyRow.find('[role="progressbar"]').exists()).toBe(false)
  })

  it('colors the row stage chip with a per-stage class', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
          { name: 'shipped_d4e5f6.html', rel_path: '.agent-team/plans/shipped_d4e5f6.html', is_dir: false },
        ],
        htmlFiles: {
          '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN,
          '.agent-team/plans/shipped_d4e5f6.html': HTML_DONE_PLAN,
        },
      })
    )
    await flushPromises()

    const rows = wrapper.findAll('.plan-row')
    const reviewRow = rows.find((r) => r.text().includes('HTML Review Plan'))!
    expect(reviewRow.find('.plan-chip--stage-in-review').exists()).toBe(true)
    const doneRow = rows.find((r) => r.text().includes('HTML Done Plan'))!
    expect(doneRow.find('.plan-chip--stage-done').exists()).toBe(true)
  })

  it('falls back to the draft chip for an unknown legacy stage value', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'legacy_0a0a0a.html', rel_path: '.agent-team/plans/legacy_0a0a0a.html', is_dir: false },
        ],
        htmlFiles: {
          '.agent-team/plans/legacy_0a0a0a.html': htmlPlan({
            schemaVersion: 1,
            name: 'Legacy Stage Plan',
            overview: 'Written by an older tool.',
            stage: 'someday',
            approvedAt: null,
            todos: [{ id: 'phase-a', content: 'First', status: 'pending' }],
            reviewNotes: [],
          }),
        },
      })
    )
    await flushPromises()

    // The parser downgrades unknown stages to draft, so the chip renders the
    // known draft class — never an unstyled bogus stage class.
    const row = wrapper.findAll('.plan-row').find((r) => r.text().includes('Legacy Stage Plan'))!
    const chip = row.find('.plan-chip')
    expect(chip.classes()).toContain('plan-chip--stage-draft')
  })

  it('excludes underscore-prefixed infrastructure files', async () => {
    const backend = makeBackend({
      htmlEntries: [
        { name: '_template.html', rel_path: '.agent-team/plans/_template.html', is_dir: false },
        { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
      ],
      htmlFiles: { '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    expect(wrapper.text()).toContain('HTML Review Plan')
    expect(backend.send).not.toHaveBeenCalledWith('fs.read_file', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/_template.html',
    })
  })

  it('excludes dot-prefixed files from the plan listing', async () => {
    const backend = makeBackend({
      htmlEntries: [
        { name: '.hidden_a1b2c3.html', rel_path: '.agent-team/plans/.hidden_a1b2c3.html', is_dir: false },
        { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
      ],
      htmlFiles: { '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    expect(wrapper.text()).toContain('HTML Review Plan')
    expect(backend.send).not.toHaveBeenCalledWith('fs.read_file', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/.hidden_a1b2c3.html',
    })
  })

  it('lists an HTML file without valid meta as a doc under Active', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'notes_aaaaaa.html', rel_path: '.agent-team/plans/notes_aaaaaa.html', is_dir: false },
        ],
        htmlFiles: { '.agent-team/plans/notes_aaaaaa.html': HTML_DOC },
      })
    )
    await flushPromises()

    const activeSection = wrapper.findAll('.plans-section').map((s) => s.text()).find((t) => t.includes('Active'))
    expect(activeSection).toContain('notes_aaaaaa.html')
    expect(activeSection).toContain('doc')
  })

  it('opens HTML plans through the open-file emit', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
        ],
        htmlFiles: { '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN },
      })
    )
    await flushPromises()

    const rows = wrapper.findAll('.plan-row')
    const htmlRow = rows.find((r) => r.text().includes('HTML Review Plan'))!
    await htmlRow.trigger('click')
    const emitted = wrapper.emitted('open-file')!
    expect(emitted[emitted.length - 1]).toEqual([
      { filepath: '.agent-team/plans/review_a1b2c3.html', name: 'review_a1b2c3.html' },
    ])
  })

  it('shows each plan file path in the row (with a full-path title for the ellipsis)', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
        ],
        htmlFiles: { '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN },
      })
    )
    await flushPromises()

    const path = wrapper
      .findAll('.plan-row-path')
      .find((p) => p.text() === '.agent-team/plans/review_a1b2c3.html')
    expect(path).toBeTruthy()
    expect(path!.attributes('title')).toBe('.agent-team/plans/review_a1b2c3.html')
  })

  it('collapses and expands a section when its header is clicked', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
        ],
        htmlFiles: { '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN },
      })
    )
    await flushPromises()

    const rowVisible = (): boolean =>
      wrapper.findAll('.plan-row').some((r) => r.text().includes('HTML Review Plan'))
    const inReviewHead = wrapper.findAll('.plans-section-head').find((h) => h.text().includes('In Review'))!
    expect(inReviewHead).toBeTruthy()
    expect(rowVisible()).toBe(true)

    await inReviewHead.trigger('click')
    expect(rowVisible()).toBe(false)

    await inReviewHead.trigger('click')
    expect(rowVisible()).toBe(true)
  })

  it('surfaces a real .agent-team/plans list error', async () => {
    const wrapper = mountPane(makeBackend({ htmlListError: 'permission denied' }))
    await flushPromises()
    expect(wrapper.find('.plans-error').exists()).toBe(true)
    expect(wrapper.find('.plans-error').text()).toContain('permission denied')
  })

  it('stays silent when .agent-team/plans does not exist', async () => {
    const wrapper = mountPane(makeBackend())
    await flushPromises()
    expect(wrapper.find('.plans-error').exists()).toBe(false)
    expect(wrapper.text()).toContain('Active Plan')
  })

  it('reads HTML plans in parallel and lists them all', async () => {
    const backend = makeBackend({
      htmlEntries: [
        { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
        { name: 'shipped_d4e5f6.html', rel_path: '.agent-team/plans/shipped_d4e5f6.html', is_dir: false },
      ],
      htmlFiles: {
        '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN,
        '.agent-team/plans/shipped_d4e5f6.html': HTML_DONE_PLAN,
      },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    expect(backend.htmlReads.max).toBe(2)
    expect(wrapper.text()).toContain('HTML Review Plan')
    expect(wrapper.text()).toContain('HTML Done Plan')
  })

  it('reads legacy markdown plans in parallel', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    // Both .cursor/plans reads overlap (Promise.all fan-out, not a serial loop).
    expect(backend.mdReads.max).toBe(2)
    expect(wrapper.text()).toContain('Active Plan')
    expect(wrapper.text()).toContain('Done Plan')
  })

  it('keeps other HTML plans when one read fails', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
          { name: 'shipped_d4e5f6.html', rel_path: '.agent-team/plans/shipped_d4e5f6.html', is_dir: false },
        ],
        htmlFiles: { '.agent-team/plans/shipped_d4e5f6.html': HTML_DONE_PLAN },
        readFailures: ['.agent-team/plans/review_a1b2c3.html'],
      })
    )
    await flushPromises()

    expect(wrapper.text()).not.toContain('HTML Review Plan')
    expect(wrapper.text()).toContain('HTML Done Plan')
  })

  it('groups draft plans under Draft, not In Review', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'draft_aaaaaa.html', rel_path: '.agent-team/plans/draft_aaaaaa.html', is_dir: false },
          { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
        ],
        htmlFiles: {
          '.agent-team/plans/draft_aaaaaa.html': HTML_DRAFT_PLAN,
          '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN,
        },
      })
    )
    await flushPromises()

    const sectionTexts = wrapper.findAll('.plans-section').map((s) => s.text())
    const draftSection = sectionTexts.find((t) => t.includes('HTML Draft Plan'))
    expect(draftSection).toBeDefined()
    expect(draftSection).toContain('Draft')
    expect(draftSection).not.toContain('In Review')
    const reviewSection = sectionTexts.find((t) => t.includes('In Review'))
    expect(reviewSection).toBeDefined()
    expect(reviewSection).toContain('HTML Review Plan')
    expect(reviewSection).not.toContain('HTML Draft Plan')
  })

  it('batch delete covers markdown completed plus HTML done/abandoned', async () => {
    const backend = makeBackend({
      htmlEntries: [
        { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
        { name: 'shipped_d4e5f6.html', rel_path: '.agent-team/plans/shipped_d4e5f6.html', is_dir: false },
      ],
      htmlFiles: {
        '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN,
        '.agent-team/plans/shipped_d4e5f6.html': HTML_DONE_PLAN,
      },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    await wrapper.findAll('.plans-link-btn').find((b) => b.text() === 'Delete all')!.trigger('click')
    await flushPromises()

    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.cursor/plans/done.plan.md',
    })
    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/shipped_d4e5f6.html',
    })
    expect(backend.send).not.toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/review_a1b2c3.html',
    })
  })
})

describe('PlansPane – plans.changed live refresh', () => {
  it('reloads the plan list on a matching-workspace broadcast', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    const callsBefore = backend.send.mock.calls.filter(([type]) => type === 'fs.list_dir').length

    backend.emit('plans.changed', { workspace_path: '/ws' })
    await flushPromises()

    const callsAfter = backend.send.mock.calls.filter(([type]) => type === 'fs.list_dir').length
    expect(callsAfter).toBeGreaterThan(callsBefore)
    expect(wrapper.text()).toContain('Active Plan')
  })

  it('keeps the existing list and shows no loading overlay on a background refresh', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(wrapper.text()).toContain('Active Plan')

    // A refresh while a list already exists must not flash the loading overlay
    // or blank the rows (which would reset the sidebar scroll position).
    backend.emit('plans.changed', { workspace_path: '/ws' })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.plans-muted').exists()).toBe(false)
    expect(wrapper.text()).toContain('Active Plan')

    await flushPromises()
    expect(wrapper.text()).toContain('Active Plan')
  })

  it('shows the loading overlay only on the first load', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    // Before the first load resolves, the loading overlay is visible.
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.plans-muted').text()).toContain('Loading plans')
    await flushPromises()
    expect(wrapper.find('.plans-muted').exists()).toBe(false)
  })

  it('ignores broadcasts for other workspaces and malformed payloads', async () => {
    const backend = makeBackend()
    mountPane(backend)
    await flushPromises()
    const callsBefore = backend.send.mock.calls.length

    backend.emit('plans.changed', { workspace_path: '/other-ws' })
    backend.emit('plans.changed', null)
    backend.emit('plans.changed', 'nope')
    await flushPromises()

    expect(backend.send.mock.calls.length).toBe(callsBefore)
  })

  it('stops listening after unmount', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    wrapper.unmount()
    const callsBefore = backend.send.mock.calls.length

    backend.emit('plans.changed', { workspace_path: '/ws' })
    await flushPromises()

    expect(backend.send.mock.calls.length).toBe(callsBefore)
  })
})

// ── Context menu ───────────────────────────────────────────────────────────

function reviewBackend() {
  return makeBackend({
    htmlEntries: [
      { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
    ],
    htmlFiles: { '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN },
  })
}

function docBackend() {
  return makeBackend({
    htmlEntries: [
      { name: 'notes_aaaaaa.html', rel_path: '.agent-team/plans/notes_aaaaaa.html', is_dir: false },
    ],
    htmlFiles: { '.agent-team/plans/notes_aaaaaa.html': HTML_DOC },
  })
}

async function openMenuOn(wrapper: ReturnType<typeof mountPane>, rowText: string) {
  const row = wrapper.findAll('.plan-row').find((r) => r.text().includes(rowText))!
  await row.trigger('contextmenu')
  await flushPromises()
}

function menuItem(wrapper: ReturnType<typeof mountPane>, label: string) {
  return wrapper.findAll('.menu-item').find((i) => i.text() === label)!
}

describe('PlansPane – context menu', () => {
  it('opens on right-click for HTML plans with plan actions, no promote', async () => {
    const wrapper = mountPane(reviewBackend())
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')

    const labels = wrapper.findAll('.menu-item').map((i) => i.text())
    expect(labels).toEqual(['Open', 'Copy path', 'Share to Git', 'Rename', 'Archive', 'Delete'])
  })

  it('adds Promote to Plan for HTML docs without meta', async () => {
    const wrapper = mountPane(docBackend())
    await flushPromises()
    await openMenuOn(wrapper, 'notes_aaaaaa.html')

    const labels = wrapper.findAll('.menu-item').map((i) => i.text())
    expect(labels).toContain('Promote to Plan')
  })

  it('opens for markdown plans with only the format-agnostic actions', async () => {
    // A markdown plan (with meta) is no longer frozen: it gets Open/Archive/
    // Delete but none of the HTML-only Rename/Share/Promote items.
    const wrapper = mountPane(makeBackend())
    await flushPromises()
    await openMenuOn(wrapper, 'Active Plan')

    expect(wrapper.find('.ctx-menu').exists()).toBe(true)
    const labels = wrapper.findAll('.menu-item').map((i) => i.text())
    expect(labels).toEqual(['Open', 'Copy path', 'Archive', 'Delete'])
    expect(labels).not.toContain('Rename')
    expect(labels).not.toContain('Share to Git')
    expect(labels).not.toContain('Promote to Plan')
  })

  it('Open fires the open-file emit', async () => {
    const wrapper = mountPane(reviewBackend())
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')

    await menuItem(wrapper, 'Open').trigger('click')
    const emitted = wrapper.emitted('open-file')!
    expect(emitted[emitted.length - 1]).toEqual([
      { filepath: '.agent-team/plans/review_a1b2c3.html', name: 'review_a1b2c3.html' },
    ])
    expect(wrapper.find('.ctx-menu').exists()).toBe(false)
  })

  it('Share to Git copies the plan verbatim into .plans/', async () => {
    const backend = reviewBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')

    await menuItem(wrapper, 'Share to Git').trigger('click')
    await flushPromises()

    expect(backend.writes).toEqual([{ rel: '.plans/review_a1b2c3.html', content: HTML_REVIEW_PLAN }])
  })
})

describe('PlansPane – rename', () => {
  it('rejects a name that breaks the <slug>_<hex>.html format', async () => {
    notify.toast.mockClear()
    const backend = reviewBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')
    await menuItem(wrapper, 'Rename').trigger('click')

    await wrapper.find('.rename-input').setValue('Bad Name.html')
    await wrapper.find('.rename-btn--primary').trigger('click')
    await flushPromises()

    expect(backend.renames).toEqual([])
    expect(notify.toast).toHaveBeenCalledWith('Invalid name — must be kebab-slug_6hex.html', {
      type: 'error',
    })
    // Dialog stays open for correction.
    expect(wrapper.find('.rename-dialog').exists()).toBe(true)
  })

  it('renames within the plans directory when the format is valid', async () => {
    const backend = reviewBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')
    await menuItem(wrapper, 'Rename').trigger('click')

    await wrapper.find('.rename-input').setValue('renamed-plan_abc123.html')
    await wrapper.find('.rename-btn--primary').trigger('click')
    await flushPromises()

    expect(backend.renames).toEqual([
      { src: '.agent-team/plans/review_a1b2c3.html', dst: '.agent-team/plans/renamed-plan_abc123.html' },
    ])
    expect(wrapper.find('.rename-dialog').exists()).toBe(false)
  })
})

describe('PlansPane – delete single', () => {
  it('deletes an in-review plan only after a second confirmation', async () => {
    notify.confirm.mockClear()
    const backend = reviewBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')

    await menuItem(wrapper, 'Delete').trigger('click')
    await flushPromises()

    expect(notify.confirm).toHaveBeenCalledTimes(2)
    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/review_a1b2c3.html',
    })
  })

  it('aborts when the second confirmation is declined', async () => {
    notify.confirm.mockClear()
    notify.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const backend = reviewBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')

    await menuItem(wrapper, 'Delete').trigger('click')
    await flushPromises()

    expect(notify.confirm).toHaveBeenCalledTimes(2)
    expect(backend.send).not.toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/review_a1b2c3.html',
    })
  })

  it('deletes a done plan after a single confirmation', async () => {
    notify.confirm.mockClear()
    const backend = makeBackend({
      htmlEntries: [
        { name: 'shipped_d4e5f6.html', rel_path: '.agent-team/plans/shipped_d4e5f6.html', is_dir: false },
      ],
      htmlFiles: { '.agent-team/plans/shipped_d4e5f6.html': HTML_DONE_PLAN },
    })
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Done Plan')

    await menuItem(wrapper, 'Delete').trigger('click')
    await flushPromises()

    expect(notify.confirm).toHaveBeenCalledTimes(1)
    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/shipped_d4e5f6.html',
    })
  })
})

describe('PlansPane – visible row delete button', () => {
  it('deletes a legacy plan from its always-visible button and notifies the host', async () => {
    notify.confirm.mockClear()
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    const delBtn = wrapper.find('.plan-row-delete')
    expect(delBtn.exists()).toBe(true)
    await delBtn.trigger('click')
    await flushPromises()

    expect(notify.confirm).toHaveBeenCalledTimes(1)
    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.cursor/plans/active.plan.md',
    })
    // Delete must not also open the plan (click.stop on the row button).
    expect(wrapper.emitted('open-file')).toBeUndefined()
    // Host is told which file was removed so it can clear the right pane.
    expect(wrapper.emitted('deleted')?.[0]).toEqual(['.cursor/plans/active.plan.md'])
  })

  it('does not delete when the confirmation is declined', async () => {
    notify.confirm.mockClear()
    notify.confirm.mockResolvedValueOnce(false)
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    await wrapper.find('.plan-row-delete').trigger('click')
    await flushPromises()

    expect(backend.send).not.toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.cursor/plans/active.plan.md',
    })
    expect(wrapper.emitted('deleted')).toBeUndefined()
  })

  it('requires a second confirmation for an in-review plan via the row button', async () => {
    notify.confirm.mockClear()
    const backend = reviewBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    const row = wrapper.findAll('.plan-row').find((r) => r.text().includes('HTML Review Plan'))!
    await row.find('.plan-row-delete').trigger('click')
    await flushPromises()

    expect(notify.confirm).toHaveBeenCalledTimes(2)
    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/review_a1b2c3.html',
    })
  })
})

describe('PlansPane – promote doc to plan', () => {
  it('injects a minimal draft meta the parser accepts, named after the file', async () => {
    const backend = docBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'notes_aaaaaa.html')

    await menuItem(wrapper, 'Promote to Plan').trigger('click')
    await flushPromises()

    expect(backend.writes).toHaveLength(1)
    expect(backend.writes[0].rel).toBe('.agent-team/plans/notes_aaaaaa.html')
    const parsed = parseHtmlPlanMeta(backend.writes[0].content)
    expect(parsed).not.toBeNull()
    expect(parsed!.warnings).toEqual([])
    expect(parsed!.meta).toMatchObject({
      schemaVersion: 1,
      name: 'notes_aaaaaa.html', // HTML_DOC has no <title>
      stage: 'draft',
      approvedAt: null,
      todos: [],
      reviewNotes: [],
    })
    // Original doc content survives around the injected island.
    expect(backend.writes[0].content).toContain('no meta here')
  })

  it('uses the <title> as the plan name when present', async () => {
    const titledDoc = '<!doctype html><html><head><title>Titled Doc</title></head><body>x</body></html>'
    const backend = makeBackend({
      htmlEntries: [
        { name: 'titled_bbbbbb.html', rel_path: '.agent-team/plans/titled_bbbbbb.html', is_dir: false },
      ],
      htmlFiles: { '.agent-team/plans/titled_bbbbbb.html': titledDoc },
    })
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'titled_bbbbbb.html')

    await menuItem(wrapper, 'Promote to Plan').trigger('click')
    await flushPromises()

    expect(parseHtmlPlanMeta(backend.writes[0].content)!.meta.name).toBe('Titled Doc')
  })
})

// ── Unified markdown list (stage grouping + doc + promote) ───────────────────

describe('PlansPane – markdown plans use unified meta', () => {
  it('groups a markdown plan by its stage with a stage badge, not the legacy split', async () => {
    // active.plan.md serves an explicit-stage markdown plan; done.plan.md stays done.
    const backend = makeBackend({
      htmlFiles: { '.cursor/plans/active.plan.md': MD_REVIEW_PLAN },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    const sectionTexts = wrapper.findAll('.plans-section').map((s) => s.text())
    const reviewSection = sectionTexts.find((t) => t.includes('In Review'))
    expect(reviewSection).toBeDefined()
    expect(reviewSection).toContain('MD Review Plan')
    expect(reviewSection).toContain('1/2 done')
    expect(reviewSection).toContain('in-review')

    // Its stage-grouped row carries no legacy 'planned'/'markdown' doc badge.
    const activeSection = sectionTexts.find((t) => t.includes('Active'))
    expect(activeSection).not.toContain('MD Review Plan')
  })

  it('lists a frontmatter-less markdown file as a doc with no context menu freeze on plans', async () => {
    const backend = makeBackend({
      htmlFiles: { '.cursor/plans/active.plan.md': MD_DOC },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    const activeSection = wrapper.findAll('.plans-section').map((s) => s.text()).find((t) => t.includes('Active'))
    expect(activeSection).toContain('active.plan.md')
    expect(activeSection).toContain('doc')

    // A markdown doc opens the context menu (to allow Promote); a markdown plan does not.
    await openMenuOn(wrapper, 'active.plan.md')
    expect(wrapper.find('.ctx-menu').exists()).toBe(true)
    const labels = wrapper.findAll('.menu-item').map((i) => i.text())
    expect(labels).toContain('Promote to Plan')
    // HTML-only actions are hidden for markdown docs.
    expect(labels).not.toContain('Rename')
    expect(labels).not.toContain('Share to Git')
  })

  it('promotes a markdown doc by prepending parseable frontmatter, body preserved', async () => {
    const backend = makeBackend({
      htmlFiles: { '.cursor/plans/active.plan.md': MD_DOC },
    })
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'active.plan.md')

    await menuItem(wrapper, 'Promote to Plan').trigger('click')
    await flushPromises()

    expect(backend.writes).toHaveLength(1)
    expect(backend.writes[0].rel).toBe('.cursor/plans/active.plan.md')
    const written = backend.writes[0].content
    const meta = parsePlanMeta(written)
    expect(meta).not.toBeNull()
    expect(meta!).toMatchObject({
      name: 'Email Attachments',
      overview: 'Support attaching files to outgoing email.',
      stage: 'draft',
      todos: [],
      reviewNotes: [],
    })
    // Original body survives verbatim after the frontmatter.
    expect(written).toContain('# Email Attachments')
    expect(written).toContain('More detail here.')
  })
})

// ── Archive ──────────────────────────────────────────────────────────────────

const HTML_ARCHIVED_PLAN = htmlPlan({
  schemaVersion: 1,
  name: 'HTML Archived Plan',
  overview: 'Shipped and filed away.',
  stage: 'done',
  approvedAt: '2026-07-01T00:00:00Z',
  archivedAt: '2026-07-20T00:00:00Z',
  todos: [{ id: 'phase-a', content: 'All done', status: 'done' }],
  reviewNotes: [],
})

// Markdown plan already archived (lives in the collapsed Archived group).
const MD_ARCHIVED_PLAN = `---
name: MD Archived Plan
overview: Filed away.
stage: done
archivedAt: '2026-07-20T00:00:00Z'
todos:
  - id: phase-a
    content: Done work.
    status: done
isProject: false
---

# MD Archived Plan
`

describe('PlansPane – archive', () => {
  it('lists an archived plan in the collapsed Archived group, not its stage group', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'archived_a1b2c3.html', rel_path: '.agent-team/plans/archived_a1b2c3.html', is_dir: false },
        ],
        htmlFiles: { '.agent-team/plans/archived_a1b2c3.html': HTML_ARCHIVED_PLAN },
      })
    )
    await flushPromises()

    const heads = wrapper.findAll('.plans-section-head').map((h) => h.text())
    expect(heads.some((t) => t.includes('Archived'))).toBe(true)
    // The Done stage group is gone — the plan left it for the Archived group.
    expect(heads.some((t) => /\bDone\b/.test(t))).toBe(false)

    // Default collapsed: the row is hidden until the header is clicked.
    const rowVisible = (): boolean =>
      wrapper.findAll('.plan-row').some((r) => r.text().includes('HTML Archived Plan'))
    expect(rowVisible()).toBe(false)
    const archivedHead = wrapper.findAll('.plans-section-head').find((h) => h.text().includes('Archived'))!
    await archivedHead.trigger('click')
    expect(rowVisible()).toBe(true)
  })

  it('excludes an archived done plan from "Delete all"', async () => {
    const backend = makeBackend({
      htmlEntries: [
        { name: 'archived_a1b2c3.html', rel_path: '.agent-team/plans/archived_a1b2c3.html', is_dir: false },
      ],
      htmlFiles: { '.agent-team/plans/archived_a1b2c3.html': HTML_ARCHIVED_PLAN },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    // The legacy markdown done.plan.md keeps the button enabled; clicking it
    // must delete that one but never touch the archived HTML plan.
    await wrapper.findAll('.plans-link-btn').find((b) => b.text() === 'Delete all')!.trigger('click')
    await flushPromises()

    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.cursor/plans/done.plan.md',
    })
    expect(backend.send).not.toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/archived_a1b2c3.html',
    })
  })

  it('archive-all-done archives done plans through the optimistic-lock store, not fs.delete', async () => {
    notify.confirm.mockClear()
    const backend = makeBackend({
      htmlEntries: [
        { name: 'shipped_d4e5f6.html', rel_path: '.agent-team/plans/shipped_d4e5f6.html', is_dir: false },
      ],
      htmlFiles: { '.agent-team/plans/shipped_d4e5f6.html': HTML_DONE_PLAN },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    const archiveBtn = wrapper.findAll('.plans-link-btn').find((b) => b.text().includes('Archive all done'))!
    expect(archiveBtn.attributes('disabled')).toBeUndefined()
    await archiveBtn.trigger('click')
    await flushPromises()

    // Both done plans (legacy markdown + HTML) are archived through writeMeta.
    const htmlWrite = backend.writes.find((w) => w.rel === '.agent-team/plans/shipped_d4e5f6.html')!
    expect(htmlWrite).toBeDefined()
    const parsed = parseHtmlPlanMeta(htmlWrite.content)!
    expect(typeof parsed.meta.archivedAt).toBe('string')
    expect(parsed.meta.stage).toBe('done') // stage preserved, not deleted
    const mdWrite = backend.writes.find((w) => w.rel === '.cursor/plans/done.plan.md')!
    expect(mdWrite).toBeDefined()
    expect(parsePlanMeta(mdWrite.content)!.archivedAt).toBeTruthy()
    // Archiving must never delete.
    expect(backend.send).not.toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/shipped_d4e5f6.html',
    })
  })

  it('context menu archives an HTML plan (sets archivedAt)', async () => {
    notify.confirm.mockClear()
    const backend = reviewBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')

    expect(wrapper.findAll('.menu-item').map((i) => i.text())).toContain('Archive')
    await menuItem(wrapper, 'Archive').trigger('click')
    await flushPromises()

    expect(backend.writes).toHaveLength(1)
    expect(parseHtmlPlanMeta(backend.writes[0].content)!.meta.archivedAt).toBeTruthy()
  })

  it('context menu offers Unarchive for an archived plan and clears archivedAt', async () => {
    const backend = makeBackend({
      htmlEntries: [
        { name: 'archived_a1b2c3.html', rel_path: '.agent-team/plans/archived_a1b2c3.html', is_dir: false },
      ],
      htmlFiles: { '.agent-team/plans/archived_a1b2c3.html': HTML_ARCHIVED_PLAN },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    // Reveal the archived row (group is collapsed by default).
    await wrapper.findAll('.plans-section-head').find((h) => h.text().includes('Archived'))!.trigger('click')
    await openMenuOn(wrapper, 'HTML Archived Plan')

    const labels = wrapper.findAll('.menu-item').map((i) => i.text())
    expect(labels).toContain('Unarchive')
    expect(labels).not.toContain('Archive')
    await menuItem(wrapper, 'Unarchive').trigger('click')
    await flushPromises()

    expect(backend.writes).toHaveLength(1)
    expect(parseHtmlPlanMeta(backend.writes[0].content)!.meta.archivedAt).toBeNull()
  })

  it('context menu archives a markdown plan through writeMeta (sets archivedAt)', async () => {
    notify.confirm.mockClear()
    // active.plan.md serves an explicit-stage markdown plan with meta.
    const backend = makeBackend({ htmlFiles: { '.cursor/plans/active.plan.md': MD_REVIEW_PLAN } })
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'MD Review Plan')

    expect(wrapper.findAll('.menu-item').map((i) => i.text())).toContain('Archive')
    await menuItem(wrapper, 'Archive').trigger('click')
    await flushPromises()

    const write = backend.writes.find((w) => w.rel === '.cursor/plans/active.plan.md')!
    expect(write).toBeDefined()
    expect(parsePlanMeta(write.content)!.archivedAt).toBeTruthy()
    // Archiving goes through writeMeta, never fs.delete.
    expect(backend.send).not.toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.cursor/plans/active.plan.md',
    })
  })

  it('context menu unarchives a markdown plan and clears archivedAt', async () => {
    const backend = makeBackend({ htmlFiles: { '.cursor/plans/active.plan.md': MD_ARCHIVED_PLAN } })
    const wrapper = mountPane(backend)
    await flushPromises()

    // Reveal the archived row (Archived group is collapsed by default).
    await wrapper.findAll('.plans-section-head').find((h) => h.text().includes('Archived'))!.trigger('click')
    await openMenuOn(wrapper, 'MD Archived Plan')

    const labels = wrapper.findAll('.menu-item').map((i) => i.text())
    expect(labels).toContain('Unarchive')
    expect(labels).not.toContain('Archive')
    expect(labels).not.toContain('Rename')
    await menuItem(wrapper, 'Unarchive').trigger('click')
    await flushPromises()

    const write = backend.writes.find((w) => w.rel === '.cursor/plans/active.plan.md')!
    expect(write).toBeDefined()
    expect(parsePlanMeta(write.content)!.archivedAt).toBeNull()
  })
})

// ── Collapse persistence (localStorage per workspace) ────────────────────────

describe('PlansPane – collapse persistence', () => {
  const KEY = 'navide.plans.collapsed./ws'

  function mountAt(workspacePath: string, backend: ReturnType<typeof makeBackend>) {
    localStorage.setItem(`navide.plans.group.${workspacePath}`, 'stage')
    return mount(PlansPane, {
      props: { workspacePath, backend: backend as never },
      global: { plugins: [i18n] },
    })
  }

  it('persists a manually collapsed section to localStorage', async () => {
    const wrapper = mountPane(reviewBackend())
    await flushPromises()
    const head = wrapper.findAll('.plans-section-head').find((h) => h.text().includes('In Review'))!
    await head.trigger('click')

    const raw = localStorage.getItem(KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toContain('in-review')
  })

  it('restores the collapsed state from localStorage on (re)mount', async () => {
    localStorage.setItem(KEY, JSON.stringify(['in-review']))
    const wrapper = mountPane(reviewBackend())
    await flushPromises()

    // Stored collapse hides the In Review row without any user interaction.
    const rowVisible = wrapper.findAll('.plan-row').some((r) => r.text().includes('HTML Review Plan'))
    expect(rowVisible).toBe(false)
  })

  it('keeps collapse state independent per workspace path', async () => {
    localStorage.setItem(KEY, JSON.stringify(['in-review']))
    const wrapper = mountAt('/other-ws', reviewBackend())
    await flushPromises()

    // /other-ws has no stored state → default (In Review expanded), row visible.
    const rowVisible = wrapper.findAll('.plan-row').some((r) => r.text().includes('HTML Review Plan'))
    expect(rowVisible).toBe(true)
  })

  it('falls back to the default collapsed set when storage holds bad JSON', async () => {
    localStorage.setItem(KEY, '{not valid json')
    const backend = makeBackend({
      htmlEntries: [
        { name: 'archived_a1b2c3.html', rel_path: '.agent-team/plans/archived_a1b2c3.html', is_dir: false },
      ],
      htmlFiles: { '.agent-team/plans/archived_a1b2c3.html': HTML_ARCHIVED_PLAN },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    // No throw; default applies → Archived group folded, row hidden.
    const rowVisible = wrapper.findAll('.plan-row').some((r) => r.text().includes('HTML Archived Plan'))
    expect(rowVisible).toBe(false)
  })
})

// ── Copy path ────────────────────────────────────────────────────────────────

describe('PlansPane – copy path', () => {
  it('copies the item relPath to the clipboard with a success toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    notify.toast.mockClear()
    const wrapper = mountPane(reviewBackend())
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')

    await menuItem(wrapper, 'Copy path').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith('.agent-team/plans/review_a1b2c3.html')
    expect(notify.toast).toHaveBeenCalledWith('Path copied', { type: 'success' })
    // Copy closes the menu.
    expect(wrapper.find('.ctx-menu').exists()).toBe(false)
  })

  it('offers Copy path for meta-less docs too', async () => {
    const wrapper = mountPane(docBackend())
    await flushPromises()
    await openMenuOn(wrapper, 'notes_aaaaaa.html')
    expect(wrapper.findAll('.menu-item').map((i) => i.text())).toContain('Copy path')
  })
})

// ── Rename autofocus ─────────────────────────────────────────────────────────

describe('PlansPane – rename autofocus', () => {
  it('focuses and selects the rename input when the dialog opens', async () => {
    const wrapper = mount(PlansPane, {
      props: { workspacePath: '/ws', backend: reviewBackend() as never },
      global: { plugins: [i18n] },
      attachTo: document.body,
    })
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')
    await menuItem(wrapper, 'Rename').trigger('click')
    await flushPromises()

    const input = wrapper.find('.rename-input').element as HTMLInputElement
    expect(document.activeElement).toBe(input)
    wrapper.unmount()
  })
})

// ── Empty state + completed action row ───────────────────────────────────────

function emptyBackend() {
  return {
    status: ref('connected'),
    on: () => () => {},
    send: vi.fn(async (channel: string, payload: Record<string, unknown>) => {
      if (channel === 'fs.list_dir') {
        if (payload.rel_path === '.cursor/plans') return { payload: { ok: true, entries: [] } }
        return { payload: { ok: false, error: 'not a directory' } }
      }
      return { payload: { ok: false, error: 'unexpected' } }
    }),
  }
}

describe('PlansPane – empty state', () => {
  it('shows the empty-all guide and hides the completed action row with zero plans', async () => {
    const wrapper = mount(PlansPane, {
      props: { workspacePath: '/ws', backend: emptyBackend() as never },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(wrapper.find('.plans-empty').text()).toContain('No plans yet')
    // No actionable done/deletable plans → the whole action row is gone.
    expect(wrapper.findAll('.plans-link-btn').length).toBe(0)
  })
})

// ── Row accessibility (no button-in-button, keyboard-reachable) ──────────────

describe('PlansPane – row accessibility', () => {
  it('renders each row as a role=button DIV with a nested BUTTON delete (no button-in-button)', async () => {
    const wrapper = mountPane(reviewBackend())
    await flushPromises()

    const row = wrapper.find('.plan-row')
    expect(row.element.tagName).toBe('DIV')
    expect(row.attributes('role')).toBe('button')
    expect(row.attributes('tabindex')).toBe('0')

    const del = row.find('.plan-row-delete')
    expect(del.element.tagName).toBe('BUTTON')
    // No interactive element nested inside another button.
    expect(wrapper.findAll('button .plan-row-delete').length).toBe(0)
  })

  it('opens a plan on Enter and Space from the focusable row', async () => {
    const wrapper = mountPane(reviewBackend())
    await flushPromises()

    const row = wrapper.findAll('.plan-row').find((r) => r.text().includes('HTML Review Plan'))!
    await row.trigger('keydown.enter')
    await row.trigger('keydown.space')

    const emitted = wrapper.emitted('open-file')!
    expect(emitted.length).toBe(2)
    expect(emitted[0]).toEqual([
      { filepath: '.agent-team/plans/review_a1b2c3.html', name: 'review_a1b2c3.html' },
    ])
    expect(emitted[1]).toEqual(emitted[0])
  })

  it('deletes from the keyboard-reachable delete BUTTON without opening the plan', async () => {
    notify.confirm.mockClear()
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    const del = wrapper.find('.plan-row-delete')
    expect(del.element.tagName).toBe('BUTTON')
    await del.trigger('click')
    await flushPromises()

    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.cursor/plans/active.plan.md',
    })
    // click.stop keeps the row's open handler from firing.
    expect(wrapper.emitted('open-file')).toBeUndefined()
  })

  it('does not open the plan when Enter/Space is pressed on the delete button', async () => {
    notify.confirm.mockClear()
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    const del = wrapper.find('.plan-row-delete')
    expect(del.element.tagName).toBe('BUTTON')

    // A native <button> turns keyboard Enter/Space into a click; the keydown
    // itself must NOT bubble to the row's open handler (the a11y seam bug).
    // happy-dom does not synthesize that native click, so dispatch the keydown
    // (which the fix must stop at the button) plus the click the browser fires.
    await del.trigger('keydown.enter')
    await del.trigger('keydown.space')
    expect(wrapper.emitted('open-file')).toBeUndefined()

    await del.trigger('click')
    await flushPromises()
    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.cursor/plans/active.plan.md',
    })
    // Deleting via the keyboard never opens the plan.
    expect(wrapper.emitted('open-file')).toBeUndefined()
  })

  it('opens (and never deletes) when Enter is pressed on the row itself', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    const row = wrapper.find('.plan-row')
    await row.trigger('keydown.enter')

    expect(wrapper.emitted('open-file')?.length).toBe(1)
    expect(backend.send).not.toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.cursor/plans/active.plan.md',
    })
  })

  it('keeps the hover-revealed delete button focusable (hidden via opacity, not display)', async () => {
    // The ✕ is opacity-hidden until row hover/focus-within; it must stay in
    // the tab order, so it can never be display:none / visibility:hidden.
    const wrapper = mount(PlansPane, {
      props: { workspacePath: '/ws', backend: makeBackend() as never },
      global: { plugins: [i18n] },
      attachTo: document.body,
    })
    await flushPromises()

    const del = wrapper.find('.plan-row-delete')
    expect(del.exists()).toBe(true)
    expect(del.attributes('tabindex')).toBeUndefined()
    expect(del.attributes('disabled')).toBeUndefined()
    ;(del.element as HTMLButtonElement).focus()
    expect(document.activeElement).toBe(del.element)
    wrapper.unmount()
  })
})

// ── Context menu dismissal ───────────────────────────────────────────────────

describe('PlansPane – context menu dismissal', () => {
  it('closes the context menu on window scroll', async () => {
    const wrapper = mountPane(reviewBackend())
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')
    expect(wrapper.find('.ctx-menu').exists()).toBe(true)

    window.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(wrapper.find('.ctx-menu').exists()).toBe(false)
  })
})

// ── Within-group sorting by plan title ───────────────────────────────────────

describe('PlansPane – within-group sort by name', () => {
  const draftNamed = (name: string) =>
    htmlPlan({
      schemaVersion: 1,
      name,
      overview: '',
      stage: 'draft',
      approvedAt: null,
      todos: [],
      reviewNotes: [],
    })

  it('orders plans inside a stage group by meta.name, not filename', async () => {
    // Filename order (aaa < zzz) is the opposite of title order (Apple < Zebra),
    // so a filename sort would list Zebra first — the name sort must not.
    const backend = makeBackend({
      htmlEntries: [
        { name: 'aaa_111111.html', rel_path: '.agent-team/plans/aaa_111111.html', is_dir: false },
        { name: 'zzz_222222.html', rel_path: '.agent-team/plans/zzz_222222.html', is_dir: false },
      ],
      htmlFiles: {
        '.agent-team/plans/aaa_111111.html': draftNamed('Zebra Plan'),
        '.agent-team/plans/zzz_222222.html': draftNamed('Apple Plan'),
      },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    const names = wrapper.findAll('.plan-row-name').map((n) => n.text())
    expect(names.indexOf('Apple Plan')).toBeLessThan(names.indexOf('Zebra Plan'))
  })
})

// ── Search / stage filter / sort toolbar ─────────────────────────────────────

describe('PlansPane – search, stage filter, sort', () => {
  const namedPlan = (
    name: string,
    opts?: { stage?: string; overview?: string; todos?: { id: string; content: string; status: string }[] },
  ) =>
    htmlPlan({
      schemaVersion: 1,
      name,
      overview: opts?.overview ?? '',
      stage: opts?.stage ?? 'draft',
      approvedAt: null,
      todos: opts?.todos ?? [],
      reviewNotes: [],
    })

  function searchBackend() {
    return makeBackend({
      htmlEntries: [
        { name: 'alpha_111111.html', rel_path: '.agent-team/plans/alpha_111111.html', is_dir: false },
        { name: 'beta_222222.html', rel_path: '.agent-team/plans/beta_222222.html', is_dir: false },
      ],
      htmlFiles: {
        '.agent-team/plans/alpha_111111.html': namedPlan('Alpha Plan', {
          stage: 'draft',
          overview: 'terminal search work',
        }),
        '.agent-team/plans/beta_222222.html': namedPlan('Beta Plan', { stage: 'done', overview: 'shipping' }),
      },
    })
  }

  it('search filters rows across groups and clearing restores them', async () => {
    const wrapper = mountPane(searchBackend())
    await flushPromises()

    await wrapper.find('.plans-search-input').setValue('alpha')
    expect(wrapper.text()).toContain('Alpha Plan')
    expect(wrapper.text()).not.toContain('Beta Plan')
    expect(wrapper.text()).not.toContain('Active Plan')

    await wrapper.find('.plans-search-clear').trigger('click')
    expect(wrapper.text()).toContain('Alpha Plan')
    expect(wrapper.text()).toContain('Beta Plan')
    expect(wrapper.text()).toContain('Active Plan')
  })

  it('search matches overview text', async () => {
    const wrapper = mountPane(searchBackend())
    await flushPromises()

    await wrapper.find('.plans-search-input').setValue('terminal search work')
    expect(wrapper.text()).toContain('Alpha Plan')
    expect(wrapper.text()).not.toContain('Beta Plan')
  })

  it('shows a no-results state when nothing matches the search', async () => {
    const wrapper = mountPane(searchBackend())
    await flushPromises()

    await wrapper.find('.plans-search-input').setValue('zzz-no-such-plan')
    expect(wrapper.text()).toContain('No plans match the current search or filter.')
    expect(wrapper.findAll('.plan-row')).toHaveLength(0)
  })

  it('stage filter shows only the selected stage group and persists', async () => {
    const wrapper = mountPane(searchBackend())
    await flushPromises()

    await wrapper.find('.plans-stage-select').setValue('done')
    expect(wrapper.text()).toContain('Beta Plan')
    expect(wrapper.text()).not.toContain('Alpha Plan')
    expect(localStorage.getItem('navide.plans.filter./ws')).toBe('done')
  })

  it('restores the persisted stage filter on mount', async () => {
    localStorage.setItem('navide.plans.filter./ws', 'draft')
    const wrapper = mountPane(searchBackend())
    await flushPromises()

    expect((wrapper.find('.plans-stage-select').element as HTMLSelectElement).value).toBe('draft')
    expect(wrapper.text()).toContain('Alpha Plan')
    expect(wrapper.text()).not.toContain('Beta Plan')
  })

  it('sorts within a group by mtime when Last updated is selected', async () => {
    const backend = makeBackend({
      htmlEntries: [
        { name: 'aaa_111111.html', rel_path: '.agent-team/plans/aaa_111111.html', is_dir: false },
        { name: 'zzz_222222.html', rel_path: '.agent-team/plans/zzz_222222.html', is_dir: false },
      ],
      htmlFiles: {
        '.agent-team/plans/aaa_111111.html': namedPlan('Apple Plan'),
        '.agent-team/plans/zzz_222222.html': namedPlan('Zebra Plan'),
      },
      mtimes: {
        '.agent-team/plans/aaa_111111.html': 100,
        '.agent-team/plans/zzz_222222.html': 200,
      },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    // Title order lists Apple before Zebra; mtime order is the reverse.
    await wrapper.find('.plans-sort-select').setValue('title')
    let names = wrapper.findAll('.plan-row-name').map((n) => n.text())
    expect(names.indexOf('Apple Plan')).toBeLessThan(names.indexOf('Zebra Plan'))

    await wrapper.find('.plans-sort-select').setValue('updated')
    names = wrapper.findAll('.plan-row-name').map((n) => n.text())
    expect(names.indexOf('Zebra Plan')).toBeLessThan(names.indexOf('Apple Plan'))
    expect(localStorage.getItem('navide.plans.sort.v2./ws')).toBe('updated')
  })

  it('sorts within a group by done/total ratio when Progress is selected', async () => {
    const backend = makeBackend({
      htmlEntries: [
        { name: 'low_111111.html', rel_path: '.agent-team/plans/low_111111.html', is_dir: false },
        { name: 'high_222222.html', rel_path: '.agent-team/plans/high_222222.html', is_dir: false },
      ],
      htmlFiles: {
        '.agent-team/plans/low_111111.html': namedPlan('Alpha Low', {
          todos: [{ id: 'a', content: 'x', status: 'pending' }],
        }),
        '.agent-team/plans/high_222222.html': namedPlan('Zeta High', {
          todos: [{ id: 'a', content: 'x', status: 'done' }],
        }),
      },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    await wrapper.find('.plans-sort-select').setValue('progress')
    const names = wrapper.findAll('.plan-row-name').map((n) => n.text())
    expect(names.indexOf('Zeta High')).toBeLessThan(names.indexOf('Alpha Low'))
  })

  it('aggregates files from multiple directories including .agent-team/reports and .claude/loop-reports', async () => {
    const backend = makeBackend({
      dirEntries: {
        '.agent-team/reports': [
          { name: 'summary.html', rel_path: '.agent-team/reports/summary.html', is_dir: false },
          { name: '_infra.html', rel_path: '.agent-team/reports/_infra.html', is_dir: false },
        ],
        '.claude/loop-reports': [
          { name: 'loop1.md', rel_path: '.claude/loop-reports/loop1.md', is_dir: false },
        ],
      },
      customFiles: {
        '.agent-team/reports/summary.html': '<html><head><title>Summary Report</title></head><body></body></html>',
        '.claude/loop-reports/loop1.md': '# Loop 1 Notes\n\nSome detail',
      },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('summary.html')
    expect(text).toContain('loop1.md')
    expect(text).not.toContain('_infra.html')
  })
})

// ── Flat (ungrouped) list, the pane default ──────────────────────────────────

describe('PlansPane – flat list default', () => {
  const flatPlan = (name: string, stage: string) =>
    htmlPlan({
      schemaVersion: 1,
      name,
      overview: '',
      stage,
      approvedAt: null,
      todos: [],
      reviewNotes: [],
    })

  /** No group-mode seeding — exercises the shipped default. */
  function mountDefault(backend: ReturnType<typeof makeBackend>) {
    return mount(PlansPane, {
      props: { workspacePath: '/ws', backend: backend as never },
      global: { plugins: [i18n] },
    })
  }

  function crossStageBackend() {
    return makeBackend({
      htmlEntries: [
        { name: 'aaa_111111.html', rel_path: '.agent-team/plans/aaa_111111.html', is_dir: false },
        { name: 'zzz_222222.html', rel_path: '.agent-team/plans/zzz_222222.html', is_dir: false },
      ],
      htmlFiles: {
        // Older, and in an earlier stage group than the newer one — under stage
        // grouping "Old Draft" would always be listed above "New Progress".
        '.agent-team/plans/aaa_111111.html': flatPlan('Old Draft', 'draft'),
        '.agent-team/plans/zzz_222222.html': flatPlan('New Progress', 'in-progress'),
      },
      mtimes: {
        '.agent-team/plans/aaa_111111.html': 100,
        '.agent-team/plans/zzz_222222.html': 200,
      },
    })
  }

  it('defaults to one list ordered newest first, across stages', async () => {
    const wrapper = mountDefault(crossStageBackend())
    await flushPromises()

    // One collapsible section, not one per stage (the stage names still appear
    // in the filter dropdown, so assert on the section headers themselves).
    const sections = wrapper.findAll('.plans-section-title').map((s) => s.text())
    expect(sections).toHaveLength(1)
    expect(sections[0]).toContain('All plans')
    const names = wrapper.findAll('.plan-row-name').map((n) => n.text())
    expect(names.indexOf('New Progress')).toBeLessThan(names.indexOf('Old Draft'))
  })

  it('ignores a stored v1 sort choice and clears the retired key', async () => {
    localStorage.setItem('navide.plans.sort./ws', 'title')
    const wrapper = mountDefault(crossStageBackend())
    await flushPromises()

    expect(localStorage.getItem('navide.plans.sort./ws')).toBeNull()
    expect((wrapper.find('.plans-sort-select').element as HTMLSelectElement).value).toBe('updated')
    const names = wrapper.findAll('.plan-row-name').map((n) => n.text())
    expect(names.indexOf('New Progress')).toBeLessThan(names.indexOf('Old Draft'))
  })

  it('flips the order when the direction button is clicked, and persists it', async () => {
    const wrapper = mountDefault(crossStageBackend())
    await flushPromises()

    await wrapper.find('.plans-sort-dir').trigger('click')
    const names = wrapper.findAll('.plan-row-name').map((n) => n.text())
    expect(names.indexOf('Old Draft')).toBeLessThan(names.indexOf('New Progress'))
    expect(localStorage.getItem('navide.plans.sortdir./ws')).toBe('asc')
  })

  it('resets the direction to the new mode default when the mode changes', async () => {
    const wrapper = mountDefault(crossStageBackend())
    await flushPromises()

    await wrapper.find('.plans-sort-dir').trigger('click')
    expect(localStorage.getItem('navide.plans.sortdir./ws')).toBe('asc')

    await wrapper.find('.plans-sort-select').setValue('title')
    expect(localStorage.getItem('navide.plans.sortdir./ws')).toBe('asc')

    await wrapper.find('.plans-sort-select').setValue('updated')
    expect(localStorage.getItem('navide.plans.sortdir./ws')).toBe('desc')
  })

  it('switches to stage groups and persists the choice', async () => {
    const wrapper = mountDefault(crossStageBackend())
    await flushPromises()

    await wrapper.find('.plans-group-toggle').trigger('click')
    expect(localStorage.getItem('navide.plans.group./ws')).toBe('stage')
    expect(wrapper.text()).not.toContain('All plans')
    expect(wrapper.text()).toContain('Draft')
    const names = wrapper.findAll('.plan-row-name').map((n) => n.text())
    expect(names.indexOf('Old Draft')).toBeLessThan(names.indexOf('New Progress'))
  })

  it('lists plain docs in the same flat list, below plans that carry an mtime', async () => {
    const wrapper = mountDefault(crossStageBackend())
    await flushPromises()

    // The .cursor/plans markdown fixtures report no mtime, so they sink.
    const names = wrapper.findAll('.plan-row-name').map((n) => n.text())
    expect(names).toContain('Active Plan')
    expect(names.indexOf('New Progress')).toBeLessThan(names.indexOf('Active Plan'))
  })
})
