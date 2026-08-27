// @vitest-environment happy-dom
// Regression tests for what the plan window does when the backend is not
// reachable while it is starting up or opening a document.
//
// Both paths covered here used to swallow a transport failure and turn it into
// a wrong, permanent answer: the markdown-kind probe let the rejection escape
// and left the document spinning forever, and the restore-on-open probe read
// "could not ask" as "the file is gone" and silently dropped the plan the user
// had open. Neither had anything that would ever try again, so a momentary
// backend outage cost the user the rest of the window session.
//
// The mock backend here starts DISCONNECTED on purpose — that is the real
// scenario (window opened while the backend was restarting), and it means the
// reconnect watcher only fires on a genuine status transition, exactly as it
// would in production.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import PlanWindowApp from '../../PlanWindowApp.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { lastOpenedStorageKey } from '../plansPaneModel'
import type { useBackend as useBackendFn } from '../../composables/useBackend'

i18n.global.locale.value = 'en-US'

window.history.replaceState({}, '', '/?window=plans&workspace_path=/tmp/demo-ws')

const WORKSPACE = '/tmp/demo-ws'
const HTML_PLAN = '.agent-team/plans/feature_a1b2c3.html'
const MD_PLAN_PATH = '.cursor/plans/feature.plan.md'

// Valid markdown plan (frontmatter meta) — a successful probe of this content
// must land on 'plan', which is how the retry is proven to have re-run.
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

