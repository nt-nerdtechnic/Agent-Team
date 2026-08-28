// @vitest-environment happy-dom
//
// The width-resize ordering, pinned against a REAL xterm buffer and REAL
// recorded `claude` output (see fixtures/README.md).
//
// A pane resize has two halves that live on opposite sides of an IPC hop:
// xterm's screen width, and the PTY's winsize. Whichever half moves first,
// there is a window in which a frame drawn for one width is rendered at the
// other — and xterm soft-wraps the overhang into rows the CLI's repaint can no
// longer reach, because ESC[2K/ESC[2J only ever address the viewport. Wrapped
// fragments that reach the scrollback are permanent.
//
// So neither naive ordering is correct, and both have shipped:
//   - PTY first  → the CLI's narrow repaint lands in a still-wide xterm.
//   - xterm first → a frame drawn for the old width lands in an already-narrow
//                   xterm. This is what ships today.
//
// The invariant below is ordering-agnostic and is the agreed acceptance
// condition: the scrollback must never contain a wrapped box-drawing row.
// It deliberately does NOT count fragments — fragment counts drift with the
// recorded content and would produce false reds/greens.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ref, shallowRef } from 'vue'
import { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { createResizeController } from '../useTerminalResize'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const readFixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)))

const BOOT_120 = readFixture('s_boot120.bin')
const SHRINK_90 = readFixture('s_shrink90.bin')

const WIDE = 120
const NARROW = 90
const ROWS = 30

function write(term: Terminal, data: Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

// One animation frame plus the microtask drain, which is exactly what
// applyFit's scheduleFrame needs before its body has run.
function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
}

// A macrotask turn, which flushes every pending microtask behind it — needed
// so an ack-driven resize has actually run before the assertions.
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// The acceptance condition. A full-width rule that xterm re-wrapped leaves the
// original row (not wrapped, exactly cols wide) plus a continuation row that IS
// wrapped and is shorter than cols — the "一長一短" the user sees. Inside the
// viewport the CLI's own repaint erases both; in the scrollback nothing can.
function wrappedRuleRowsInScrollback(term: Terminal): Array<{ row: number; len: number }> {
  const buf = term.buffer.active
  const found: Array<{ row: number; len: number }> = []
  for (let i = 0; i < buf.baseY; i++) {
    const line = buf.getLine(i)
    if (!line || !line.isWrapped) continue
    const text = line.translateToString(true).trimEnd()
    if (!/[─━═]{3,}/.test(text)) continue
    if (text.length < term.cols) found.push({ row: i, len: text.length })
  }
  return found
}

describe('width resize ordering (real xterm, recorded claude output)', () => {
  let term: Terminal
  let containerWidth: number
  let measuredCols: number

  beforeEach(() => {
    term = new Terminal({ cols: WIDE, rows: ROWS, scrollback: 10000, convertEol: false, allowProposedApi: true })
    containerWidth = 800
    measuredCols = WIDE
  })

  afterEach(() => {
    term.dispose()
    vi.restoreAllMocks()
  })

  function makeController(send: (op: string, payload: unknown) => Promise<{ ok: boolean }>) {
    // Stands in for FitAddon: both the imperative fit() the current code calls
    // and the proposeDimensions() a barrier-based ordering would consult.
    const fit = {
      fit: () => term.resize(measuredCols, ROWS),
      proposeDimensions: () => ({ cols: measuredCols, rows: ROWS }),
    } as unknown as FitAddon

    return createResizeController(
      term,
      fit,
      ref('term-session-1'),
      shallowRef({ get clientWidth() { return containerWidth } } as unknown as HTMLElement),
      ref(Date.now()),
      send as never,
      () => false,
      () => {},
    )
  }

  it('does not strand wrapped rule fragments in the scrollback when the pane narrows', async () => {
    // The backend's terminal.resize handler drains buffered output BEFORE it
    // applies the new winsize (ws_handlers.py), so everything the CLI produced
    // at the old width is already on the wire ahead of the ack. Modelling the
    // ack as the point where that flush has completed is what makes this test
    // ordering-agnostic: it holds for any implementation that keeps xterm's
    // width and the byte stream in agreement.
    // Held so the test can wait for the exchange to finish rather than guess
    // at how many turns an ack-driven resize needs.
    let inflight: Promise<{ ok: boolean }> = Promise.resolve({ ok: true })
    const send = vi.fn((op: string) => {
      const exchange = (async () => {
        if (op === 'terminal.resize') await write(term, BOOT_120)
        return { ok: true }
      })()
      if (op === 'terminal.resize') inflight = exchange
      return exchange
    })
    const ctrl = makeController(send)

    // Conversation history, printed while the pane was 120 columns wide.
    await write(term, BOOT_120)
    expect(term.cols).toBe(WIDE)

    // The user drags the pane narrower; the container settles at 90 columns.
    measuredCols = NARROW
    ctrl.applyFit()
    await frame()
    await inflight
    await macrotask()

    // SIGWINCH lands and Claude repaints its whole viewport for the new width.
    await write(term, SHRINK_90)

    expect(send).toHaveBeenCalledWith('terminal.resize', expect.objectContaining({ cols: NARROW, rows: ROWS }))
    // A fix that simply never resizes xterm must not pass.
    expect(term.cols).toBe(NARROW)
    expect(wrappedRuleRowsInScrollback(term)).toEqual([])

    ctrl.dispose()
  })

  it('leaves the scrollback clean when nothing is in flight across the resize', async () => {
    // Control case: with no stale frame crossing the boundary, today's ordering
    // is already correct. Guards against a "fix" that trades the race for a
    // regression on the quiet path.
    const send = vi.fn(async () => ({ ok: true }))
    const ctrl = makeController(send)

    await write(term, BOOT_120)
    measuredCols = NARROW
    ctrl.applyFit()
    await frame()
    await macrotask()
    await write(term, SHRINK_90)

    expect(term.cols).toBe(NARROW)
    expect(wrappedRuleRowsInScrollback(term)).toEqual([])

    ctrl.dispose()
  })
})
