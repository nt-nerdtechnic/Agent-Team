// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
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

  it('renders only left contributions and keeps the Host catalog order', () => {
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
    expect(wrapper.findComponent({ name: 'PluginRegionHost' }).exists()).toBe(false)
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
    wrapper.unmount()
  })
})
