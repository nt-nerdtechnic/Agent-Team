// @vitest-environment happy-dom
// GitWindowApp (the navide.git standalone window) — wiring tests for the
// "Editorial Calm" design: the checkbox-IS-the-stage-state file card, the
// commit composer, conflict quick-resolution, the sidebar "⋯" popover menus
// (branches / stashes / worktrees / remotes), and the diff detail. The backend
// is mocked at the useBackend seam (exactly what the plugin build aliases), so
// every assertion is on the real useGit → send() wire format.
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
    if (type === 'git.stash_list')
      return { ok: true, stashes: [{ index: 0, ref: 'stash@{0}', message: 'wip sidebar' }] }
    if (type === 'git.remotes')
      return { ok: true, remotes: [{ name: 'origin', fetch_url: 'https://example.com/r.git', push_url: 'https://example.com/r.git' }] }
    if (type === 'git.tags') return { ok: true, tags: [] }
    if (type === 'git.worktrees')
      return {
        ok: true,
        worktrees: [
          {
            path: '/tmp/ws', head: 'abc1234', branch: 'main', is_main: true,
            detached: false, bare: false, locked: false, lock_reason: '',
            prunable: false, prune_reason: ''
          },
          {
            path: '/tmp/wt-feature', head: 'def5678', branch: 'feature-x', is_main: false,
            detached: false, bare: false, locked: false, lock_reason: '',
            prunable: false, prune_reason: ''
          }
        ]
      }
    if (type === 'ui.pick_folder') return { ok: true, path: '/tmp/picked' }
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

/** Open a row's "⋯" popover and click the item with the given label. */
async function runMenu(wrapper: VueWrapper, rowText: string, itemLabel: string): Promise<void> {
  const row = wrapper.findAll('.srow').find((r) => r.text().includes(rowText))
  expect(row, rowText).toBeTruthy()
  await row!.find('button.dots').trigger('click')
  const item = wrapper.findAll('.menu-item').find((m) => m.text() === itemLabel)
  expect(item, itemLabel).toBeTruthy()
  await item!.trigger('click')
  await flushPromises()
}

