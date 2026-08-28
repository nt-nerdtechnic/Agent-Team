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

const URL_A = 'file:///pkg/index.html?workspace_path=/ws&v2=1&nv_guest=tok-a'
const URL_B = 'file:///pkg/index.html?workspace_path=/other&v2=1&nv_guest=tok-b'

function stubPlugins(prepare: ReturnType<typeof vi.fn>) {
  const closeContribution = vi.fn(async () => ({ ok: true }))
  const openContribution = vi.fn(async () => ({ ok: true }))
  const updateContribution = vi.fn(async () => ({ ok: true }))
  const hostThemeChanged = vi.fn()
  window.agentTeam = {
    plugins: {
      prepareContribution: prepare,
      closeContribution,
      openContribution,
      updateContribution,
      hostThemeChanged,
    },
  } as unknown as typeof window.agentTeam
  return { closeContribution, openContribution, updateContribution, hostThemeChanged }
}

describe('PluginRegionHost', () => {
  let originalAgentTeam: typeof window.agentTeam

  beforeEach(() => {
    originalAgentTeam = window.agentTeam
    document.documentElement.setAttribute('data-theme', 'dark-github')
  })

  afterEach(() => {
    window.agentTeam = originalAgentTeam
    vi.restoreAllMocks()
  })

  it('asks the Host by contribution key and never handles an instance id', async () => {
    const prepare = vi.fn(async () => ({ ok: true, url: URL_A }))
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()

    expect(prepare).toHaveBeenCalledWith({
      contributionKey: 'acme.files.left',
      workspace_path: '/ws',
      // A guest is its own document: it cannot inherit our CSS variables, so the
      // theme we are actually rendering with travels with the request.
      theme: 'dark-github',
    })
    // The renderer receives a URL with an opaque token — never an instance id.
    const view = wrapper.find('webview')
    expect(view.exists()).toBe(true)
    expect(view.attributes('src')).toBe(URL_A)
    expect(JSON.stringify(prepare.mock.calls)).not.toContain('instance')
    wrapper.unmount()
  })

  it('leaves geometry to CSS: no bounds are mirrored to the Host', async () => {
    const prepare = vi.fn(async () => ({ ok: true, url: URL_A }))
    const { openContribution, updateContribution } = stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()

    expect(openContribution).not.toHaveBeenCalled()
    expect(updateContribution).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps the guest in the DOM while its tab is hidden', async () => {
    const prepare = vi.fn(async () => ({ ok: true, url: URL_A }))
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()

    await wrapper.setProps({ visible: false })
    await flushPromises()

    // Hidden through `display: none`, which keeps the guest's webContents alive
    // so a background contribution can still push updates (Git's changes badge).
    expect(wrapper.find('webview').exists()).toBe(true)
    expect(wrapper.element.getAttribute('style')).toContain('display: none')
    // Not re-prepared: the same guest is reused across visibility changes.
    expect(prepare).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('re-prepares against the new workspace when it changes', async () => {
    const prepare = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, url: URL_A })
      .mockResolvedValueOnce({ ok: true, url: URL_B })
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()

    await wrapper.setProps({ workspacePath: '/other' })
    await flushPromises()

    expect(prepare).toHaveBeenLastCalledWith({
      contributionKey: 'acme.files.left',
      workspace_path: '/other',
      theme: 'dark-github',
    })
    expect(wrapper.find('webview').attributes('src')).toBe(URL_B)
    wrapper.unmount()
  })

  it('shows the unavailable state when the Host refuses to prepare', async () => {
    const prepare = vi.fn(async () => ({ ok: false, error: 'grant is missing' }))
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()

    expect(wrapper.find('webview').exists()).toBe(false)
    expect(wrapper.text()).toContain('unavailable')
    wrapper.unmount()
  })

  it('drops a prepare that resolves after the workspace moved on', async () => {
    type PrepareResult = { ok: boolean; url: string }
    let resolveFirst!: (value: PrepareResult) => void
    const stalled = new Promise<PrepareResult>((resolve) => { resolveFirst = resolve })
    const prepare = vi
      .fn()
      .mockImplementationOnce(() => stalled)
      .mockResolvedValueOnce({ ok: true, url: URL_B })
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await wrapper.setProps({ workspacePath: '/other' })
    await flushPromises()
    // The stale request lands last; it must not overwrite the current guest.
    resolveFirst({ ok: true, url: URL_A })
    await flushPromises()

    expect(wrapper.find('webview').attributes('src')).toBe(URL_B)
    wrapper.unmount()
  })

  it('clears the Host registry entry on unmount', async () => {
    const prepare = vi.fn(async () => ({ ok: true, url: URL_A }))
    const { closeContribution } = stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()
    wrapper.unmount()
    await flushPromises()

    expect(closeContribution).toHaveBeenCalledWith({ contributionKey: 'acme.files.left' })
  })

  it('re-asserts the theme once the guest exists, then follows every switch', async () => {
    const prepare = vi.fn(async () => ({ ok: true, url: URL_A }))
    const { hostThemeChanged } = stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()

    // The entry query is only a first-paint hint; this window adopts its stored
    // theme during boot and adopting is not a change, so a guest that mounted
    // mid-adoption would otherwise keep the wrong theme forever.
    expect(hostThemeChanged).toHaveBeenCalledWith('dark-github')

    hostThemeChanged.mockClear()
    document.documentElement.setAttribute('data-theme', 'light')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hostThemeChanged).toHaveBeenCalledWith('light')

    wrapper.unmount()
    hostThemeChanged.mockClear()
    document.documentElement.setAttribute('data-theme', 'dark-github')
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The observer is disconnected with the component.
    expect(hostThemeChanged).not.toHaveBeenCalled()
  })
})
