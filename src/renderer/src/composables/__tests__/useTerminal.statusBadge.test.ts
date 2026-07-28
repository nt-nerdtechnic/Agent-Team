// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// The RUNNING/idle badge is driven by useTerminal's clean-content quiescence
// heuristic: a sustained burst of CLEANED PTY output (>MIN_BURST_MS ~2s) shows
// RUNNING. Two things must NOT count as agent activity:
//   1. A repaint that replays content already on screen — a focus/click or a
//      refit makes the CLI re-emit its current frame. isRedrawReplay drops it
//      (content-level dedup, reflow-tolerant) so a mere click/resize can't flip
//      the badge to RUNNING. Genuine NEW output during a focus is not masked.
//   2. An idle CLI's own footer/cursor repaints — raw bytes that are empty
//      after ANSI/noise stripping. This is why the badge tracks CLEANED
//      content, not raw bytes: an idle Claude repainting its prompt must read
//      as idle, not RUNNING.
// These tests pin: real clean output → RUNNING (even while focused); an
// on-screen content replay → non-running; and a pure-ANSI repaint stream →
// non-running.
//
// xterm won't boot in happy-dom, so it's mocked; ctrl.requestResizeRedraw is a
// no-op stub.

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
    registerLinkProvider(): { dispose(): void } { return { dispose(): void {} } }
    onResize(): { dispose(): void } { return { dispose(): void {} } }
    onData(): { dispose(): void } { return { dispose(): void {} } }
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
    proposeDimensions(): { cols: number; rows: number } { return { cols: 80, rows: 24 } }
  },
}))

