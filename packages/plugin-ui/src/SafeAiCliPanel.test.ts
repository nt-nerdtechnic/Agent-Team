// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from './foundation'
import SafeAiCliPanel from './SafeAiCliPanel.vue'
import type { AiCliSessionController, SafeAiCliPanelHandle } from './index'
import { seedSettings, settingsGet } from './shared'
import { __resetSettingsForTest } from './shared/testing'

const { terminals, FakeTerminal } = vi.hoisted(() => {
  const terminals: Array<{
    cols: number
    rows: number
    writes: string[]
    focused: boolean
    emitData(data: string): void
  }> = []
  class FakeTerminal {
    cols = 80
    rows = 24
    writes: string[] = []
    focused = false
    private dataListener: ((data: string) => void) | null = null
    constructor(_options: unknown) { terminals.push(this) }
    loadAddon(addon: { activate?: (terminal: FakeTerminal) => void }) { addon.activate?.(this) }
    open() {}
    write(data: string) { this.writes.push(data) }
    focus() { this.focused = true }
    onData(listener: (data: string) => void) {
      this.dataListener = listener
      return { dispose: vi.fn() }
    }
    emitData(data: string) { this.dataListener?.(data) }
    dispose() {}
  }
  return { terminals, FakeTerminal }
})

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate() {}
    fit() {}
    dispose() {}
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  terminals.length = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  __resetSettingsForTest()
})

function makeController(): AiCliSessionController & { emitOutput(data: string): void; emitExit(): void } {
  let sessionId: string | null = null
  let output: ((data: string) => void) | null = null
  let exit: (() => void) | null = null
  return {
    get sessionId() { return sessionId },
    get profileId() { return sessionId ? 'claude' : null },
    listProfiles: vi.fn(async () => [
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
    ]),
    resume: vi.fn(async () => null),
    start: vi.fn(async () => { sessionId = 'session-1'; return sessionId }),
    send: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    stop: vi.fn(async () => { sessionId = null }),
    dispose: vi.fn(),
    onOutput(listener) { output = listener; return () => { output = null } },
    onExit(listener) { exit = listener; return () => { exit = null } },
    emitOutput(data) { output?.(data) },
    emitExit() { sessionId = null; exit?.() },
  }
}

describe('SafeAiCliPanel', () => {
  it('starts collapsed and checks for a tuple-owned detached session', async () => {
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.classes()).toContain('is-collapsed')
    expect(controller.listProfiles).toHaveBeenCalledOnce()
    expect(controller.resume).toHaveBeenCalledWith(80, 24)
    expect(controller.start).not.toHaveBeenCalled()
  })

  it('ignores terminal input until the Host-owned session is running', async () => {
    const controller = makeController()
    mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })

    terminals[0]?.emitData('not-running')
    await flushPromises()

    expect(controller.send).not.toHaveBeenCalled()
  })

  it('renders PTY output in xterm and forwards terminal input serially', async () => {
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    const handle = wrapper.vm as unknown as SafeAiCliPanelHandle
    await handle.start()
    controller.emitOutput('\u001b[32mready\u001b[0m')
    terminals[0]?.emitData('a')
    terminals[0]?.emitData('b')
    await flushPromises()

    expect(terminals[0]?.writes).toEqual(['\u001b[32mready\u001b[0m'])
    expect(controller.send).toHaveBeenNthCalledWith(1, 'a')
    expect(controller.send).toHaveBeenNthCalledWith(2, 'b')
  })

  it('continues forwarding terminal input after one send fails', async () => {
    const controller = makeController()
    vi.mocked(controller.send).mockRejectedValueOnce(new Error('send failed'))
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    const handle = wrapper.vm as unknown as SafeAiCliPanelHandle
    await handle.start()

    terminals[0]?.emitData('first')
    terminals[0]?.emitData('second')
    await flushPromises()

    expect(controller.send).toHaveBeenNthCalledWith(1, 'first')
    expect(controller.send).toHaveBeenNthCalledWith(2, 'second')
  })

  it('starts, focuses, and submits a bracketed prompt through its public handle', async () => {
    vi.useFakeTimers()
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    const handle = wrapper.vm as unknown as SafeAiCliPanelHandle

    const submitted = handle.submitPrompt('resolve this')
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(submitted).resolves.toBe(true)

    expect(controller.start).toHaveBeenCalledOnce()
    expect(controller.send).toHaveBeenNthCalledWith(1, '\u001b[200~resolve this\u001b[201~')
    expect(controller.send).toHaveBeenNthCalledWith(2, '\r')
    expect(terminals[0]?.focused).toBe(true)
    vi.useRealTimers()
  })

  it('persists profile and width and injects fresh Git context with unattended mode', async () => {
    vi.useFakeTimers()
    seedSettings({
      'git-ai-panel-width': 420,
      'git-ai-panel-width.agent': 'codex',
      'agentTeam.yolo': '1',
    })
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, {
      props: { controller, buildContext: () => 'Git context' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    await wrapper.get('.navide-safe-ai-cli__toggle').trigger('click')
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('codex')
    expect(wrapper.attributes('style')).toContain('width: 420px')

    await wrapper.get('select').setValue('claude')
    const start = (wrapper.vm as unknown as SafeAiCliPanelHandle).start()
    await vi.advanceTimersByTimeAsync(4_000)
    await start

    expect(controller.start).toHaveBeenCalledWith('claude', 80, 24, { yolo: true })
    expect(controller.send).toHaveBeenNthCalledWith(1, '\u001b[200~Git context\u001b[201~')
    expect(controller.send).toHaveBeenNthCalledWith(2, '\r')
    expect(settingsGet('git-ai-panel-width.agent', '')).toBe('claude')
    vi.useRealTimers()
  })

  it('does not clear terminal scrollback during resize', async () => {
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    const handle = wrapper.vm as unknown as SafeAiCliPanelHandle
    await wrapper.get('.navide-safe-ai-cli__toggle').trigger('click')
    await handle.start()
    await flushPromises()

    expect(controller.resize).toHaveBeenCalled()
    expect('clear' in (terminals[0] ?? {})).toBe(false)
  })
})
