// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const app = {
    use: vi.fn(),
    provide: vi.fn(),
    mount: vi.fn(),
  }
  return {
    app,
    createApp: vi.fn(() => app),
    initSettingsBackend: vi.fn(),
  }
})

vi.mock('vue', () => ({ createApp: state.createApp }))
vi.mock('@navide/plugin-ui', () => ({ createAiCliSessionController: vi.fn(() => ({})) }))
vi.mock('@navide/plugin-ui/foundation', () => ({ i18n: {} }))
vi.mock('@navide/plugin-ui/shared', () => ({
  initKeybindingsPort: vi.fn(),
  initSettingsBackend: state.initSettingsBackend,
  seedSettings: vi.fn(),
}))
vi.mock('./capabilityBackend', () => ({ useBackend: vi.fn(() => ({})) }))
vi.mock('./sdkGitTransport', () => ({ createPluginGitTransport: vi.fn(() => ({})) }))
vi.mock('./pluginSurfacePorts', () => ({
  createPluginCapabilitySdk: vi.fn(() => ({
    request: vi.fn(),
    status: { value: 'connected' },
    subscribe: vi.fn(() => () => undefined),
  })),
  createPluginKeybindingsPort: vi.fn(() => ({})),
  createPluginGitSurfacePorts: vi.fn(() => ({
    gitTransport: {}, fileAccess: {}, ui: {}, branchDiff: {}, accounts: {}, issues: {},
  })),
  createPluginGitContributionHostPort: vi.fn(() => ({})),
  createPluginGitWorkspaceGrantPort: vi.fn(() => ({})),
  createPluginGitSettingsPort: vi.fn(() => ({})),
  createPluginLegacyRepoSelectionPort: vi.fn(() => ({})),
}))
vi.mock('./GitWindowApp.vue', () => ({ default: {} }))
vi.mock('./GitLeftApp.vue', () => ({ default: {} }))

describe('Git plugin composition root', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>'
    Object.defineProperty(window, 'nav', {
      configurable: true,
      value: { ready: vi.fn() },
    })
  })

  it('mounts and announces readiness while the owned settings snapshot is pending', async () => {
    await import('./mount')
    await vi.waitFor(() => expect(state.initSettingsBackend).toHaveBeenCalledTimes(1))

    expect(state.createApp).toHaveBeenCalledTimes(1)
    expect(state.app.mount).toHaveBeenCalledWith('#app')
    expect((window as unknown as { nav?: { ready: ReturnType<typeof vi.fn> } }).nav?.ready)
      .toHaveBeenCalledTimes(1)
  })
})
