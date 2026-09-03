// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

const baseProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: {},
  autoAnswerEnabled: false,
  existingProject: null,
}

const contribution = (overrides: Record<string, unknown> = {}) => ({
  pluginId: 'acme.files',
  packageVersion: '1.0.0',
  contributionKey: 'acme.files.left',
  title: 'Files',
  icon: null,
  kind: 'custom' as const,
  location: 'left' as const,
  manifestOrder: 0,
  ...overrides,
})

function mountPane(
  pluginContributions?: unknown[],
  overrides: Record<string, unknown> = {},
): VueWrapper {
  return shallowMount(ControlPane, {
    props: {
      ...baseProps,
      ...(pluginContributions === undefined ? {} : { pluginContributions }),
      ...overrides,
    } as never,
    global: { mocks: { $t: (key: string) => key } },
  })
}

describe('ControlPane manifest-driven plugin placement', () => {
  afterEach(() => sessionStorage.clear())

  it('renders no plugin tab when the Host catalog is empty', () => {
    const wrapper = mountPane([])
    expect(wrapper.findAll('.plugin-tab-btn')).toHaveLength(0)
    expect(wrapper.findComponent({ name: 'PluginRegionHost' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders only left contributions, keeps Host order, and toggles visibility without unmounting', async () => {
    const wrapper = mountPane([
      contribution({ contributionKey: 'zeta.left', pluginId: 'zeta.plugin', manifestOrder: 1 }),
      contribution({ contributionKey: 'acme.window', pluginId: 'acme.plugin', location: 'window' }),
      contribution({ contributionKey: 'acme.left', pluginId: 'acme.plugin' }),
    ])
    const tabs = wrapper.findAll('.plugin-tab-btn')
    expect(tabs).toHaveLength(2)
    expect(tabs.map((tab) => tab.attributes('data-plugin-contribution'))).toEqual([
      'zeta.left',
      'acme.left',
    ])
    const hosts = wrapper.findAllComponents({ name: 'PluginRegionHost' })
    expect(hosts).toHaveLength(2)
    expect(hosts.map((host) => host.props('contribution').contributionKey)).toEqual([
      'zeta.left',
      'acme.left',
    ])
    expect(hosts.every((host) => host.props('visible') === false)).toBe(true)

    await tabs[1].trigger('click')
    await wrapper.vm.$nextTick()
    const toggledHosts = wrapper.findAllComponents({ name: 'PluginRegionHost' })
    expect(toggledHosts).toHaveLength(2)
    expect(toggledHosts.map((host) => host.props('visible'))).toEqual([false, true])
    wrapper.unmount()
  })

  it('hides an active plugin view when the sidebar collapses without unmounting it', async () => {
    const wrapper = mountPane([contribution()])
    await wrapper.get('.plugin-tab-btn').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.findAllComponents({ name: 'PluginRegionHost' })).toHaveLength(1)
    expect(wrapper.getComponent({ name: 'PluginRegionHost' }).props('visible')).toBe(true)

    await wrapper.setProps({ collapsed: true })
    await wrapper.vm.$nextTick()

    expect(wrapper.findAllComponents({ name: 'PluginRegionHost' })).toHaveLength(1)
    expect(wrapper.getComponent({ name: 'PluginRegionHost' }).props('visible')).toBe(false)
    wrapper.unmount()
  })

  it('renders a catalog icon at the fixed sidebar size', () => {
    const wrapper = mountPane([
      contribution({ icon: 'data:image/png;base64,icon-data' }),
    ])

    const icon = wrapper.get('.plugin-tab-icon')
    expect(icon.element.tagName).toBe('IMG')
    expect(icon.attributes('src')).toBe('data:image/png;base64,icon-data')
    // Deliberately under the 18px of the SVGs beside it: those carry padding
    // inside their viewBox, plugin artwork fills its bitmap, so equal boxes
    // make the plugin icon the largest thing in the rail.
    expect(icon.attributes('width')).toBe('15')
    expect(icon.attributes('height')).toBe('15')
    expect(icon.attributes('alt')).toBe('')
    wrapper.unmount()
  })

  it('uses the generic fallback when a contribution has no icon', () => {
    const wrapper = mountPane([contribution()])

    expect(wrapper.get('.plugin-tab-fallback').text()).toBe('◇')
    expect(wrapper.find('.plugin-tab-icon').exists()).toBe(false)
    wrapper.unmount()
  })

  it('uses the generic fallback when a catalog icon fails to load', async () => {
    const wrapper = mountPane([
      contribution({ icon: 'data:image/png;base64,broken-icon' }),
    ])

    await wrapper.get('.plugin-tab-icon').trigger('error')

    expect(wrapper.get('.plugin-tab-fallback').text()).toBe('◇')
    expect(wrapper.find('.plugin-tab-icon').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not render the legacy Git tab in normal mode', () => {
    const wrapper = mountPane([])
    expect(wrapper.find('[data-legacy-git-tab]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'GitPluginHostSlot' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders the legacy Git tab and host slot only in recovery mode', async () => {
    const wrapper = mountPane([], {
      backend: { status: { value: 'connected' } },
      workspace: '/workspace',
      legacyGitRecovery: true,
    })

    const tab = wrapper.find('[data-legacy-git-tab]')
    expect(tab.exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'GitPluginHostSlot' }).exists()).toBe(false)

    await tab.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent({ name: 'GitPluginHostSlot' }).exists()).toBe(true)
    expect(wrapper.get('[data-legacy-recovery-label]').text()).toBe('Legacy recovery')
    wrapper.unmount()
  })

  it('asks the Host to retry v2 when Git is opened in recovery, then lands on the restored tab', async () => {
    const retryGitV2 = vi.fn().mockResolvedValue({ ok: true })
    Object.assign(window, { agentTeam: { retryGitV2 } })
    const wrapper = mountPane([], {
      backend: { status: { value: 'connected' } },
      workspace: '/workspace',
      legacyGitRecovery: true,
    })

    await wrapper.get('[data-legacy-git-tab]').trigger('click')
    expect(retryGitV2).toHaveBeenCalledTimes(1)

    // The Host answers in two steps: recovery clears first, the refreshed
    // contribution catalog arrives after. Bouncing to Agents in between would
    // drop the user somewhere they never asked for.
    await wrapper.setProps({ legacyGitRecovery: false } as never)
    expect(sessionStorage.getItem('agentTeam.sidebarTab')).toBe('git')

    await wrapper.setProps({
      pluginContributions: [contribution({
        pluginId: 'navide.git',
        contributionKey: 'navide.git.left',
        title: 'Git',
      })],
    } as never)
    expect(sessionStorage.getItem('agentTeam.sidebarTab')).toBe('plugin:navide.git.left')

    Reflect.deleteProperty(window, 'agentTeam')
    wrapper.unmount()
  })

  it('leaves recovery for Agents when the exit was not a retry we asked for', async () => {
    const wrapper = mountPane([], {
      backend: { status: { value: 'connected' } },
      workspace: '/workspace',
      legacyGitRecovery: true,
    })
    await wrapper.get('[data-legacy-git-tab]').trigger('click')
    expect(sessionStorage.getItem('agentTeam.sidebarTab')).toBe('git')

    await wrapper.setProps({ legacyGitRecovery: false } as never)
    expect(sessionStorage.getItem('agentTeam.sidebarTab')).toBe('agents')
    wrapper.unmount()
  })

  it('renders navide.git in the fixed Git slot with its change badge', () => {
    const wrapper = mountPane([
      contribution({
        pluginId: 'navide.git',
        contributionKey: 'navide.git.left',
        title: 'Git',
        icon: 'data:image/png;base64,git-icon',
      }),
    ], { gitChangesCount: 7 })

    const tab = wrapper.get('[data-plugin-contribution="navide.git.left"]')
    expect(tab.attributes('title')).toContain('⌘4')
    expect(tab.get('.git-badge').text()).toBe('7')
    wrapper.unmount()
  })

  it('hosts navide.git in PluginRegionHost, keeps it mounted when off-tab, and shows change badge', async () => {
    const gitContrib = contribution({
      pluginId: 'navide.git',
      contributionKey: 'navide.git.left',
      title: 'Git',
      icon: 'data:image/png;base64,git-icon',
    })
    const wrapper = mountPane([gitContrib], { gitChangesCount: 7 })

    const tab = wrapper.get('[data-plugin-contribution="navide.git.left"]')
    expect(tab.attributes('title')).toContain('⌘4')
    expect(tab.get('.git-badge').text()).toBe('7')

    const findGitHost = () =>
      wrapper.findAllComponents({ name: 'PluginRegionHost' })
        .find((h) => h.props('contribution')?.contributionKey === 'navide.git.left')

    let host = findGitHost()
    expect(host).toBeDefined()
    expect(host!.props('visible')).toBe(false)

    await tab.trigger('click')
    await wrapper.vm.$nextTick()
    host = findGitHost()
    expect(host).toBeDefined()
    expect(host!.props('visible')).toBe(true)

    const agentsTab = wrapper.findAll('.sidebar-tabs .tab-btn')[0]
    await agentsTab.trigger('click')
    await wrapper.vm.$nextTick()
    host = findGitHost()
    expect(host).toBeDefined()
    expect(host!.props('visible')).toBe(false)

    wrapper.unmount()
  })
})
