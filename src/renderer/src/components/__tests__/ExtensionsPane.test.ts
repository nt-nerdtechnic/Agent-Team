// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ExtensionsPane from '../ExtensionsPane.vue'

function mockPlugins(overrides: Record<string, unknown> = {}) {
  const api = {
    listInstalled: vi.fn().mockResolvedValue([
      { id: 'navide.mini-ide', requires: ['fs', 'git', 'terminal'], sensitive: ['fs', 'terminal'] },
    ]),
    listFactoryPackages: vi.fn().mockResolvedValue([]),
    restoreFactoryPackage: vi.fn().mockResolvedValue({ ok: true }),
    marketplaceSearch: vi.fn().mockResolvedValue({
      items: [
        {
          namespace: 'acme',
          name: 'demo',
          identity: 'acme.demo',
          display_name: 'Demo',
          description: null,
          categories: [],
          latest_version: '1.0.0',
          download_count: 0,
          rating_average: 0,
          featured: false,
        },
      ],
      total: 1,
      offset: 0,
      limit: 20,
    }),
    prepareInstall: vi
      .fn()
      .mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: [],
        containsBackendExecutable: false,
        requiresConfirmation: false,
      }),
    commitInstall: vi.fn().mockResolvedValue({ id: 'acme.demo', requires: [] }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: api }
  return api
}

