// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_HOST_READ_ONLY_KEYS,
  GIT_USER_PREFERENCE_KEYS,
  GIT_WORKSPACE_REPOSITORY_KEY,
} from '#git-feature'
import type { PortResponse } from '@navide/plugin-ui/shared'
import {
  createPluginGitSettingsPort,
  createPluginGitContributionHostPort,
  createPluginGitAccountPort,
  createPluginGitWorkspaceGrantPort,
  createPluginLegacyRepoSelectionPort,
  type PluginCapabilitySdk,
} from '../pluginSurfacePorts'

const originalUrl = window.location.href

afterEach(() => {
  window.history.replaceState({}, '', originalUrl)
})

function makeSdk() {
  const requests: Array<{ type: string; payload: Record<string, unknown> }> = []
  const request = vi.fn(async (type: string, payload: Record<string, unknown>) => {
    requests.push({ type, payload })
    if (type === 'storage.get') {
      return {
        ok: true,
        payload: { found: true, value: payload.key },
        error: null,
      }
    }
    return { ok: true, payload: null, error: null }
  })
  const sdk = {
    status: { value: 'connected' },
    shell: { value: 'allowlist' },
    autoRestart: { value: null },
    request,
    subscribe: vi.fn(() => () => undefined),
    hostRequest: vi.fn(),
  } as unknown as PluginCapabilitySdk
  return { sdk, request, requests }
}

describe('navide.git v2 settings port', () => {
  it('reads only approved user keys plus the workspace repository selection', async () => {
    window.history.replaceState({}, '', '/?v2=1')
    const { sdk, requests } = makeSdk()

    const values = await createPluginGitSettingsPort(sdk).getAll()

    expect(requests).toHaveLength(GIT_USER_PREFERENCE_KEYS.length + 1)
    expect(requests.map(({ payload }) => payload)).toEqual(expect.arrayContaining([
      ...GIT_USER_PREFERENCE_KEYS.map((key) => ({ scope: 'plugin', key })),
      { scope: 'workspace', key: GIT_WORKSPACE_REPOSITORY_KEY },
    ]))
    expect(values).toEqual(Object.fromEntries([
      ...GIT_USER_PREFERENCE_KEYS.map((key) => [key, key]),
      [GIT_WORKSPACE_REPOSITORY_KEY, GIT_WORKSPACE_REPOSITORY_KEY],
    ]))
  })

  it('fails the authoritative snapshot when any storage read is denied', async () => {
    window.history.replaceState({}, '', '/?v2=1')
    const { sdk, request } = makeSdk()
    request.mockImplementationOnce(async () => ({
      ok: false,
      payload: null,
      error: { code: 'CAPABILITY_DENIED', message: 'denied' },
    } as never))

    await expect(createPluginGitSettingsPort(sdk).getAll()).rejects.toThrow('denied')
  })

  it('exposes the Host read-only contract without making it plugin-owned', () => {
    window.history.replaceState({}, '', '/?v2=1')
    const { sdk } = makeSdk()
    const port = createPluginGitSettingsPort(sdk)

    expect(port.ownedKeys).toEqual([...GIT_USER_PREFERENCE_KEYS, GIT_WORKSPACE_REPOSITORY_KEY])
    expect(port.readOnlyKeys).toEqual(GIT_HOST_READ_ONLY_KEYS)
  })

  it('writes approved keys to their owning partition and ignores Host-owned keys', async () => {
    window.history.replaceState({}, '', '/?v2=1')
    const { sdk, requests } = makeSdk()
    const port = createPluginGitSettingsPort(sdk)

    await port.setMany({
      'agentTeam.git.logScope': 'current',
      'agentTeam.gitTabRepo': '/workspace/sub',
      'agentTeam.analyzerModel': 'must-not-write',
      'agentTeam.yolo': 'must-not-write',
      __migrated: true,
    })

    expect(requests).toEqual([
      {
        type: 'storage.set',
        payload: { scope: 'plugin', key: 'agentTeam.git.logScope', value: 'current' },
      },
      {
        type: 'storage.set',
        payload: { scope: 'workspace', key: 'agentTeam.gitTabRepo', value: '/workspace/sub' },
      },
    ])
  })
})

