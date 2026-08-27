// @vitest-environment happy-dom
// Plans stays on its bundled Host-owned tab until the B6 production migration
// moves it to a Manifest v2 contribution.
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
  existingProject: null,
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

  it('renders the retained Plans tab in the sidebar icon rail', () => {
    const btns = wrapper.findAll('.sidebar-tabs .tab-btn')
    // agents, pipeline, explorer, retained Plans
    expect(btns).toHaveLength(4)
    expect(btns[3].attributes('title')).toContain('Plans')
  })

  it('mounts the retained PlanPane when the Plans tab is picked', async () => {
    expect(wrapper.findComponent({ name: 'PlanPane' }).exists()).toBe(false)
    await wrapper.findAll('.sidebar-tabs .tab-btn')[3].trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent({ name: 'PlanPane' }).exists()).toBe(true)
  })
})
