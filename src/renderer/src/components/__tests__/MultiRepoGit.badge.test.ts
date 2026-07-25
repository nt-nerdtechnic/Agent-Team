// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import MultiRepoGit from '../MultiRepoGit.vue'

// Control the discovered repo list.
const mockRepositories = ref<{ rel_path: string; abs_path: string; branch: string; badge: { branch: string; dirtyCount: number } }[]>([])

vi.mock('../../composables/useRepoDiscovery', () => ({
  useRepoDiscovery: () => ({ repositories: mockRepositories, refresh: vi.fn() }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (k: string) => k }),
}))

// Controllable GitPane stub: renders a marker carrying its workspacePath so a
// test can locate the pane for a given repo and drive its changes-count emit
// (the real per-repo count that MultiRepoGit accumulates). Supplied via
// global.stubs so the async GitPane import is replaced without module mocking.
const gitPaneStub = {
  name: 'GitPane',
  props: ['workspacePath'],
  emits: ['changes-count'],
  template: '<div class="gitpane-stub" :data-ws="workspacePath"></div>',
}

function mountRepo() {
  return mount(MultiRepoGit, {
    props: { workspacePath: '/ws', backend: makeBackend() },
    global: { stubs: { GitPane: gitPaneStub } },
  })
}

function makeRepo(relPath: string, absPath: string, branch = 'main', dirtyCount = 0) {
  return { rel_path: relPath, abs_path: absPath, branch, badge: { branch, dirtyCount } }
}

function makeBackend() {
  const send = vi.fn(async (type: string) => {
    if (type === 'project.peek') return { ok: true, payload: { project: null } }
    return { ok: true, payload: { ok: true } }
  })
  return { send } as never
}

function panes(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAllComponents({ name: 'GitPane' })
}

async function emitFor(wrapper: ReturnType<typeof mount>, ws: string, n: number) {
  const pane = panes(wrapper).find((c) => c.props('workspacePath') === ws)
  if (!pane) throw new Error(`GitPane for ${ws} not mounted`)
  pane.vm.$emit('changes-count', n)
  await nextTick()
}

/** Latest value emitted on `changes-count`, or undefined if never emitted. */
function lastCount(wrapper: ReturnType<typeof mount>): number | undefined {
  const ev = wrapper.emitted('changes-count') as unknown[][] | undefined
  if (!ev || ev.length === 0) return undefined
  return ev[ev.length - 1][0] as number
}

beforeEach(() => {
  mockRepositories.value = []
})

describe('MultiRepoGit – badge staleness fixes', () => {
  it('prunes a departed repo count so the total drops the vanished repo', async () => {
    // Three repos → multi mode.
    mockRepositories.value = [
      makeRepo('.', '/ws'),
      makeRepo('a', '/ws/a'),
      makeRepo('b', '/ws/b'),
    ]
    const wrapper = mountRepo()
    await flushPromises()

    // Root tab active by default → its pane is mounted; report 5 changes.
    await emitFor(wrapper, '/ws', 5)

    // Visit tab a and b so their panes mount, then report their counts.
    const tabs = wrapper.findAll('.repo-tab')
    await tabs[1].trigger('click')
    await flushPromises()
    await emitFor(wrapper, '/ws/a', 3)
    await tabs[2].trigger('click')
    await flushPromises()
    await emitFor(wrapper, '/ws/b', 2)

    // Total = 5 + 3 + 2 = 10.
    expect(lastCount(wrapper)).toBe(10)

    // Repo b leaves the workspace (still multi: 2 repos remain).
    mockRepositories.value = [makeRepo('.', '/ws'), makeRepo('a', '/ws/a')]
    await flushPromises()

    // Without the prune watcher this would stay 10 (b's 2 lingering).
    expect(lastCount(wrapper)).toBe(8)
  })

  it('re-emits on multi→single flip instead of freezing the old total', async () => {
    mockRepositories.value = [makeRepo('.', '/ws'), makeRepo('a', '/ws/a')]
    const wrapper = mountRepo()
    await flushPromises()

    // Multi total = 4.
    await emitFor(wrapper, '/ws', 4)
    expect(lastCount(wrapper)).toBe(4)

    // Drop to a single repo → mode flips to single.
    mockRepositories.value = [makeRepo('.', '/ws')]
    await flushPromises()

    // The flip watcher re-emits the single-mode count (0); the badge must not
    // stay frozen on the stale multi total of 4.
    expect(lastCount(wrapper)).toBe(0)
  })

  it('re-emits on single→multi flip', async () => {
    mockRepositories.value = [makeRepo('.', '/ws')]
    const wrapper = mountRepo()
    await flushPromises()

    // Single mode reports 7 (forwarded straight through).
    await emitFor(wrapper, '/ws', 7)
    expect(lastCount(wrapper)).toBe(7)

    // Grow to two repos → mode flips to multi; freshly mounted panes have not
    // reported yet, so the total is 0 — and the badge must reflect that, not 7.
    mockRepositories.value = [makeRepo('.', '/ws'), makeRepo('a', '/ws/a')]
    await flushPromises()

    expect(lastCount(wrapper)).toBe(0)
  })
})
