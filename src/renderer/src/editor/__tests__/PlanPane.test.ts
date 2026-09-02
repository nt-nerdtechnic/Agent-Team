// @vitest-environment happy-dom
// The main-window Plans tab is now a browse-only list: PlanPane wraps PlansPane
// and, when a plan is clicked, pops out the wide plan window (PlanWindowApp)
// with the plan carried in the call — it no longer drills down in place. These
// tests cover that PlanPane mounts the list for its workspace prop and forwards
// clicks to window.agentTeam.openPlansWindow with the rel_path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import PlanPane from '../PlanPane.vue'
import { i18n } from '@navide/plugin-ui/foundation'

i18n.global.locale.value = 'en-US'

const plansPaneSpies = vi.hoisted(() => ({ closeActiveOverlay: vi.fn(() => false) }))

// Stub PlansPane so a test can drive its open-file emit directly.
vi.mock('../PlansPane.vue', () => ({
  __esModule: true,
  default: defineComponent({
    name: 'PlansPane',
    props: ['workspacePath', 'backend'],
    inheritAttrs: false,
    setup(_, { expose }) {
      expose(plansPaneSpies)
      return () => h('div', { class: 'stub-PlansPane' })
    },
  }),
}))

const fakeBackend = { on: vi.fn(() => () => {}), send: vi.fn() }

const mountedApps: VueWrapper[] = []
async function mountApp(workspacePath = '/tmp/demo-ws'): Promise<VueWrapper> {
  const wrapper = mount(PlanPane, {
    props: { workspacePath, backend: fakeBackend as never },
    global: { plugins: [i18n] },
  })
  mountedApps.push(wrapper)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  plansPaneSpies.closeActiveOverlay.mockReset().mockReturnValue(false)
  ;(window as unknown as { agentTeam?: unknown }).agentTeam = {
    openPlansWindow: vi.fn(async () => ({ ok: true })),
    projectLegacyPlansPreferences: vi.fn(async () => ({ ok: true })),
  }
})

afterEach(() => {
  while (mountedApps.length) mountedApps.pop()!.unmount()
  delete (window as unknown as { agentTeam?: unknown }).agentTeam
})

describe('PlanPane', () => {
  it('mounts PlansPane for the workspace prop (browse-only, no in-place doc view)', async () => {
    const wrapper = await mountApp()
    const pane = wrapper.findComponent({ name: 'PlansPane' })
    expect(pane.exists()).toBe(true)
    expect(pane.props('workspacePath')).toBe('/tmp/demo-ws')
    // No drill-down surface: the doc view / back bar are gone entirely.
    expect(wrapper.find('.plan-pane-doc-view').exists()).toBe(false)
    expect(wrapper.find('.plan-pane-back').exists()).toBe(false)
  })

  it('pops out the wide plan window with the clicked plan instead of drilling down', async () => {
    const wrapper = await mountApp()
    wrapper
      .findComponent({ name: 'PlansPane' })
      .vm.$emit('open-file', { filepath: '.agent-team/plans/feature_a1b2c3.html', name: 'feature_a1b2c3.html' })
    await flushPromises()

    const openPlansWindow = (window as unknown as { agentTeam: { openPlansWindow: ReturnType<typeof vi.fn> } })
      .agentTeam.openPlansWindow
    expect(openPlansWindow).toHaveBeenCalledWith({
      workspace_path: '/tmp/demo-ws',
      rel_path: '.agent-team/plans/feature_a1b2c3.html',
    })
    // The doc view never appears in the sidebar.
    expect(wrapper.find('.plan-pane-doc-view').exists()).toBe(false)
  })

  it('hands the window the root the rel_path is relative to', async () => {
    // Workspace opened on a subdirectory of the repository holding the plans:
    // the list resolved up to the repository, so the window must be launched
    // there or it would resolve the path against a directory it is not under.
    const wrapper = await mountApp()
    wrapper.findComponent({ name: 'PlansPane' }).vm.$emit('open-file', {
      filepath: '.agent-team/plans/feature_a1b2c3.html',
      name: 'feature_a1b2c3.html',
      root: '/tmp/repo',
    })
    await flushPromises()

    const openPlansWindow = (window as unknown as { agentTeam: { openPlansWindow: ReturnType<typeof vi.fn> } })
      .agentTeam.openPlansWindow
    expect(openPlansWindow).toHaveBeenCalledWith({
      workspace_path: '/tmp/repo',
      rel_path: '.agent-team/plans/feature_a1b2c3.html',
    })
    const projectLegacyPlansPreferences = (window as unknown as {
      agentTeam: { projectLegacyPlansPreferences: ReturnType<typeof vi.fn> }
    }).agentTeam.projectLegacyPlansPreferences
    expect(projectLegacyPlansPreferences).toHaveBeenCalledWith({
      workspace_path: '/tmp/demo-ws',
      values: {},
    })
  })

  it('forwards markdown plan clicks the same way', async () => {
    const wrapper = await mountApp()
    wrapper
      .findComponent({ name: 'PlansPane' })
      .vm.$emit('open-file', { filepath: '.cursor/plans/feature.plan.md', name: 'feature.plan.md' })
    await flushPromises()

    const openPlansWindow = (window as unknown as { agentTeam: { openPlansWindow: ReturnType<typeof vi.fn> } })
      .agentTeam.openPlansWindow
    expect(openPlansWindow).toHaveBeenCalledWith({
      workspace_path: '/tmp/demo-ws',
      rel_path: '.cursor/plans/feature.plan.md',
    })
  })

  it('closes the plan list overlay on ESC (list-related, never closes a window)', async () => {
    plansPaneSpies.closeActiveOverlay.mockReturnValue(true)
    await mountApp()
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(ev)
    expect(plansPaneSpies.closeActiveOverlay).toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(true)
  })
})
