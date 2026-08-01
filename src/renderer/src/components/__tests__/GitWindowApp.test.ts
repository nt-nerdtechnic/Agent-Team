// @vitest-environment happy-dom
// GitWindowApp (the navide.git standalone window) — wiring tests. The File-
// status surface embeds the real GitPane (stubbed here), so these tests cover
// the window-level wiring around it: repo-surface loading, the GitPane emit
// contracts (open-diff → bottom DiffPane, open-file → the ui.open_in_editor
// host capability, open-branch-diff → the comparison view), and the sidebar
// branch switching. The backend is mocked at the useBackend seam (exactly what
// the plugin build aliases), so every assertion is on the real useGit →
// send() wire format.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'

interface SentCall {
  type: string
  payload: Record<string, unknown>
}

const sends = vi.hoisted(() => ({ calls: [] as { type: string; payload: Record<string, unknown> }[] }))

function baseStatus(): Record<string, unknown> {
  return {
    is_git_repo: true,
    branch: 'main',
    remote_branch: 'origin/main',
    ahead: 0,
    behind: 0,
    staged: [{ path: 'src/staged.ts', status: 'M' }],
    unstaged: [{ path: 'src/a.ts', status: 'M' }],
    untracked: [{ path: 'src/new.ts', status: '?' }],
    ignored: [],
    operation_in_progress: ''
  }
}

vi.mock('../../composables/useBackend', () => {
  function payloadFor(type: string): unknown {
    if (type === 'git.status') return baseStatus()
    if (type === 'git.branches')
      return {
        ok: true,
        branches: [
          { name: 'main', is_current: true, is_remote: false, tracking: 'origin/main' },
          { name: 'feature-x', is_current: false, is_remote: false, tracking: '' },
          { name: 'origin/feature-y', is_current: false, is_remote: true, tracking: '' }
        ]
      }
    if (type === 'git.log') return { ok: true, commits: [] }
    if (type === 'git.stash_list') return { ok: true, stashes: [] }
    if (type === 'git.remotes')
      return { ok: true, remotes: [{ name: 'origin', fetch_url: 'u', push_url: 'u' }] }
    if (type === 'git.tags') return { ok: true, tags: [] }
    if (type === 'git.worktrees') return { ok: true, worktrees: [] }
    if (type === 'ui.settings.get') return { ok: true, settings: {} }
    return { ok: true }
  }
  return {
    useBackend: () => ({
      status: ref('connected'),
      wsUrl: ref(''),
      httpUrl: ref(''),
      shell: ref(''),
      port: ref(0),
      pid: ref(0),
      lastError: ref(''),
      send: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
        sends.calls.push({ type, payload })
        return {
          id: 'r',
          type,
          ok: true,
          payload: payloadFor(type),
          error: null,
          timestamp: new Date().toISOString()
        }
      }),
      on: vi.fn(() => () => {}),
      restart: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    })
  }
})

import GitWindowApp from '../../GitWindowApp.vue'
import GitPane from '../GitPane.vue'

const STUBS = {
  GitPane: true,
  GitHistoryModal: true,
  NotificationHost: true,
  DiffPane: true,
  BranchDiffPane: true
}

function callsOf(type: string): SentCall[] {
  return sends.calls.filter((c) => c.type === type)
}

async function mountApp(): Promise<VueWrapper> {
  window.history.replaceState({}, '', '/?workspace_path=%2Ftmp%2Fws')
  const wrapper = mount(GitWindowApp, { global: { stubs: STUBS } })
  await flushPromises()
  return wrapper
}

