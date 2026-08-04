// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'

function statusWith(missing: string[]): Record<string, unknown> {
  return {
    deps: [
      { id: 'claude', group: 'agent_cli', status: missing.includes('claude') ? 'missing' : 'ok' },
      { id: 'qwen', group: 'agent_cli', status: missing.includes('qwen') ? 'missing' : 'ok' },
    ],
  }
}

function props(mock: ReturnType<typeof createMockBackend>): Record<string, unknown> {
  return {
    backend: mock.backend,
    backendStatus: 'connected',
    backendUrl: '',
    workspace: '/tmp/ws',
    agentSpecs: [
      { agentKey: 'claude', label: 'Claude Code' },
      { agentKey: 'qwen', label: 'Qwen Code' },
    ],
    roles: [],
    stages: [],
    panes: [],
    pipeline: { state: 'idle' },
    yoloEnabled: false,
    analyzerModel: '',
    analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
    autoAnswerEnabled: false,
    existingProject: null,
    canRebuildAll: false,
    rebuildingAll: false,
  } as unknown as Record<string, unknown>
}

describe('ControlPane — spawning a CLI that is not installed', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    sessionStorage.clear()
  })

  async function mountPane(missing: string[]): Promise<{
    wrapper: VueWrapper
    mock: ReturnType<typeof createMockBackend>
  }> {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', statusWith(missing))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = shallowMount(ControlPane as any, {
      props: props(mock),
      global: { mocks: { $t: (key: string) => key } },
    })
    await flushPromises()
    return { wrapper: w, mock }
  }

  it('offers the guided install instead of spawning a pane that dies with 127', async () => {
    const mounted = await mountPane(['claude'])
    wrapper = mounted.wrapper
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(wrapper.vm as any).pickedAgent = 'claude'
    await flushPromises()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(wrapper.vm as any).spawn()
    await flushPromises()

    expect(wrapper.emitted('spawn')).toBeUndefined()
    expect(wrapper.emitted('install-cli')?.[0]).toEqual([
      { agentKey: 'claude', label: 'Claude Code' },
    ])
  })

  it('spawns normally when the CLI is installed', async () => {
    const mounted = await mountPane([])
    wrapper = mounted.wrapper
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(wrapper.vm as any).spawn()
    await flushPromises()

    expect(wrapper.emitted('install-cli')).toBeUndefined()
    expect(wrapper.emitted('spawn')).toHaveLength(1)
  })

  it('re-detects before offering the install, so a just-finished install still spawns', async () => {
    // The dropdown status is cached for 10s; without the re-detect the user
    // would be shown the install dialog for a CLI they had just installed.
    const mounted = await mountPane(['claude'])
    wrapper = mounted.wrapper
    mounted.mock.setResponse('onboarding.status', statusWith([]))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(wrapper.vm as any).spawn()
    await flushPromises()

    expect(wrapper.emitted('install-cli')).toBeUndefined()
    expect(wrapper.emitted('spawn')).toHaveLength(1)
  })
})
