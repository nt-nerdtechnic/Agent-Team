// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import BranchDiffPane from '../BranchDiffPane.vue'
import type { GitTransport } from '#git-feature'
import type { GitBranch, GitStatus } from '../../composables/useGit'

// BranchDiffPane used to open its own useGit() instance just to hand gitStatus
// and gitBranches to the review slot. Every instance subscribes to git.changed
// and fans out seven loaders on each broadcast, so the pane silently doubled
// the refresh cost of the window that already owned one. The two values are
// now injected as props; these tests pin both halves of that change — no
// second subscription, and the slot still receives the values.

const status: GitStatus = {
  is_git_repo: true,
  branch: 'main',
  remote_branch: 'origin/main',
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  ignored: [],
  operation_in_progress: '',
}

const branches: GitBranch[] = [
  { name: 'main', is_current: true, is_remote: false, tracking: 'origin/main' },
  { name: 'feature', is_current: false, is_remote: false, tracking: '' },
]

function makeTransport() {
  const send = vi.fn(async () => ({ ok: true, payload: { ok: true }, error: null }))
  const on = vi.fn(() => () => undefined)
  return { status: { value: 'connected' }, send, on } as unknown as GitTransport & {
    send: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
  }
}

function mountPane(transport: ReturnType<typeof makeTransport>, slots = {}) {
  return mount(BranchDiffPane, {
    props: {
      workspacePath: '/workspace',
      base: 'main',
      compare: 'feature',
      gitTransport: transport,
      branchDiff: {
        load: vi.fn(async () => ({
          ok: true,
          diff: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n',
        })),
      },
      gitStatus: status,
      gitBranches: branches,
    },
    slots,
    global: { plugins: [i18n] },
  })
}

describe('BranchDiffPane git state injection', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('never opens its own git subscription or status query', async () => {
    const transport = makeTransport()
    wrapper = mountPane(transport)
    await flushPromises()

    expect(transport.on).not.toHaveBeenCalled()
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('passes the injected status and branches to the review slot', async () => {
    const transport = makeTransport()
    const seen: Array<{ gitStatus: GitStatus; gitBranches: GitBranch[]; workspacePath: string }> = []
    wrapper = mountPane(transport, {
      review: (slotProps: { gitStatus: GitStatus; gitBranches: GitBranch[]; workspacePath: string }) => {
        seen.push(slotProps)
        return h('div', { class: 'review-stub' }, slotProps.gitStatus.branch)
      },
    })
    await flushPromises()

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)!.gitStatus).toEqual(status)
    expect(seen.at(-1)!.gitBranches).toEqual(branches)
    expect(seen.at(-1)!.workspacePath).toBe('/workspace')
    expect(wrapper.find('.review-stub').text()).toBe('main')
  })

  it('still renders the branch diff it loaded through the injected port', async () => {
    const transport = makeTransport()
    wrapper = mountPane(transport)
    await flushPromises()

    expect(wrapper.text()).toContain('a.txt')
  })
})
