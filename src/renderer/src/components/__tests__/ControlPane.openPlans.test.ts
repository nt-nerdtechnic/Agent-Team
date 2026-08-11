// @vitest-environment happy-dom
// The Plans surface is now a first-class sidebar tab (📋 in the icon rail) that
// renders the embedded PlanPane inside the narrow sidebar — there is no longer a
// pop-out button in the Pipelines header. These tests cover the tab button and
// the sidebar branch that mounts PlanPane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

const minimalProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
  autoAnswerEnabled: false,
  existingProject: null
} as unknown as Record<string, unknown>

// Minimal backend so the Explorer/Git/Plans child panes (all `v-if="backend"`)
// can mount as stubs under shallowMount.
const fakeBackend = {
  status: { value: 'connected' },
  send: vi.fn(async () => ({ payload: {} })),
  on: vi.fn(() => () => {})
} as unknown as Record<string, unknown>

describe('ControlPane – Plans sidebar tab', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: { ...minimalProps, backend: fakeBackend, workspace: '/tmp/ws' },
      global: { mocks: { $t: (key: string) => key } }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
  })

  it('no longer renders the pop-out plans button in the Pipelines header', () => {
    expect(wrapper.find('.plans-btn').exists()).toBe(false)
  })

  it('renders a Plans tab button in the sidebar icon rail', () => {
    const btns = wrapper.findAll('.sidebar-tabs .tab-btn')
    // agents, pipeline, explorer, git, plans
    expect(btns).toHaveLength(5)
    expect(btns[4].attributes('title')).toContain('Plans')
  })

  it('mounts PlanPane in the sidebar when the Plans tab is picked', async () => {
    // Pipeline tab: no PlanPane yet.
    expect(wrapper.find('.plans-split').exists()).toBe(false)
    await wrapper.findAll('.sidebar-tabs .tab-btn')[4].trigger('click')
    await wrapper.vm.$nextTick()
    // Plans now live in-sidebar; the mounted PlanPane is the observable effect
    // (the tab no longer emits update:sidebar-tab — App.vue does not consume it).
    expect(wrapper.find('.plans-split').exists()).toBe(true)
  })
})
