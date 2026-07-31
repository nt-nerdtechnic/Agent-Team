// @vitest-environment happy-dom
// GitWindowApp (the navide.git standalone window) — wiring tests for the
// working-tree operations added on top of the read-only skeleton: stage /
// unstage / stage-all, the commit box, conflict quick-resolution + the
// operation banner, and sidebar branch switching. The backend is mocked at the
// useBackend seam (exactly what the plugin build aliases), so every assertion
// is on the real useGit → send() wire format.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'

interface SentCall {
  type: string
  payload: Record<string, unknown>
}

const sends = vi.hoisted(() => ({ calls: [] as { type: string; payload: Record<string, unknown> }[] }))

// Per-test override for the git.status payload.
const statusOverride = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }))

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
    if (type === 'git.status') return statusOverride.value ?? baseStatus()
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

const STUBS = {
  GitHistoryModal: true,
  GitCredentialModal: true,
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

async function openStatusView(wrapper: VueWrapper): Promise<void> {
  const btn = wrapper
    .findAll('button.sb-item')
    .find((b) => b.text().startsWith('File status'))
  expect(btn).toBeTruthy()
  await btn!.trigger('click')
  await flushPromises()
}

describe('GitWindowApp — working-tree operations', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    sends.calls.length = 0
    statusOverride.value = null
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

  it('stages an unstaged file and stages all from the group header', async () => {
    wrapper = await mountApp()
    await openStatusView(wrapper)

    const stageBtn = wrapper.findAll('.status-row .row-btn[title="Stage"]').at(0)
    expect(stageBtn).toBeTruthy()
    await stageBtn!.trigger('click')
    await flushPromises()
    expect(callsOf('git.stage')[0]!.payload).toMatchObject({
      workspace_path: '/tmp/ws',
      files: ['src/a.ts']
    })

    const stageAll = wrapper.findAll('button.sg-btn').find((b) => b.text() === 'Stage all')
    await stageAll!.trigger('click')
    await flushPromises()
    expect(callsOf('git.stage_all').length).toBe(1)
  })

  it('unstages a staged file from its row action', async () => {
    wrapper = await mountApp()
    await openStatusView(wrapper)
    const unstage = wrapper.findAll('.status-row .row-btn[title="Unstage"]').at(0)
    await unstage!.trigger('click')
    await flushPromises()
    expect(callsOf('git.unstage')[0]!.payload).toMatchObject({ files: ['src/staged.ts'] })
  })

  it('commits the staged changes with the typed message', async () => {
    wrapper = await mountApp()
    await openStatusView(wrapper)

    const input = wrapper.find('textarea.cb-input')
    await input.setValue('feat: test commit')
    const commitBtn = wrapper.findAll('button.cb-btn.primary').at(0)!
    expect(commitBtn.attributes('disabled')).toBeUndefined()
    await commitBtn.trigger('click')
    await flushPromises()
    expect(callsOf('git.commit')[0]!.payload).toMatchObject({
      workspace_path: '/tmp/ws',
      message: 'feat: test commit'
    })
  })

  it('disables commit when nothing is staged and no operation is in progress', async () => {
    statusOverride.value = { ...baseStatus(), staged: [] }
    wrapper = await mountApp()
    await openStatusView(wrapper)
    const input = wrapper.find('textarea.cb-input')
    await input.setValue('msg')
    const commitBtn = wrapper.findAll('button.cb-btn.primary').at(0)!
    expect(commitBtn.attributes('disabled')).toBeDefined()
  })

  it('shows the operation banner and conflict quick-resolution during a merge', async () => {
    statusOverride.value = {
      ...baseStatus(),
      operation_in_progress: 'merge',
      unstaged: [{ path: 'src/conflict.ts', status: 'U' }]
    }
    wrapper = await mountApp()
    await openStatusView(wrapper)

    expect(wrapper.find('.op-banner').text()).toContain('merge in progress')
    const ours = wrapper.find('.status-row .row-btn[title="Resolve using ours"]')
    expect(ours.exists()).toBe(true)
    await ours.trigger('click')
    await flushPromises()
    expect(callsOf('git.resolve_ours')[0]!.payload).toMatchObject({ filepath: 'src/conflict.ts' })
  })

  it('switches branch from the sidebar and never for the current branch', async () => {
    wrapper = await mountApp()
    const rows = wrapper.findAll('.sb-item.row')
    const feature = rows.find((r) => r.text().includes('feature-x'))
    await feature!.trigger('click')
    await flushPromises()
    expect(callsOf('git.switch_branch')[0]!.payload).toMatchObject({ name: 'feature-x' })

    sends.calls.length = 0
    const current = rows.find((r) => r.text().includes('main') && r.classes().includes('current'))
    await current!.trigger('click')
    await flushPromises()
    expect(callsOf('git.switch_branch').length).toBe(0)
  })

  it('opens the branch-diff view with a sensible base/compare preselection', async () => {
    wrapper = await mountApp()
    const btn = wrapper.findAll('button.sb-item').find((b) => b.text() === 'Branch diff')
    await btn!.trigger('click')
    await flushPromises()
    const selects = wrapper.findAll('select.bd-select')
    expect(selects.length).toBe(2)
    expect((selects[0]!.element as HTMLSelectElement).value).toBe('main')
    // compare defaults to the current branch; base falls back to main/master —
    // both equal here, so the pane still waits for a distinct pick.
    expect(wrapper.find('.bd-pickers').exists()).toBe(true)
  })
})
