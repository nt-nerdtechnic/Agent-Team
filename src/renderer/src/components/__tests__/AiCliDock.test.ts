// @vitest-environment happy-dom
// AiCliDock — the shared right-side CLI agent terminal shell (rail toggle +
// resize + agent picker + Start/Interrupt/Stop + lazily mounted PTY terminal)
// used by the Pipeline Manager and Plan windows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick, ref, type Ref } from 'vue'
import { i18n } from '../../i18n'
import { CLI_AGENT_SPECS } from '../../lib/agentSpecs'
import { bracketedPaste } from '../../lib/aiCliContext'

i18n.global.locale.value = 'en-US'

const settingsState = vi.hoisted(() => ({
  stored: {} as Record<string, string>,
  sets: [] as { key: string; value: string }[],
}))

vi.mock('../../lib/settings', () => ({
  settingsGet: vi.fn(
    (key: string, def: string | null) => settingsState.stored[key] ?? def
  ),
  settingsSet: vi.fn((key: string, value: string) => {
    settingsState.sets.push({ key, value })
    settingsState.stored[key] = value
  }),
}))

// Stubbed terminal host: the dock drives it purely through the exposed
// imperative surface, so the stub exposes spies plus mutable status /
// lastRawActivityAt refs the tests poke to simulate the PTY lifecycle.
const termSpies = vi.hoisted(() => ({
  spawn: vi.fn(async () => undefined),
  tryReattach: vi.fn(async () => undefined),
  pasteText: vi.fn(),
  interrupt: vi.fn(async () => undefined),
  kill: vi.fn(async () => undefined),
  cancelPendingCreate: vi.fn(async () => undefined),
  fitTerminal: vi.fn(),
  focus: vi.fn(),
}))
const termState = vi.hoisted(
  () => ({}) as { status: Ref<string>; lastRawActivityAt: Ref<number> }
)
vi.mock('../AiCliTerminal.vue', async () => {
  const { defineComponent, h, ref: vueRef } = await import('vue')
  termState.status = vueRef('idle')
  termState.lastRawActivityAt = vueRef(0)
  return {
    __esModule: true,
    default: defineComponent({
      name: 'AiCliTerminal',
      props: { paneId: String, backend: Object, workspacePath: String },
      inheritAttrs: false,
      setup(_, { expose }) {
        expose({
          ...termSpies,
          status: termState.status,
          displayStatus: termState.status,
          lastRawActivityAt: termState.lastRawActivityAt,
          sessionId: vueRef(''),
          error: vueRef(''),
        })
        return () => h('div', { class: 'stub-AiCliTerminal' })
      },
    }),
  }
})

import AiCliDock from '../AiCliDock.vue'

function makeBackend(status = 'connected') {
  return {
    status: ref(status),
    wsUrl: ref(''),
    httpUrl: ref(''),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async () => ({ payload: { ok: true } })),
    on: vi.fn(() => () => {}),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as InstanceType<typeof AiCliDock>['$props']['backend']
}

const mounted: VueWrapper[] = []
function mountDock(props: Record<string, unknown> = {}): VueWrapper {
  const wrapper = mount(AiCliDock, {
    props: {
      widthKey: 'test-cli-panel-width',
      workspacePath: '/tmp/ws',
      backend: makeBackend(),
      paneId: 'ab12cd34-test-cli-dock',
      origin: 'test-window',
      ...props,
    },
    global: { plugins: [i18n] },
  })
  mounted.push(wrapper)
  return wrapper
}