Body A.
`

function stub(name: string, props: string[] = []) {
  return {
    __esModule: true,
    default: defineComponent({
      name,
      props,
      inheritAttrs: false,
      render: () => h('div', { class: `stub-${name}` }),
    }),
  }
}

// useBackend() is called at component setup, never at module evaluation, so the
// factory can read a holder that beforeEach fills with a fresh mock per test.
const backendHolder = vi.hoisted(() => ({ api: null as ReturnType<typeof useBackendFn> | null }))
vi.mock('../../composables/useBackend', () => ({
  useBackend: () => backendHolder.api!,
}))

vi.mock('../PlansPane.vue', () => stub('PlansPane', ['workspacePath', 'backend']))
vi.mock('../PlanReviewToolbar.vue', () =>
  stub('PlanReviewToolbar', ['workspacePath', 'relPath', 'backend', 'store']),
)
vi.mock('../PlanDocPreview.vue', () =>
  stub('PlanDocPreview', ['workspacePath', 'relPath', 'backend', 'refresh']),
)
vi.mock('../PlanMarkdownBody.vue', () =>
  stub('PlanMarkdownBody', ['workspacePath', 'relPath', 'backend', 'refresh']),
)
vi.mock('../PlanFileView.vue', () => stub('PlanFileView', ['workspacePath', 'relPath', 'backend']))
vi.mock('../FilePreviewPane.vue', () =>
  stub('FilePreviewPane', ['workspacePath', 'relPath', 'name', 'backend']),
)
vi.mock('../../components/NotificationHost.vue', () => stub('NotificationHost'))
// The CLI dock's terminal host pulls in useTerminal/xterm — stub it with the
// imperative surface the dock drives on mount.
const toastMock = vi.hoisted(() => vi.fn())
vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => ({ toast: toastMock, alert: vi.fn(), confirm: vi.fn(async () => true) }),
  useTheme: () => ({ theme: ref('dark'), setTheme: vi.fn(), loadTheme: vi.fn() }),
}))

vi.mock('@navide/terminal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  return {
    ...actual,
    useTerminal: () => ({
      mount: vi.fn(),
      updateXtermTheme: vi.fn(),
      spawn: vi.fn(async () => undefined),
      tryReattach: vi.fn(async () => undefined),
      pasteText: vi.fn(),
      interrupt: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
      cancelPendingCreate: vi.fn(async () => undefined),
      fitTerminal: vi.fn(),
      focus: vi.fn(),
      status: ref('idle'),
      displayStatus: ref('idle'),
      lastRawActivityAt: ref(0),
      sessionId: ref(''),
      error: ref(''),
    }),
  }
})

vi.mock('@navide/plugin-ui/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/shared')>()),
  initSettingsBackend: vi.fn(),
  settingsGet: vi.fn((_key: string, def: unknown) => def),
  settingsSet: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {}),
}))

let mock: ReturnType<typeof createMockBackend>

beforeEach(() => {
  toastMock.mockClear()
  localStorage.clear()
  window.history.replaceState({}, '', `/?window=plans&workspace_path=${WORKSPACE}`)
  mock = createMockBackend('disconnected')
  // The plan window needs a couple of fields the composable mock does not model;
  // spreading keeps `status`/`send`/`on` as the very objects the mock owns.
  backendHolder.api = {
    ...mock.backend,
    httpUrl: ref('http://127.0.0.1:1'),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as ReturnType<typeof useBackendFn>
})

// PlanWindowApp registers window-level keydown handling; unmount so stale
// handlers cannot fire during later tests.
const mountedApps: VueWrapper[] = []
async function mountApp(): Promise<VueWrapper> {
  const wrapper = mount(PlanWindowApp, { global: { plugins: [i18n] } })
  mountedApps.push(wrapper)
  await flushPromises()
  return wrapper
}

afterEach(() => {
  while (mountedApps.length) mountedApps.pop()!.unmount()
})

async function open(wrapper: VueWrapper, filepath: string): Promise<void> {
  wrapper
    .findComponent({ name: 'PlansPane' })
    .vm.$emit('open-file', { filepath, name: filepath.split('/').pop() ?? filepath })
  await flushPromises()
}

/** Drive a reconnect the way the real backend composable does: a status change. */
async function reconnect(): Promise<void> {
  mock.status.value = 'connected'
  await flushPromises()
}

function statCalls(): number {
  return mock.sent.filter((s) => s.type === 'fs.stat_path').length
}

describe('PlanWindowApp – markdown kind probe while the backend is down', () => {
  it('stays on loading when the meta read rejects, rather than calling it a plain doc', async () => {
    // 'doc' is the dangerous guess: it drops the review toolbar off what may
    // well be a real plan, and nothing re-probes to put it back. 'loading' is
    // the honest answer — the kind is genuinely unknown until someone can read
    // the file.
    mock.setRejection('fs.read_file')
    const wrapper = await mountApp()
    await open(wrapper, MD_PLAN_PATH)

    expect(wrapper.findComponent({ name: 'PlanFileView' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PlanReviewToolbar' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PlanMarkdownBody' }).exists()).toBe(false)
    // The document is open (loading placeholder), not back on the empty state.
    expect(wrapper.find('.plan-window-doc').exists()).toBe(true)
    expect(wrapper.find('.plan-window-empty').exists()).toBe(false)
    // The failure is not worth a toast — it resolves itself on reconnect.
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('re-probes on reconnect and resolves the markdown plan', async () => {
    mock.setRejection('fs.read_file')
    const wrapper = await mountApp()
    await open(wrapper, MD_PLAN_PATH)
    expect(wrapper.findComponent({ name: 'PlanReviewToolbar' }).exists()).toBe(false)

    mock.clearRejection('fs.read_file')
    mock.setResponse('fs.read_file', { ok: true, content: MD_PLAN, mtime: 1 })
    await reconnect()

    // Frontmatter meta parsed → 'plan': toolbar above the markdown body, which
    // is what the user lost for the whole session before the retry existed.
    const toolbar = wrapper.findComponent({ name: 'PlanReviewToolbar' })
    expect(toolbar.exists()).toBe(true)
    expect(toolbar.props('relPath')).toBe(MD_PLAN_PATH)
    expect(wrapper.findComponent({ name: 'PlanMarkdownBody' }).exists()).toBe(true)
  })

  it('resolves a plain markdown file to doc on the retry, not just plans', async () => {
    // The retry must reach the real verdict either way; a reconnect that only
    // ever produced 'plan' would hang the legacy read-only view on 'loading'.
    mock.setRejection('fs.read_file')
    const wrapper = await mountApp()
    await open(wrapper, MD_PLAN_PATH)

    mock.clearRejection('fs.read_file')
    mock.setResponse('fs.read_file', { ok: true, content: '# Plain\n\nNo frontmatter.\n', mtime: 1 })
    await reconnect()

    expect(wrapper.findComponent({ name: 'PlanFileView' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'PlanReviewToolbar' }).exists()).toBe(false)
  })

  it('drops the pending probe when the user has since opened another document', async () => {
    // The retry is keyed to the document that failed. Re-probing after the user
    // moved on would race the current document's own probe and could stamp the
    // older file's kind onto the newer one.
    mock.setRejection('fs.read_file')
    const wrapper = await mountApp()
    await open(wrapper, MD_PLAN_PATH)

    mock.clearRejection('fs.read_file')
    mock.setResponse('fs.read_file', { ok: true, content: MD_PLAN, mtime: 1 })
    await open(wrapper, HTML_PLAN) // HTML routes by path and never consults mdKind
    await reconnect()

    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).props('relPath')).toBe(HTML_PLAN)
    expect(wrapper.findComponent({ name: 'PlanMarkdownBody' }).exists()).toBe(false)
  })
})

describe('PlanWindowApp – restoring the last opened plan while the backend is down', () => {
  const KEY = lastOpenedStorageKey(WORKSPACE)

  it('holds the restore when the existence probe rejects, and opens it on reconnect', async () => {
    // "Could not ask" is not "the file is gone": treating the transport failure
    // as absence threw away the plan the user was working on and brought the
    // window up empty with nothing to explain why.
    localStorage.setItem(KEY, HTML_PLAN)
    mock.setRejection('fs.stat_path')

    const wrapper = await mountApp()
    expect(wrapper.find('.plan-window-empty').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).exists()).toBe(false)
    // Nothing is opened on a guess either — an unverified restore could point at
    // a deleted file and open the window onto an error.
    expect(toastMock).not.toHaveBeenCalled()

    mock.clearRejection('fs.stat_path')
    mock.setResponse('fs.stat_path', { ok: true, exists: true })
    await reconnect()

    const preview = wrapper.findComponent({ name: 'PlanDocPreview' })
    expect(preview.exists()).toBe(true)
    expect(preview.props('relPath')).toBe(HTML_PLAN)
    expect(wrapper.find('.plan-window-empty').exists()).toBe(false)
  })

  it('does not resurrect a plan the backend said is gone', async () => {
    // A definite "absent" answer is a real answer, so the reconnect retry must
    // not touch it — otherwise every reconnect would reopen a deleted plan.
    localStorage.setItem(KEY, HTML_PLAN)
    mock.setResponse('fs.stat_path', { ok: true, exists: false })

    const wrapper = await mountApp()
    expect(wrapper.find('.plan-window-empty').exists()).toBe(true)
    expect(statCalls()).toBe(1)

    await reconnect()

    expect(wrapper.find('.plan-window-empty').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).exists()).toBe(false)
    // No second probe: the restore was retired, not parked.
    expect(statCalls()).toBe(1)
  })

  it('leaves the held restore alone once the user opens something themselves', async () => {
    // The reconnect retry is a fallback for an empty window, not an override —
    // reopening the stored plan over the document the user just picked would
    // yank the view out from under them.
    localStorage.setItem(KEY, HTML_PLAN)
    mock.setRejection('fs.stat_path')

    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/other_d4e5f6.html')

    mock.clearRejection('fs.stat_path')
    mock.setResponse('fs.stat_path', { ok: true, exists: true })
    await reconnect()

    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).props('relPath')).toBe(
      '.agent-team/plans/other_d4e5f6.html',
    )
  })
})