describe('navide.git workspace grant port', () => {
  it('uses the private Host contribution bridge for picker provenance and open', async () => {
    const { sdk } = makeSdk()
    const hostRequests: Array<{ action: string; payload: Record<string, unknown> }> = []
    const hostRequest = async <TPayload = unknown>(
      action: string,
      payload: Record<string, unknown> = {},
    ): Promise<PortResponse<TPayload>> => {
      hostRequests.push({ action, payload })
      const response = action === 'git.contribution' && payload.operation === 'pick_workspace'
        ? { path: '/picked', grant: 'opaque-grant' }
        : { accepted: true }
      return { ok: true, payload: response as TPayload, error: null }
    }
    sdk.hostRequest = hostRequest
    const port = createPluginGitWorkspaceGrantPort(sdk)

    await expect(port.pickWorkspace('/default')).resolves.toEqual({ path: '/picked', grant: 'opaque-grant' })
    await port.openWorkspace({ path: '/cloned/repo', grant: 'derived-grant' })
    await port.openKnownWorktree('/workspace/worktrees/topic')

    expect(hostRequests).toEqual([
      { action: 'git.contribution', payload: { operation: 'pick_workspace', payload: { default_path: '/default' } } },
      { action: 'git.contribution', payload: { operation: 'open_workspace', payload: { path: '/cloned/repo', grant: 'derived-grant' } } },
      { action: 'git.contribution', payload: { operation: 'open_worktree', payload: { path: '/workspace/worktrees/topic' } } },
    ])
  })
})

describe('navide.git legacy repository selection port', () => {
  it('reads only the selected repository through the narrow Host action', async () => {
    const { sdk } = makeSdk()
    sdk.hostRequest = vi.fn(async (action, payload) => {
      expect(action).toBe('git.legacyRepoSelection')
      expect(payload).toEqual({})
      return { ok: true, payload: { selection: '/workspace/nested' }, error: null }
    }) as PluginCapabilitySdk['hostRequest']

    await expect(createPluginLegacyRepoSelectionPort(sdk).readLegacyRepoSelection())
      .resolves.toBe('/workspace/nested')
  })
})

describe('navide.git Host command port', () => {
  it('sends a fixed Host command through the narrow contribution action', async () => {
    const { sdk } = makeSdk()
    sdk.hostRequest = vi.fn(async () => ({ ok: true, payload: null, error: null }))

    await createPluginGitContributionHostPort(sdk).dispatch({
      operation: 'execute_host_command',
      command: 'workbench.action.openGitWindow',
    })

    expect(sdk.hostRequest).toHaveBeenCalledWith('git.contribution', {
      operation: 'execute_host_command',
      payload: { command: 'workbench.action.openGitWindow' },
    })
  })
})

describe('navide.git account port', () => {
  it('lists safe metadata and mutates only the Host-bound workspace account', async () => {
    const { sdk } = makeSdk()
    sdk.hostRequest = vi.fn(async (_action, request) => {
      const operation = request.operation
      if (operation === 'list') {
        return {
          ok: true,
          payload: {
            available: true,
            accounts: [{
              id: 'account-1', label: 'GitHub', host: 'github.com', username: 'octocat', tokenLast4: '1234',
            }],
          },
          error: null,
        }
      }
      if (operation === 'get_binding') {
        return { ok: true, payload: { accountId: 'account-1' }, error: null }
      }
      return { ok: true, payload: { ok: true }, error: null }
    }) as PluginCapabilitySdk['hostRequest']
    const port = createPluginGitAccountPort(sdk)

    await port.refresh()
    expect(port.accounts.value).toEqual([{
      id: 'account-1', label: 'GitHub', host: 'github.com', username: 'octocat', tokenLast4: '1234',
    }])
    await expect(port.getBinding()).resolves.toBe('account-1')
    await expect(port.addAccount({ label: 'Work', host: 'gitlab.com', username: 'me', token: 'secret' })).resolves.toBe(true)
    await expect(port.bind('account-1')).resolves.toBe(true)
    await expect(port.unbind()).resolves.toBe(true)

    expect(sdk.hostRequest).toHaveBeenCalledWith('git.account', {
      operation: 'get_binding', payload: {},
    })
    expect(sdk.hostRequest).toHaveBeenCalledWith('git.account', {
      operation: 'bind', payload: { accountId: 'account-1' },
    })
    expect(sdk.hostRequest).toHaveBeenCalledWith('git.account', {
      operation: 'unbind', payload: {},
    })
  })
})