async function openDock(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.ai-dock-rail-btn').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  settingsState.stored = {}
  settingsState.sets.length = 0
  for (const spy of Object.values(termSpies)) spy.mockClear()
  termSpies.spawn.mockImplementation(async () => undefined)
  termSpies.tryReattach.mockImplementation(async () => undefined)
  termState.status.value = 'idle'
  termState.lastRawActivityAt.value = 0
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('AiCliDock — eager terminal mount + keep-alive toggle', () => {
  it('mounts the terminal eagerly and claims the PTY while the panel is still closed', async () => {
    const wrapper = mountDock()
    await flushPromises()
    expect(wrapper.find('.ai-dock-rail-btn').exists()).toBe(true)
    // The terminal exists even though the panel was never opened: ownership of
    // a still-running PTY must be claimed or the backend janitor reaps it.
    const term = wrapper.findComponent({ name: 'AiCliTerminal' })
    expect(term.exists()).toBe(true)
    expect(term.props('paneId')).toBe('ab12cd34-test-cli-dock')
    expect(term.props('workspacePath')).toBe('/tmp/ws')
    expect(termSpies.tryReattach).toHaveBeenCalledTimes(1)
    // The agent must ride along: this path never calls spawn(), and without it
    // useTerminal falls back to plain-shell input encoding (Shift+Enter, paste).
    expect(termSpies.tryReattach).toHaveBeenCalledWith({ agentKey: expect.any(String) })
    const panelEl = wrapper.find('.ai-dock-panel').element as HTMLElement
    expect(panelEl.style.display).toBe('none')
  })

  it('open/close toggles v-show only; the terminal instance survives', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    const panelEl = wrapper.find('.ai-dock-panel').element as HTMLElement
    expect(panelEl.style.display).not.toBe('none')
    // Closing hides via v-show but keeps the instance (CLI session preserved).
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    expect(wrapper.findComponent({ name: 'AiCliTerminal' }).exists()).toBe(true)
    expect(panelEl.style.display).toBe('none')
  })

  it('defers the reattach until the backend connects, then runs it exactly once', async () => {
    const backend = makeBackend('connecting')
    const wrapper = mountDock({ backend })
    await flushPromises()
    expect(termSpies.tryReattach).not.toHaveBeenCalled()
    ;(backend as unknown as { status: Ref<string> }).status.value = 'connected'
    await flushPromises()
    expect(termSpies.tryReattach).toHaveBeenCalledTimes(1)
    // Panel toggles do not re-run it (once per window life).
    await openDock(wrapper)
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    await openDock(wrapper)
    expect(termSpies.tryReattach).toHaveBeenCalledTimes(1)
  })

  it('refits the terminal when the panel opens from display:none', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    expect(termSpies.fitTerminal).toHaveBeenCalledWith({ redrawAfterSettle: true })
  })

  it('supports v-model:open (host-driven open shows the panel)', async () => {
    const wrapper = mountDock({
      open: false,
      'onUpdate:open': (v: boolean) => wrapper.setProps({ open: v }),
    })
    const panelEl = wrapper.find('.ai-dock-panel').element as HTMLElement
    expect(panelEl.style.display).toBe('none')
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(panelEl.style.display).not.toBe('none')
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    expect((wrapper.props() as { open?: boolean }).open).toBe(false)
  })

  it('without a workspace: empty state, no terminal, no reattach, Start disabled', async () => {
    const wrapper = mountDock({ workspacePath: '' })
    await openDock(wrapper)
    expect(wrapper.find('.ai-cli-empty').text()).toBe('No workspace available')
    expect(wrapper.findComponent({ name: 'AiCliTerminal' }).exists()).toBe(false)
    expect(termSpies.tryReattach).not.toHaveBeenCalled()
    expect(
      (wrapper.find('.ai-cli-btn.primary').element as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('suppresses the empty state until the host reports the workspace resolved', async () => {
    const wrapper = mountDock({ workspacePath: '', workspaceResolved: false })
    await openDock(wrapper)
    expect(wrapper.find('.ai-cli-empty').exists()).toBe(false)
    await wrapper.setProps({ workspaceResolved: true })
    expect(wrapper.find('.ai-cli-empty').exists()).toBe(true)
  })
})

describe('AiCliDock — width persistence', () => {
  it('reads the persisted width from widthKey, clamped to 280–600', () => {
    settingsState.stored['test-cli-panel-width'] = '9999'
    const wide = mountDock()
    expect((wide.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('600px')

    settingsState.stored['test-cli-panel-width'] = '10'
    const narrow = mountDock()
    expect((narrow.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('280px')
  })

  it('falls back to defaultWidth when nothing is persisted', () => {
    const wrapper = mountDock({ defaultWidth: 320 })
    expect((wrapper.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('320px')
  })

  it('tracks drag on the handle (clamped) and persists the width on release', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    await wrapper.find('.ai-dock-resize-handle').trigger('mousedown')
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: window.innerWidth - 400 }))
    await flushPromises()
    expect((wrapper.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('400px')
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 }))
    await flushPromises()
    expect((wrapper.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('600px')
    document.dispatchEvent(new MouseEvent('mouseup'))
    expect(settingsState.sets).toEqual([{ key: 'test-cli-panel-width', value: '600' }])
  })
})

describe('AiCliDock — agent picker persistence', () => {
  it('offers every CLI agent spec (the plain-shell terminal entry is excluded)', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    const values = wrapper
      .find('.ai-cli-agent-select')
      .findAll('option')
      .map((o) => (o.element as HTMLOptionElement).value)
    expect(values).toEqual(CLI_AGENT_SPECS.map((s) => s.agentKey))
    expect(values).not.toContain('terminal')
  })

  it('honors the agentKeys subset filter', async () => {
    const wrapper = mountDock({ agentKeys: ['claude', 'codex'] })
    await openDock(wrapper)
    const values = wrapper
      .find('.ai-cli-agent-select')
      .findAll('option')
      .map((o) => (o.element as HTMLOptionElement).value)
    expect(values).toEqual(['claude', 'codex'])
  })

  it('persists the selection under the derived `${widthKey}.agent` key by default', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    await wrapper.find('.ai-cli-agent-select').setValue('codex')
    expect(settingsState.sets).toContainEqual({ key: 'test-cli-panel-width.agent', value: 'codex' })
  })

  it('uses an explicit agentKeyStorageKey (legacy key preservation) and reads it back', async () => {
    settingsState.stored['pm-ai-agent'] = 'aider'
    const wrapper = mountDock({ agentKeyStorageKey: 'pm-ai-agent' })
    await openDock(wrapper)
    expect(
      (wrapper.find('.ai-cli-agent-select').element as HTMLSelectElement).value
    ).toBe('aider')
    await wrapper.find('.ai-cli-agent-select').setValue('claude')
    expect(settingsState.sets).toContainEqual({ key: 'pm-ai-agent', value: 'claude' })
  })
})

describe('AiCliDock — start guards and spawn path', () => {
  it('disables Start while the backend is not connected', async () => {
    const wrapper = mountDock({ backend: makeBackend('disconnected') })
    await openDock(wrapper)
    expect(
      (wrapper.find('.ai-cli-btn.primary').element as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('locks Start (Reattaching…) while the connect-time reattach is in flight', async () => {
    let release!: () => void
    termSpies.tryReattach.mockImplementation(
      () => new Promise<undefined>((r) => { release = () => r(undefined) })
    )
    const wrapper = mountDock()
    await openDock(wrapper)
    const btn = wrapper.find('.ai-cli-btn.primary')
    expect(btn.text()).toBe('Reattaching…')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    release()
    await flushPromises()
    expect(btn.text()).toBe('Start')
    expect((btn.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('spawns a NEW PTY with the shell-wrapped command, origin metadata and skipReattach', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    await wrapper.find('.ai-cli-btn.primary').trigger('click')
    await flushPromises()
    expect(termSpies.spawn).toHaveBeenCalledTimes(1)
    expect(termSpies.spawn).toHaveBeenCalledWith({
      // backend.shell is '' → 'bash' fallback; yolo unset → default ON.
      command: ['bash', '-lc', 'claude --dangerously-skip-permissions'],
      cwd: '/tmp/ws',
      agentKey: 'claude',
      metadata: { workspace_path: '/tmp/ws', origin: 'test-window' },
      skipReattach: true,
    })
  })

  it('injects the host context (bracketed paste + CR) only after a fresh spawn goes quiet', async () => {
    const buildContext = vi.fn(() => 'CONTEXT SNAPSHOT')
    termSpies.spawn.mockImplementation(async () => {
      termState.status.value = 'running'
      // Startup output already quiet: past the injectQuietMs window.
      termState.lastRawActivityAt.value = Date.now() - 60000
    })
    const wrapper = mountDock({ buildContext })
    await openDock(wrapper)
    await wrapper.find('.ai-cli-btn.primary').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('spawned')).toEqual([['claude']])
    expect(buildContext).toHaveBeenCalledTimes(1)
    expect(termSpies.pasteText).toHaveBeenCalledWith(bracketedPaste('CONTEXT SNAPSHOT'))
    // The submitting CR follows after the 300 ms ingest delay.
    expect(termSpies.pasteText).not.toHaveBeenCalledWith('\r')
    await new Promise((r) => setTimeout(r, 350))
    expect(termSpies.pasteText).toHaveBeenCalledWith('\r')
  })

  it('injects nothing when the host provides no buildContext', async () => {
    termSpies.spawn.mockImplementation(async () => {
      termState.status.value = 'running'
      termState.lastRawActivityAt.value = Date.now() - 60000
    })
    const wrapper = mountDock()
    await openDock(wrapper)
    await wrapper.find('.ai-cli-btn.primary').trigger('click')
    await flushPromises()
    await new Promise((r) => setTimeout(r, 350))
    expect(termSpies.pasteText).not.toHaveBeenCalled()
  })
})

describe('AiCliDock — running controls and lifecycle events', () => {
  it('Interrupt sends Ctrl+C; Stop on a running PTY kills it', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    termState.status.value = 'running'
    await nextTick()
    await wrapper.find('.ai-cli-btn.ghost').trigger('click')
    expect(termSpies.interrupt).toHaveBeenCalledTimes(1)
    await wrapper.find('.ai-cli-btn.danger').trigger('click')
    expect(termSpies.kill).toHaveBeenCalledTimes(1)
    expect(termSpies.cancelPendingCreate).not.toHaveBeenCalled()
  })

  it('Stop while starting cancels the pending create instead of kill()', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    termState.status.value = 'starting'
    await nextTick()
    await wrapper.find('.ai-cli-btn.danger').trigger('click')
    expect(termSpies.cancelPendingCreate).toHaveBeenCalledTimes(1)
    expect(termSpies.kill).not.toHaveBeenCalled()
  })

  it('emits status on every transition and exited when the PTY leaves active', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    termState.status.value = 'running'
    await nextTick()
    termState.status.value = 'exited'
    await nextTick()
    expect(wrapper.emitted('status')).toEqual([['running'], ['exited']])
    expect(wrapper.emitted('exited')).toHaveLength(1)
  })

  it('exposes the imperative API (start/stop/interrupt/pasteText/injectNow/toggle/terminal)', async () => {
    const wrapper = mountDock()
    const vm = wrapper.vm as unknown as Record<string, unknown>
    for (const key of ['start', 'stop', 'interrupt', 'pasteText', 'injectNow', 'toggle']) {
      expect(typeof vm[key], key).toBe('function')
    }
    await openDock(wrapper)
    ;(vm.pasteText as (t: string) => void)('hello')
    expect(termSpies.pasteText).toHaveBeenCalledWith('hello')
    // injectNow: immediate re-injection into a RUNNING CLI, no quiet-wait.
    termState.status.value = 'running'
    await nextTick()
    await wrapper.setProps({ buildContext: () => 'NOW' })
    const injectPromise = (vm.injectNow as () => Promise<void>)()
    await flushPromises()
    expect(termSpies.pasteText).toHaveBeenCalledWith(bracketedPaste('NOW'))
    await new Promise((r) => setTimeout(r, 350))
    await injectPromise
    expect(termSpies.pasteText).toHaveBeenCalledWith('\r')
  })
})