describe('GitWindowApp — Editorial Calm wiring', () => {
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

  it('stages via the checkbox and unstages via the checked checkbox', async () => {
    wrapper = await mountApp()
    const rows = wrapper.findAll('.frow')
    const unstagedRow = rows.find((r) => r.text().includes('a.ts'))
    await unstagedRow!.find('button.chk:not(.on)').trigger('click')
    await flushPromises()
    expect(callsOf('git.stage')[0]!.payload).toMatchObject({
      workspace_path: '/tmp/ws',
      files: ['src/a.ts']
    })

    const stagedRow = wrapper.findAll('.frow').find((r) => r.text().includes('staged.ts'))
    await stagedRow!.find('button.chk.on').trigger('click')
    await flushPromises()
    expect(callsOf('git.unstage')[0]!.payload).toMatchObject({ files: ['src/staged.ts'] })
  })

  it('stages all and unstages all from the list header links', async () => {
    wrapper = await mountApp()
    const stageAll = wrapper.findAll('.hdr-actions .linkbtn').find((b) => b.text() === 'Stage all')
    await stageAll!.trigger('click')
    await flushPromises()
    expect(callsOf('git.stage_all').length).toBe(1)

    const unstageAll = wrapper.findAll('.hdr-actions .linkbtn').find((b) => b.text() === 'Unstage all')
    await unstageAll!.trigger('click')
    await flushPromises()
    expect(callsOf('git.unstage')[0]!.payload).toMatchObject({ files: ['src/staged.ts'] })
  })

  it('commits the staged files with the composed message', async () => {
    wrapper = await mountApp()
    await wrapper.find('textarea.cmp-input').setValue('feat: editorial calm')
    const btn = wrapper.find('button.commitbtn')
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    await flushPromises()
    expect(callsOf('git.commit')[0]!.payload).toMatchObject({
      workspace_path: '/tmp/ws',
      message: 'feat: editorial calm'
    })
  })

  it('disables commit when nothing is staged and no operation is in progress', async () => {
    statusOverride.value = { ...baseStatus(), staged: [] }
    wrapper = await mountApp()
    await wrapper.find('textarea.cmp-input').setValue('msg')
    expect(wrapper.find('button.commitbtn').attributes('disabled')).toBeDefined()
  })

  it('shows the operation banner and conflict quick-resolution during a merge', async () => {
    statusOverride.value = {
      ...baseStatus(),
      operation_in_progress: 'merge',
      unstaged: [{ path: 'src/conflict.ts', status: 'U' }]
    }
    wrapper = await mountApp()
    expect(wrapper.find('.op-banner').text()).toContain('merge in progress')
    const conflictRow = wrapper.find('.frow.conflict')
    expect(conflictRow.exists()).toBe(true)
    const ours = conflictRow.findAll('button.linkbtn').find((b) => b.text() === 'ours')
    await ours!.trigger('click')
    await flushPromises()
    expect(callsOf('git.resolve_ours')[0]!.payload).toMatchObject({ filepath: 'src/conflict.ts' })
  })

  it('shows a clicked file diff in the bottom DiffPane detail', async () => {
    wrapper = await mountApp()
    const row = wrapper.findAll('.frow').find((r) => r.text().includes('a.ts'))
    await row!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.detail').exists()).toBe(true)
    const diff = wrapper.findComponent({ name: 'DiffPane' })
    expect(diff.attributes('filepath')).toBe('src/a.ts')
  })

  it('switches branch only through the ⋯ menu, never on row click', async () => {
    wrapper = await mountApp()
    const row = wrapper.findAll('.srow').find((r) => r.text().includes('feature-x'))
    await row!.trigger('click')
    await flushPromises()
    expect(callsOf('git.switch_branch').length).toBe(0)

    await runMenu(wrapper, 'feature-x', 'Switch to this branch')
    expect(callsOf('git.switch_branch')[0]!.payload).toMatchObject({ name: 'feature-x' })

    // The current branch row offers no menu at all.
    const current = wrapper.findAll('.srow').find((r) => r.classes().includes('cur'))
    expect(current!.find('button.dots').exists()).toBe(false)
  })

  it('drives stash actions from the Stashes drawer menu', async () => {
    wrapper = await mountApp()
    const drawer = wrapper.findAll('.srow.drawer').find((r) => r.text().includes('Stashes'))
    await drawer!.trigger('click')
    await runMenu(wrapper, 'wip sidebar', 'Pop (apply and remove)')
    expect(callsOf('git.stash_pop').length).toBe(1)
  })

  it('drives worktree lock and reveal from the Worktrees drawer menu', async () => {
    wrapper = await mountApp()
    const drawer = wrapper.findAll('.srow.drawer').find((r) => r.text().includes('Worktrees'))
    await drawer!.trigger('click')
    await runMenu(wrapper, 'wt-feature', 'Lock')
    expect(callsOf('git.lock_worktree')[0]!.payload).toMatchObject({ worktree_path: '/tmp/wt-feature' })
    await runMenu(wrapper, 'wt-feature', 'Reveal in Finder')
    expect(callsOf('ui.reveal_path')[0]!.payload).toMatchObject({ path: '/tmp/wt-feature' })
  })

  it('opens the remote URL through the ui.open_external host capability', async () => {
    wrapper = await mountApp()
    const drawer = wrapper.findAll('.srow.drawer').find((r) => r.text().includes('Remotes'))
    await drawer!.trigger('click')
    await runMenu(wrapper, 'origin', 'Open URL in browser')
    expect(callsOf('ui.open_external')[0]!.payload).toMatchObject({ url: 'https://example.com/r.git' })
  })

  it('opens the branch-diff view with a sensible base/compare preselection', async () => {
    wrapper = await mountApp()
    const btn = wrapper.findAll('.navi button').find((b) => b.text() === 'Branch diff')
    await btn!.trigger('click')
    await flushPromises()
    const selects = wrapper.findAll('select.ed-select')
    expect(selects.length).toBe(2)
    expect((selects[0]!.element as HTMLSelectElement).value).toBe('main')
  })
})
