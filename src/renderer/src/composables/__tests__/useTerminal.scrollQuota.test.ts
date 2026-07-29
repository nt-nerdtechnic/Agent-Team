// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// localStorage stand-in with an enforceable quota, so the scrollback snapshot's
// overflow path can be driven end-to-end. `quota` starts effectively unlimited
// (spawn writes the PTY id) and the test tightens it right before dispose,
// which is when the snapshot is persisted.
const store = vi.hoisted(() => {
  const values = new Map<string, string>()
  const state = { quota: Number.MAX_SAFE_INTEGER }
  const usedBytes = (): number => {
    let n = 0
    values.forEach((v, k) => { n += k.length + v.length })
    return n
  }
  vi.stubGlobal('localStorage', {
    get length(): number { return values.size },
    key: (i: number) => Array.from(values.keys())[i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const existing = values.has(key) ? key.length + values.get(key)!.length : 0
      if (usedBytes() - existing + key.length + String(value).length > state.quota) {
        throw new Error('QuotaExceededError')
      }
      values.set(key, String(value))
    },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => { values.clear() },
  })
  return { values, state }
})

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(),
  sendResizeNow: vi.fn(),
  requestResizeRedraw: vi.fn(),
  attachObserver: vi.fn(),
  dispose: vi.fn(),
  ackedCols: 0,
  ackedRows: 0,
}))

vi.mock('../useTerminalResize', () => ({
  createResizeController: () => ctrl,
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    textarea = document.createElement('textarea')
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onResize(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onData(): { dispose(): void } {
      return { dispose(): void {} }
    }
    write(): void {}
    writeln(): void {}
    resize(): void {}
    focus(): void {}
    select(): void {}
    clearSelection(): void {}
    scrollLines(): void {}
    scrollToBottom(): void {}
    dispose(): void {}
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 }
    }
  },
}))

import { useTerminal } from '../useTerminal'

const SELF_KEY = 'terminal-scroll:pane-1'
const OTHER_KEY = 'terminal-scroll:pane-other'

describe('useTerminal — scrollback snapshot under localStorage quota', () => {
  afterEach(() => {
    vi.clearAllMocks()
    store.state.quota = Number.MAX_SAFE_INTEGER
    localStorage.clear()
  })

  /** Spawn a pane and feed it `output`, leaving it buffered for persistence. */
  async function paneWithScrollback(output: string) {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: output })
    await new Promise((r) => setTimeout(r, 120)) // let the coalesce window flush
    return scope
  }

  it('evicts another pane stale snapshot instead of dropping the new one', async () => {
    const output = 'A'.repeat(20_000)
    const scope = await paneWithScrollback(output)

    // A closed pane's snapshot already fills most of the shared quota.
    store.values.set(OTHER_KEY, 'B'.repeat(30_000))
    store.state.quota = 25_000

    scope.stop() // dispose persists the snapshot

    expect(localStorage.getItem(OTHER_KEY)).toBeNull()
    expect(localStorage.getItem(SELF_KEY)).toBe(output)
  })

  it('keeps the newest tail when there is nothing left to evict', async () => {
    const output = 'A'.repeat(20_000)
    const scope = await paneWithScrollback(output)

    store.state.quota = 6_000 // fits a halved-twice payload, nothing bigger

    scope.stop()

    const saved = localStorage.getItem(SELF_KEY) ?? ''
    expect(saved.length).toBeGreaterThan(0)
    expect(saved.length).toBeLessThan(output.length)
    expect(saved).toBe(output.slice(-saved.length)) // newest bytes survive
  })

  it('gives up with a warning rather than looping when nothing fits', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const output = 'A'.repeat(20_000)
    const scope = await paneWithScrollback(output)

    store.state.quota = 0 // no write can ever succeed

    scope.stop() // must terminate, not spin

    expect(localStorage.getItem(SELF_KEY)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('localStorage quota exhausted'))
    warn.mockRestore()
  })
})
