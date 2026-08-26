// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import PluginRegionHost, { type PluginRegionContribution } from '../PluginRegionHost.vue'

const contribution: PluginRegionContribution = {
  pluginId: 'acme.files',
  packageVersion: '1.0.0',
  contributionKey: 'acme.files.left',
  title: 'Files',
  icon: null,
  kind: 'custom',
  location: 'left',
  manifestOrder: 0,
}

describe('PluginRegionHost', () => {
  let originalAgentTeam: typeof window.agentTeam
  let originalRect: PropertyDescriptor | undefined
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined
  let resizeCallback: (() => void) | undefined

  beforeEach(() => {
    originalAgentTeam = window.agentTeam
    originalResizeObserver = globalThis.ResizeObserver
    originalRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ x: 10, y: 20, width: 300, height: 400, top: 20, left: 10 }),
    })
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = () => callback([], this as unknown as ResizeObserver)
      }
      observe = vi.fn()
      disconnect = vi.fn()
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: FakeResizeObserver })
  })

  afterEach(() => {
    window.agentTeam = originalAgentTeam
    if (originalResizeObserver) Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: originalResizeObserver })
    else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    if (originalRect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', originalRect)
    else delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect
  })

  it('opens by contribution key and never exposes an instance id to the renderer', async () => {
    const openContribution = vi.fn().mockResolvedValue({ ok: true })
    const updateContribution = vi.fn().mockResolvedValue({ ok: true })
    const closeContribution = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = { plugins: { openContribution, updateContribution, closeContribution } } as unknown as typeof window.agentTeam

    const wrapper = mount(PluginRegionHost, { props: { contribution, workspacePath: '/workspace', visible: true } })
    await flushPromises()
    expect(openContribution).toHaveBeenCalledWith({
      contributionKey: 'acme.files.left',
      workspace_path: '/workspace',
      bounds: { x: 10, y: 20, width: 300, height: 400 },
    })
    expect(openContribution.mock.calls[0][0]).not.toHaveProperty('instanceId')

    resizeCallback?.()
    await flushPromises()
    expect(updateContribution).toHaveBeenCalled()
    wrapper.unmount()
    await flushPromises()
    expect(closeContribution).toHaveBeenCalledWith({ contributionKey: 'acme.files.left' })
  })

  it('closes a view when unmount races an in-flight open', async () => {
    let resolveOpen: ((value: { ok: boolean }) => void) | undefined
    const openContribution = vi.fn().mockImplementation(
      () => new Promise<{ ok: boolean }>((resolve) => { resolveOpen = resolve }),
    )
    const closeContribution = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = { plugins: { openContribution, closeContribution } } as unknown as typeof window.agentTeam

    const wrapper = mount(PluginRegionHost, { props: { contribution, workspacePath: '/workspace', visible: true } })
    await flushPromises()
    expect(openContribution).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    resolveOpen?.({ ok: true })
    await flushPromises()

    expect(closeContribution).toHaveBeenCalledWith({ contributionKey: 'acme.files.left' })
  })
})