describe('ExtensionsPane', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('renders the installed list with sensitive-capability badges', async () => {
    mockPlugins()
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    const row = wrapper.get('[data-id="navide.mini-ide"]')
    expect(row.text()).toContain('navide.mini-ide')
    expect(row.find('.ext-sensitive').exists()).toBe(true)
    expect(row.find('.ext-sensitive').text()).toContain('fs, terminal')
  })

  it('shows an opted-out bundled Git package and restores it explicitly', async () => {
    const listFactoryPackages = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'navide.git', version: '0.1.0', active: false, optedOut: true },
      ])
      .mockResolvedValueOnce([
        { id: 'navide.git', version: '0.1.0', active: true, optedOut: false },
      ])
    const api = mockPlugins({ listFactoryPackages })
    wrapper = mount(ExtensionsPane)
    await flushPromises()

    const row = wrapper.get('[data-factory-id="navide.git"]')
    expect(row.text()).toContain('Bundled Git')
    expect(row.text()).toContain('Removed')
    await row.get('.ext-restore').trigger('click')
    await flushPromises()

    expect(api.restoreFactoryPackage).toHaveBeenCalledWith('navide.git')
    expect(wrapper.get('[data-factory-id="navide.git"]').text()).toContain('Active')
  })

  it('shows an active factory Git package only in the Bundled section', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'navide.git',
          requires: ['fs', 'ui', 'shell'],
          sensitive: ['fs', 'shell'],
          provenance: 'factory-bundled',
        },
      ]),
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.git', version: '0.1.0', active: true, optedOut: false },
      ]),
    })
    wrapper = mount(ExtensionsPane)
    await flushPromises()

    expect(wrapper.get('[data-factory-id="navide.git"]').text()).toContain('Active')
    expect(wrapper.find('[data-id="navide.git"]').exists()).toBe(false)
  })

  it('shows and removes a backend-only package with no capabilities', async () => {
    const listInstalled = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'acme.backend', requires: [], sensitive: [] }])
      .mockResolvedValueOnce([])
    const api = mockPlugins({ listInstalled })
    wrapper = mount(ExtensionsPane)
    await flushPromises()

    expect(wrapper.get('[data-id="acme.backend"]').text()).toContain('acme.backend')
    await wrapper.get('[data-id="acme.backend"] .ext-remove').trigger('click')
    await flushPromises()

    expect(api.remove).toHaveBeenCalledWith('acme.backend')
    expect(wrapper.find('[data-id="acme.backend"]').exists()).toBe(false)
    expect(wrapper.get('.ext-empty').text()).toContain('No plugins installed')
  })

  it('searches the marketplace and installs a non-sensitive plugin directly', async () => {
    const api = mockPlugins()
    wrapper = mount(ExtensionsPane)
    await flushPromises()

    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-id="acme.demo"]').text()).toContain('Demo')

    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo' })
    // Non-sensitive → commit runs without a confirmation dialog.
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {})
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
  })

  it('gates a sensitive install behind a trust confirmation dialog', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()

    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()
    // Dialog is shown and nothing is committed yet.
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(true)
    expect(api.commitInstall).not.toHaveBeenCalled()

    await wrapper.get('.ext-confirm-risk').trigger('click')
    await flushPromises()
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {
      publisherConfirmed: false,
      riskConfirmed: true,
    })
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
  })

  it('keeps publisher consent separate from capability and backend risk approval', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        publisherId: 'acme',
        trustTier: 'signed-verified',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
        requiresPublisherTrust: true,
        requiresRiskConfirmation: true,
      }),
    })
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    expect(wrapper.get('.ext-publisher-risk').text()).toContain('acme')
    expect(api.commitInstall).not.toHaveBeenCalled()
    await wrapper.get('.ext-confirm-publisher').trigger('click')
    await flushPromises()
    expect(wrapper.find('.ext-backend-risk').exists()).toBe(false)
    expect(wrapper.text()).toContain('requests sensitive capabilities')
    expect(api.commitInstall).not.toHaveBeenCalled()

    await wrapper.get('.ext-confirm-risk').trigger('click')
    await flushPromises()
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {
      publisherConfirmed: true,
      riskConfirmed: true,
    })
  })

  it('keeps the Developer Mode local-unpacked warning visible in inventory', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'acme.local',
          requires: [],
          sensitive: [],
          provenance: 'developer-local-unpacked',
          warning: 'Unsigned local unpacked plugin — Developer Mode only',
        },
      ]),
    })
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    expect(wrapper.get('[data-id="acme.local"] .ext-dev-warning').text()).toContain(
      'Developer Mode only'
    )
  })

  it('shows an unsigned warning (never a verified badge) for an unsigned install', async () => {
    mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    const dialog = wrapper.get('.ext-trust-dialog')
    // Unsigned must surface the unsigned/unverified badge and NEVER the verified one.
    expect(dialog.find('.ext-unsigned').exists()).toBe(true)
    expect(dialog.find('.ext-verified').exists()).toBe(false)
    expect(dialog.find('.ext-unsigned').text()).toContain('not cryptographically verified')
  })

  it('shows a verified badge only for a signed-verified install', async () => {
    mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'signed-verified',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    const dialog = wrapper.get('.ext-trust-dialog')
    expect(dialog.find('.ext-verified').exists()).toBe(true)
    expect(dialog.find('.ext-unsigned').exists()).toBe(false)
  })

  it('cancelling the trust dialog does not install', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    await wrapper.get('.ext-cancel').trigger('click')
    await flushPromises()
    expect(api.commitInstall).not.toHaveBeenCalled()
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
  })

  it('warns about a backend executable even when permissions are empty', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'signed-verified',
        sensitive: [],
        containsBackendExecutable: true,
        requiresConfirmation: true,
      }),
    })
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    const dialog = wrapper.get('.ext-trust-dialog')
    expect(dialog.get('.ext-backend-risk').text()).toContain('native backend executable')
    expect(dialog.text()).not.toContain('requests sensitive capabilities')
    expect(api.commitInstall).not.toHaveBeenCalled()

    await dialog.get('.ext-confirm-risk').trigger('click')
    await flushPromises()
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {
      publisherConfirmed: false,
      riskConfirmed: true,
    })
  })

  it('removes an installed plugin', async () => {
    const api = mockPlugins()
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    await wrapper.get('[data-id="navide.mini-ide"] .ext-remove').trigger('click')
    await flushPromises()
    expect(api.remove).toHaveBeenCalledWith('navide.mini-ide')
  })
})
