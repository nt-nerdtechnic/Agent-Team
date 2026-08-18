// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { createMockBackend, withScope } from './mockBackend'

// The WebGL renderer shipped once and silently never activated: the app runs
// with --disable-gpu, so no context could be created, and WebglAddon reports
// that failure asynchronously from inside activate() — the try/catch around
// loadAddon never saw it. These tests pin the explicit probe that replaced it,
// and the on-screen scoping that keeps many panes inside Chromium's live
// WebGL-context budget (~16).

const webgl = vi.hoisted(() => ({
  created: 0,
  disposed: 0,
  lossHandlers: [] as Array<() => void>,
  throwOnConstruct: false,
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() {
      if (webgl.throwOnConstruct) throw new Error('no GL')
      webgl.created += 1
    }
    onContextLoss(cb: () => void): void {
      webgl.lossHandlers.push(cb)
    }
    dispose(): void {
      webgl.disposed += 1
    }
  },
}))

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(),
  sendResizeNow: vi.fn(),
  requestResizeRedraw: vi.fn(),
  attachObserver: vi.fn(),
  dispose: vi.fn(),
  ackedCols: 80,
  ackedRows: 24,
}))

vi.mock('../useTerminalResize', () => ({
  createResizeController: () => ctrl,
}))

const loaded = vi.hoisted(() => ({ addons: [] as unknown[] }))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(addon: unknown): void {
      loaded.addons.push(addon)
    }
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
    hasSelection(): boolean { return false }
    onSelectionChange(_handler: () => void): { dispose: () => void } {
      return { dispose: (): void => {} }
    }
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

import { useTerminal, _resetWebglProbeForTests } from '../useTerminal'

/** Pretend the renderer process can (or cannot) create a WebGL context. */
function withGpu(available: boolean): () => void {
  const original = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
  ): unknown {
    if (type === 'webgl2' || type === 'webgl') {
      return available ? { getExtension: () => ({ loseContext: () => {} }) } : null
    }
    return (original as (t: string) => unknown).call(this, type)
  } as typeof HTMLCanvasElement.prototype.getContext
  return () => {
    HTMLCanvasElement.prototype.getContext = original
  }
}

describe('useTerminal — WebGL renderer is probed, scoped, and observable', () => {
  afterEach(() => {
    vi.clearAllMocks()
    webgl.created = 0
    webgl.disposed = 0
    webgl.lossHandlers = []
    webgl.throwOnConstruct = false
    loaded.addons = []
    _resetWebglProbeForTests()
    localStorage.clear()
  })

  it('attaches the GPU renderer to an on-screen pane when a context is available', () => {
    const restore = withGpu(true)
    try {
      const mock = createMockBackend()
      const { result } = withScope(() =>
        useTerminal('pane-gpu', mock.backend, { onScreen: () => true }),
      )
      result.mount(document.createElement('div'))

      expect(webgl.created).toBe(1)
      expect(result.rendererKind.value).toBe('webgl')
    } finally {
      restore()
    }
  })

  it('never constructs the addon when no context can be created', () => {
    // This is the shipped-but-dead case: --disable-gpu means the probe fails.
    const restore = withGpu(false)
    try {
      const mock = createMockBackend()
      const { result } = withScope(() =>
        useTerminal('pane-nogpu', mock.backend, { onScreen: () => true }),
      )
      result.mount(document.createElement('div'))

      expect(webgl.created).toBe(0)
      expect(result.rendererKind.value).toBe('dom')
    } finally {
      restore()
    }
  })

  it('leaves an off-screen pane on the DOM renderer so it costs no context', () => {
    const restore = withGpu(true)
    try {
      const mock = createMockBackend()
      const { result } = withScope(() =>
        useTerminal('pane-hidden', mock.backend, { onScreen: () => false }),
      )
      result.mount(document.createElement('div'))

      expect(webgl.created).toBe(0)
      expect(result.rendererKind.value).toBe('dom')
    } finally {
      restore()
    }
  })

  it('acquires and releases the context as the pane enters and leaves the screen', async () => {
    const restore = withGpu(true)
    try {
      const mock = createMockBackend()
      const onScreen = ref(false)
      const { result } = withScope(() =>
        useTerminal('pane-toggle-gpu', mock.backend, { onScreen: () => onScreen.value }),
      )
      result.mount(document.createElement('div'))
      expect(webgl.created).toBe(0)

      onScreen.value = true
      await nextTick()
      expect(webgl.created).toBe(1)
      expect(result.rendererKind.value).toBe('webgl')

      onScreen.value = false
      await nextTick()
      expect(webgl.disposed).toBe(1)
      expect(result.rendererKind.value).toBe('dom')
    } finally {
      restore()
    }
  })

  it('falls back to the DOM renderer when the context is lost', async () => {
    const restore = withGpu(true)
    try {
      const mock = createMockBackend()
      const { result } = withScope(() =>
        useTerminal('pane-loss', mock.backend, { onScreen: () => true }),
      )
      result.mount(document.createElement('div'))
      expect(result.rendererKind.value).toBe('webgl')

      expect(webgl.lossHandlers).toHaveLength(1)
      webgl.lossHandlers[0]()

      expect(result.rendererKind.value).toBe('dom')
      expect(webgl.disposed).toBe(1)
    } finally {
      restore()
    }
  })

  it('stays on the DOM renderer if constructing the addon throws', () => {
    const restore = withGpu(true)
    try {
      webgl.throwOnConstruct = true
      const mock = createMockBackend()
      const { result } = withScope(() =>
        useTerminal('pane-throw', mock.backend, { onScreen: () => true }),
      )
      result.mount(document.createElement('div'))

      expect(result.rendererKind.value).toBe('dom')
    } finally {
      restore()
    }
  })
})
