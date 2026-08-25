// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// The ＋ on the workspace heading opens a menu of CLIs. It is a second door
// onto the spawn card's own pickedAgent/pickedRole, NOT a second copy of them:
// two stores would let the card say Codex while ＋ opens Claude.

const specs = [
  { agentKey: 'claude', label: 'Claude Code' },
  { agentKey: 'codex', label: 'Codex' },
  { agentKey: 'terminal', label: 'Terminal' } // filtered out of manual spawn
]

// The list only renders once there is at least one pane — with none, the
// section shows its empty state and the heading never appears.
const localPanes = [
  {
    id: 'p1', agentLabel: 'Claude', status: 'running', command: 'claude',
    origin: 'manual', isMinimized: false, isCommander: false
  }
]

const workspaceRow = {
  path: '/Users/me/Desktop/Agent-Team',
  label: 'Agent-Team',
  displayPath: '~/Desktop/Agent-Team',
  isCurrent: true,
  collapsed: false,
  count: 1,
  lineage: [],
  remote: []
}

/** A backend whose onboarding.status reports the given CLIs as missing. */
function backendWithMissing(missing: string[]): Record<string, unknown> {
  return {
    send: vi.fn().mockResolvedValue({
      payload: {
        deps: missing.map((id) => ({ id, group: 'agent_cli', status: 'missing' }))
      }
    })
  }
}

function mountWith(extra: Record<string, unknown> = {}): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    attachTo: document.body,
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      backend: backendWithMissing([]),
      agentSpecs: specs,
      roles: [{ key: 'reviewer', label: 'Reviewer' }],
      stages: [],
      panes: localPanes,
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: {
        available: false,
        version: '',
        defaultModel: '',
        models: [],
        benchmarkResults: []
      },
      autoAnswerEnabled: false,
      // canSpawn needs a workspace; the ＋ is disabled without one.
      workspace: '/Users/me/Desktop/Agent-Team',
      existingProject: null,
      workspaces: [workspaceRow],
      ...extra
    } as never,
    global: { mocks: { $t: (key: string) => key } }
  })
}

async function openMenu(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.ws-add').trigger('click')
}

describe('ControlPane – the ＋ menu', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper?.unmount())

  it('lists every manual-spawn CLI, with the current one ticked', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    const opts = wrapper.findAll('.ws-add-scroll .ws-add-opt')
    // "terminal" is not a manual-spawn agent; it must not appear.
    expect(opts.map((o) => o.text())).toEqual(['✓Claude Code', 'Codex'])
    expect(opts[0].classes()).toContain('on')
  })

  it('opens the CLI that was clicked, not the one the card had', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[1].trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({ agentKey: 'codex' })
  })

  it('writes the pick back to the card so the two never disagree', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[1].trigger('click')
    // Reopen the menu, go into the full dialog, and read its dropdown.
    await openMenu(wrapper)
    await wrapper.find('.ws-add-more').trigger('click')
    expect((wrapper.find('.spawn-card-body select').element as HTMLSelectElement).value).toBe('codex')
  })

  it('carries the role the menu has selected', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-role').setValue('reviewer')
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[0].trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({ roleKey: 'reviewer' })
  })

  it('offers the guided install for a CLI that is not there', async () => {
    // Spawning it would only produce a pane that dies with 127.
    wrapper = mountWith({ backend: backendWithMissing(['codex']) })
    await new Promise((r) => setTimeout(r, 0)) // let the status fetch settle
    await openMenu(wrapper)
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[1].trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('spawn')).toBeUndefined()
    expect(wrapper.emitted('install-cli')?.[0]?.[0]).toMatchObject({ agentKey: 'codex' })
  })

  it('closes on Escape', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    expect(wrapper.find('.ws-add-menu').exists()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('closes when you click away, but not when you click inside it', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-menu').trigger('click')
    expect(wrapper.find('.ws-add-menu').exists()).toBe(true)
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('closes when the list scrolls out from under it', async () => {
    // The menu is positioned at a point measured from the button; scrolling
    // the pane list would leave it hanging over whatever took that place.
    wrapper = mountWith()
    await openMenu(wrapper)
    document.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('closes after a spawn', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[0].trigger('click')
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('the last row opens the full card instead of spawning', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-more').trigger('click')
    expect(wrapper.emitted('spawn')).toBeUndefined()
    expect(wrapper.find('.spawn-card-body').exists()).toBe(true)
  })

  it('does not open while there is nothing to spawn into', async () => {
    wrapper = mountWith({ backendStatus: 'disconnected' })
    await openMenu(wrapper)
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('leaves every spawn-card control intact inside the dialog', async () => {
    // Manual spawn became a dialog; it must not have lost a control on the way.
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-more').trigger('click')
    const body = wrapper.find('.spawn-card-body')
    expect(body.findAll('select')).toHaveLength(2)      // CLI + role
    expect(body.find('.terminal-btn').exists()).toBe(true)
    expect(body.find('.resume-btn').exists()).toBe(true)
    expect(body.find('.resume-input').exists()).toBe(true)
  })

  it('the dialog is not in the sidebar until something opens it', () => {
    // The old card sat in the list all day whether or not it was wanted.
    wrapper = mountWith()
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(false)
    expect(wrapper.find('.spawn-card').exists()).toBe(false)
  })

  it('does not open itself on a spawn-mode workspace', async () => {
    // As a card, spawn mode opened it expanded. As a dialog that same default
    // puts it over the app at startup, unasked.
    wrapper = mountWith({ mode: 'spawn' })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(false)
    // Nor when the mode changes under it.
    await wrapper.setProps({ mode: 'pipeline' } as never)
    await wrapper.setProps({ mode: 'spawn' } as never)
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(false)
  })

  it('closes on Escape, the close button, and a click on the backdrop', async () => {
    wrapper = mountWith()

    const open = async (): Promise<void> => {
      await openMenu(wrapper)
      await wrapper.find('.ws-add-more').trigger('click')
      expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(true)
    }

    await open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(false)

    await open()
    await wrapper.find('.spawn-modal-close').trigger('click')
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(false)

    await open()
    // .self — clicking the card inside it must NOT close the dialog.
    await wrapper.find('.spawn-card--modal').trigger('click')
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(true)
    await wrapper.find('.spawn-modal-backdrop').trigger('click')
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(false)
  })
})