describe('GitWindowApp — window wiring around the embedded GitPane', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    sends.calls.length = 0
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('loads the repo surface on mount (status, log, branches, worktrees)', async () => {
    wrapper = await mountApp()
    for (const t of [
      'git.status',
      'git.log',
      'git.branches',
      'git.remotes',
      'git.tags',
      'git.stash_list',
      'git.worktrees'
    ]) {
      expect(callsOf(t).length, t).toBeGreaterThan(0)
    }
    expect(callsOf('git.status')[0]!.payload.workspace_path).toBe('/tmp/ws')
  })

  it('keeps the real GitPane mounted (embedded, with the workspace + backend)', async () => {
    wrapper = await mountApp()
    const pane = wrapper.findComponent(GitPane)
    expect(pane.exists()).toBe(true)
    expect(pane.attributes('workspace-path') ?? pane.attributes('workspacepath')).toBe('/tmp/ws')
    // Stays mounted while another view is shown (v-show, so its credential
    // modal keeps working for toolbar pushes).
    const history = wrapper.findAll('button.sb-item').find((b) => b.text() === 'History')
    await history!.trigger('click')
    expect(wrapper.findComponent(GitPane).exists()).toBe(true)
  })

  it('shows a clicked GitPane file diff in the bottom DiffPane detail', async () => {
    wrapper = await mountApp()
    wrapper
      .findComponent(GitPane)
      .vm.$emit('open-diff', { filepath: 'src/a.ts', staged: false, name: 'a.ts' })
    await flushPromises()
    const detail = wrapper.find('.detail')
    expect(detail.exists()).toBe(true)
    const diff = wrapper.findComponent({ name: 'DiffPane' })
    expect(diff.exists()).toBe(true)
    expect(diff.attributes('filepath')).toBe('src/a.ts')
  })

  it('routes open-file through the ui.open_in_editor host capability', async () => {
    wrapper = await mountApp()
    wrapper.findComponent(GitPane).vm.$emit('open-file', { filepath: 'src/a.ts', name: 'a.ts' })
    await flushPromises()
    expect(callsOf('ui.open_in_editor')[0]!.payload).toMatchObject({
      workspace_path: '/tmp/ws',
      filepath: 'src/a.ts'
    })
  })

  it('routes open-conflict through the ui.open_in_editor host capability too', async () => {
    wrapper = await mountApp()
    wrapper
      .findComponent(GitPane)
      .vm.$emit('open-conflict', { filepath: 'src/conflict.ts', name: 'conflict.ts' })
    await flushPromises()
    expect(callsOf('ui.open_in_editor')[0]!.payload).toMatchObject({
      filepath: 'src/conflict.ts'
    })
  })

  it('opens the comparison view from a GitPane open-branch-diff request', async () => {
    wrapper = await mountApp()
    wrapper.findComponent(GitPane).vm.$emit('open-branch-diff', { base: 'main', compare: 'feature-x' })
    await flushPromises()
    const selects = wrapper.findAll('select.bd-select')
    expect(selects.length).toBe(2)
    expect((selects[0]!.element as HTMLSelectElement).value).toBe('main')
    expect((selects[1]!.element as HTMLSelectElement).value).toBe('feature-x')
  })

  it('switches branch only via the explicit ↵ button, never on row click', async () => {
    wrapper = await mountApp()
    const rows = wrapper.findAll('.branch-row')
    const feature = rows.find((r) => r.text().includes('feature-x'))
    expect(feature).toBeTruthy()

    // Clicking the row itself must NOT switch (the single-click-switch bug).
    await feature!.trigger('click')
    await flushPromises()
    expect(callsOf('git.switch_branch').length).toBe(0)

    // The GitPane-style explicit Switch button does.
    await feature!.find('button[title="Switch"]').trigger('click')
    await flushPromises()
    expect(callsOf('git.switch_branch')[0]!.payload).toMatchObject({ name: 'feature-x' })

    // The current branch row offers no switch/merge/rebase buttons at all.
    const current = rows.find((r) => r.classes().includes('current'))
    expect(current!.find('button[title="Switch"]').exists()).toBe(false)
  })

  it('collapses and expands the sidebar section cards', async () => {
    wrapper = await mountApp()
    // Branches starts expanded; its header caret collapses it.
    expect(wrapper.findAll('.branch-row').length).toBeGreaterThan(0)
    const branchesHdr = wrapper
      .findAll('.card-hdr')
      .find((h) => h.text().includes('Branches'))
    await branchesHdr!.trigger('click')
    expect(wrapper.findAll('.branch-row').length).toBe(0)
    await branchesHdr!.trigger('click')
    expect(wrapper.findAll('.branch-row').length).toBeGreaterThan(0)

    // Stashes starts collapsed and expands on header click.
    const stashesHdr = wrapper.findAll('.card-hdr').find((h) => h.text().includes('Stashes'))
    expect(stashesHdr!.text()).toContain('▸')
    await stashesHdr!.trigger('click')
    expect(stashesHdr!.text()).toContain('▾')
  })

  it('opens the branch-diff view with a sensible base/compare preselection', async () => {
    wrapper = await mountApp()
    const btn = wrapper.findAll('button.sb-item').find((b) => b.text() === 'Branch diff')
    await btn!.trigger('click')
    await flushPromises()
    const selects = wrapper.findAll('select.bd-select')
    expect(selects.length).toBe(2)
    expect((selects[0]!.element as HTMLSelectElement).value).toBe('main')
  })
})
