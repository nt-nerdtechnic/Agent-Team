// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import GitWindowApp from '../GitWindowApp.vue'
import {
  GIT_BRANCH_DIFF_KEY,
  GIT_FILE_ACCESS_KEY,
  GIT_ISSUES_KEY,
  GIT_TRANSPORT_KEY,
  GIT_UI_KEY,
} from '../ports/gitSurface'
import type { GitTransport, GitTransportResponse } from '#git-feature'
import type { AiCliSessionController } from '@navide/plugin-ui'

const calls: Array<{ type: string; payload: Record<string, unknown> }> = []
let initialized = false

const transport: GitTransport = {
  status: { value: 'connected' },
  async send<TPayload = unknown>(type: Parameters<GitTransport['send']>[0], payload = {}) {
    calls.push({ type, payload })
    if (type === 'git.status') {
      return {
        ok: true,
        payload: {
          is_git_repo: initialized,
          branch: initialized ? 'main' : '',
          remote_branch: '',
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [],
          untracked: [],
          ignored: [],
          operation_in_progress: '',
        },
        error: null,
      } as GitTransportResponse<TPayload>
    }
    if (type === 'git.init') {
      initialized = true
      return { ok: true, payload: { ok: true, gitignore_created: true }, error: null } as GitTransportResponse<TPayload>
    }
    if (type === 'git.discover_repositories') {
      return { ok: true, payload: { ok: true, repositories: [] }, error: null } as GitTransportResponse<TPayload>
    }
    return { ok: true, payload: { ok: true }, error: null } as GitTransportResponse<TPayload>
  },
  on: () => () => undefined,
}

const aiCliController: AiCliSessionController = {
  sessionId: null,
  start: vi.fn(async () => 'session'),
  send: vi.fn(async () => undefined),
  resize: vi.fn(async () => undefined),
  interrupt: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  dispose: vi.fn(),
  onOutput: vi.fn(() => () => undefined),
  onExit: vi.fn(() => () => undefined),
}

describe('production navide.git window composition', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    calls.length = 0
    initialized = false
  })

  it('loads status through the injected transport and initializes the repository', async () => {
    window.history.replaceState({}, '', '/?workspace_path=%2Fworkspace')
    wrapper = mount(GitWindowApp, {
      props: {
        workspaceGrantPort: {
          pickWorkspace: vi.fn(async () => null),
          openWorkspace: vi.fn(async () => undefined),
          openKnownWorktree: vi.fn(async () => undefined),
        },
        aiCliController,
      },
      global: {
        plugins: [i18n],
        stubs: {
          SafeAiCliPanel: true,
          GitHistoryModal: true,
          NotificationHost: true,
          DiffPane: true,
          BranchDiffPane: true,
          ConflictPane: true,
        },
        provide: {
          [GIT_TRANSPORT_KEY as symbol]: transport,
          [GIT_FILE_ACCESS_KEY as symbol]: {
            readFile: vi.fn(), writeFile: vi.fn(), readImage: vi.fn(),
          },
          [GIT_UI_KEY as symbol]: {
            openInEditor: vi.fn(), openExternal: vi.fn(), revealPath: vi.fn(), pickFolder: vi.fn(),
          },
          [GIT_BRANCH_DIFF_KEY as symbol]: { load: vi.fn() },
          [GIT_ISSUES_KEY as symbol]: {
            provider: vi.fn(async () => ({ ok: true, payload: { provider: 'none' }, error: null })),
            list: vi.fn(), get: vi.fn(), create: vi.fn(), comment: vi.fn(), setState: vi.fn(),
          },
        },
      },
    })

    await flushPromises()
    expect(calls).toContainEqual({
      type: 'git.status',
      payload: { workspace_path: '/workspace', include_ignored: false },
    })

    const statusCallsBeforeInit = calls.filter(({ type }) => type === 'git.status').length
    await wrapper.get('.init-card .pbtn').trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({
      type: 'git.init',
      payload: { workspace_path: '/workspace', create_gitignore: true },
    })
    expect(calls.filter(({ type }) => type === 'git.status').length).toBeGreaterThan(statusCallsBeforeInit)
  })
})