import { useTerminal } from '../useTerminal'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('useTerminal — RUNNING badge vs self-triggered repaints', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    localStorage.clear()
  })

  async function spawned() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    return { result, mock, scope }
  }

  // Feed a sub-BURST_GAP_MS (1s) stream of PTY bytes for `ms`, running `onTick`
  // before each chunk (used to keep re-arming a focus/refit grace).
  async function stream(
    mock: ReturnType<typeof createMockBackend>,
    ms: number,
    onTick?: () => void,
  ): Promise<void> {
    const deadline = Date.now() + ms
    do {
      onTick?.()
      mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: '.' })
      await sleep(250)
    } while (Date.now() < deadline)
  }

  it('shows RUNNING for a genuine sustained output burst', async () => {
    const { result, mock, scope } = await spawned()
    // Sustain a burst well past MIN_BURST_MS (~2s).
    await stream(mock, 6000)
    expect(result.displayStatus.value).toBe('running')
    scope.stop()
  }, 12_000)

  it('shows RUNNING for a real burst even while the pane is repeatedly focused', async () => {
    const { result, mock, scope } = await spawned()
    // Re-focusing every tick used to arm a grace that suppressed RUNNING even
    // for genuine output. With content-level dedup, a real burst is no longer
    // masked by focus — only actual on-screen replays are dropped (next test).
    await stream(mock, 6000, () => result.focus())
    expect(result.displayStatus.value).toBe('running')
    scope.stop()
  }, 12_000)

  it('stays non-running when a focus/refit repaint replays on-screen content', async () => {
    const { result, mock, scope } = await spawned()
    // A distinctive screenful the CLI has already emitted (becomes cleanBuffer).
    const screen = 'Reading the terminal composable and wiring the new helper into place here.'
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: screen })
    await sleep(2500) // let any burst decay to idle
    // User clicks / a refit fires; the CLI repaints the SAME frame verbatim over
    // and over. isRedrawReplay drops each repaint, so no RUNNING burst forms.
    const deadline = Date.now() + 6000
    do {
      result.focus()
      result.fitTerminal({ redrawAfterSettle: true })
      mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: screen })
      await sleep(250)
    } while (Date.now() < deadline)
    expect(result.displayStatus.value).not.toBe('running')
    scope.stop()
  }, 12_000)

  it('stays non-running while the CLI only emits idle TUI repaints (no clean content)', async () => {
    const { result, mock, scope } = await spawned()
    // A pure erase-line + cursor-home repaint. stripAnsi removes it entirely, so
    // it carries no clean content — exactly what an idle Claude emits when it
    // repaints its prompt/cursor while waiting for input. Raw bytes keep
    // arriving (liveness stays alive) but no RUNNING burst may form.
    const deadline = Date.now() + 6000
    do {
      mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: '\x1b[2K\x1b[1G' })
      await sleep(250)
    } while (Date.now() < deadline)
    expect(result.displayStatus.value).not.toBe('running')
    scope.stop()
  }, 12_000)

  it('sets displayStatus to stopped when interrupt() or ESC is triggered, and clears on new input', async () => {
    const { result, mock, scope } = await spawned()
    expect(result.status.value).toBe('running')
    expect(result.displayStatus.value).toBe('starting')

    // Trigger interrupt
    await result.interrupt()
    expect(result.isStopped.value).toBe(true)
    expect(result.displayStatus.value).toBe('stopped')

    // User typing / reset clears stopped status
    result.isStopped.value = false
    expect(result.isStopped.value).toBe(false)

    scope.stop()
  })

  it('tracks STARTING from before create, cancels once, and ignores a late create result', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const mock = createMockBackend()
    let resolveCreate!: (value: any) => void
    let resolveCancel!: (value: any) => void
    const createReply = new Promise<any>((resolve) => { resolveCreate = resolve })
    const cancelReply = new Promise<any>((resolve) => { resolveCancel = resolve })
    const send = vi.fn((type: string, _payload?: Record<string, unknown>) => {
      if (type === 'terminal.create') return createReply
      if (type === 'terminal.create.cancel') return cancelReply
      return Promise.resolve({ ok: true, payload: null, error: null })
    })
    ;(mock.backend as any).send = send
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))

    const spawnPromise = result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await Promise.resolve()
    const createCall = send.mock.calls.find(([type]) => type === 'terminal.create')
    expect(createCall).toBeTruthy()
    const generation = createCall![1]!.create_generation
    expect(typeof generation).toBe('string')
    expect(generation).not.toBe('')
    expect(result.startingStartedAt.value).toBe(1_000)
    expect(result.startingAgeMs.value).toBe(0)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(result.startingAgeMs.value).toBe(30_000)

    let rollbackFinished = false
    const firstCancel = result.cancelPendingCreate().then(() => { rollbackFinished = true })
    const secondCancel = result.cancelPendingCreate()
    await Promise.resolve()
    expect(rollbackFinished).toBe(false)
    expect(send.mock.calls.filter(([type]) => type === 'terminal.create.cancel')).toEqual([
      ['terminal.create.cancel', { pane_id: 'pane-1', create_generation: generation }],
    ])

    resolveCancel({ ok: true, payload: { cancelled: true }, error: null })
    await Promise.all([firstCancel, secondCancel])
    expect(rollbackFinished).toBe(true)

    resolveCreate({
      ok: true,
      payload: { terminal_session_id: 'late-session', pid: 42 },
      error: null,
    })
    await spawnPromise
    expect(result.sessionId.value).toBe('')
    expect(result.status.value).toBe('starting')
    expect(send.mock.calls.filter(([type]) => type === 'terminal.create.cancel')).toHaveLength(1)
    scope.stop()
  })

  it('uses a new create generation after a prior terminal exits', async () => {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    const firstGeneration = mock.sent.find((call) => call.type === 'terminal.create')?.payload.create_generation

    mock.emit('terminal.exit', { terminal_session_id: 'sess-1', exit_code: 0 })
    await result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    const generations = mock.sent
      .filter((call) => call.type === 'terminal.create')
      .map((call) => call.payload.create_generation)
    expect(generations).toHaveLength(2)
    expect(generations[1]).not.toBe(firstGeneration)
    scope.stop()
  })

  it('best-effort cancels the matching generation when create fails', async () => {
    const mock = createMockBackend()
    const send = vi.fn((type: string, payload: Record<string, unknown>) => {
      if (type === 'terminal.create') return Promise.reject(new Error('request terminal.create timeout'))
      return Promise.resolve({ ok: true, payload: null, error: null })
    })
    ;(mock.backend as any).send = send
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))

    await result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await Promise.resolve()
    const createGeneration = send.mock.calls.find(([type]) => type === 'terminal.create')![1].create_generation
    expect(send).toHaveBeenCalledWith('terminal.create.cancel', {
      pane_id: 'pane-1',
      create_generation: createGeneration,
    })
    expect(result.status.value).toBe('error')
    scope.stop()
  })

  it('rejects an explicit stale-create cancellation when backend rollback fails', async () => {
    const mock = createMockBackend()
    let resolveCreate!: (value: unknown) => void
    const send = vi.fn((type: string) => {
      if (type === 'terminal.create') return new Promise((resolve) => { resolveCreate = resolve })
      if (type === 'terminal.create.cancel') return Promise.reject(new Error('ws not open'))
      return Promise.resolve({ ok: true, payload: null, error: null })
    })
    ;(mock.backend as any).send = send
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))

    const spawnPromise = result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await Promise.resolve()
    await expect(result.cancelPendingCreate()).rejects.toThrow('terminal create cancellation failed')

    resolveCreate({ ok: true, payload: { terminal_session_id: 'late-session', pid: 42 }, error: null })
    await spawnPromise
    expect(result.sessionId.value).toBe('')
    scope.stop()
  })
})
