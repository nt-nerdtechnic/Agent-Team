// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_HOST_READ_ONLY_KEYS,
  GIT_USER_PREFERENCE_KEYS,
  GIT_WORKSPACE_REPOSITORY_KEY,
} from '#git-feature'
import type { PortResponse } from '@navide/plugin-ui-vue/shared'
import {
  createPluginGitSettingsPort,
  createPluginGitWorkspaceGrantPort,
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

    expect(hostRequests).toEqual([
      { action: 'git.contribution', payload: { operation: 'pick_workspace', payload: { default_path: '/default' } } },
      { action: 'git.contribution', payload: { operation: 'open_workspace', payload: { path: '/cloned/repo', grant: 'derived-grant' } } },
    ])
  })
})
