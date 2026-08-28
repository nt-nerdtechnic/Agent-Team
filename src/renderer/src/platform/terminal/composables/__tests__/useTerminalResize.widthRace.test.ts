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

// Claude Code draws its input box as three consecutive rows: a full-width rule,
// the prompt line, then another full-width rule. It positions them absolutely
// (ESC[H, then relative moves), so anything that blanks or removes a row inside
// the settled frame does not shift the CLI's idea of where things are — it just
// punches a hole, and nothing repaints over it until the CLI redraws for some
// other reason. That is the "input box misaligned" failure, and this is its
// shape: returns the last rule pair that still brackets a prompt line, or null.
function inputBoxRules(term: Terminal): { gap: number; widths: [number, number] } | null {
  const buf = term.buffer.active
  const rules: Array<{ row: number; len: number }> = []
  for (let i = buf.baseY; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (!line) continue
    const text = line.translateToString(true).trimEnd()
    if (/^[─━═]{5,}$/.test(text)) rules.push({ row: i, len: text.length })
  }
  for (let i = rules.length - 1; i > 0; i--) {
    const top = rules[i - 1]
    const bottom = rules[i]
    if (bottom.row - top.row === 2) return { gap: 2, widths: [top.len, bottom.len] }
  }
  return null
}

// The historical "clean up the residue" techniques, as escape sequences written
// into an already-settled frame. Reproduced here ONLY so the assertion above can
// be shown to catch them; none of this exists in production code.
function eraseRuleRows(term: Terminal, mode: '\x1b[2K' | '\x1b[1M'): Promise<void> {
  const buf = term.buffer.active
  const rows: number[] = []
  for (let i = buf.baseY; i < buf.length; i++) {
    const text = buf.getLine(i)?.translateToString(true).trimEnd() ?? ''
    if (/^[─━═]{5,}$/.test(text)) rows.push(i - buf.baseY + 1)
  }
  // Bottom-up: ESC[1M shifts everything below it up, so top-down would drift.
  const seq = rows.reverse().map((row) => `\x1b[${row};1H${mode}`).join('')
  return new Promise((resolve) => term.write(seq, resolve))
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
      (sessionId, cols, rows) => send('terminal.resize', {
        terminal_session_id: sessionId,
        cols,
        rows,
      }).then(({ ok }) => ({ ok, payload: null, error: null })),
      (sessionId, cols, rows) => send('terminal.redraw', {
        terminal_session_id: sessionId,
        cols,
        rows,
      }).then(({ ok }) => ({ ok, payload: null, error: null })),
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
  it('leaves the input box frame intact across a resize', async () => {
    // The other half of the damage the old cleanup attempts caused: not stray
    // fragments in the scrollback, but holes in the frame the CLI had already
    // drawn correctly. Guards any future "tidy up after reflow" idea.
    const send = vi.fn(async () => ({ ok: true }))
    const ctrl = makeController(send)

    await write(term, BOOT_120)
    expect(inputBoxRules(term)).toEqual({ gap: 2, widths: [WIDE, WIDE] })

    measuredCols = NARROW
    ctrl.applyFit()
    await frame()
    await macrotask()
    await write(term, SHRINK_90)

    expect(inputBoxRules(term)).toEqual({ gap: 2, widths: [NARROW, NARROW] })

    ctrl.dispose()
  })

  it.each([
    ['ESC[2K (erase line in place)', '\x1b[2K' as const],
    ['ESC[1M (delete line)', '\x1b[1M' as const],
  ])('detects a settled frame damaged by %s', async (_label, mode) => {
    // Proves the assertion above is not vacuous. Both sequences were tried as
    // residue cleanups and both passed a single visual check before failing in
    // real use, because the damage only shows once the CLI stops repainting.
    // Neither is in production code; they are written here by hand.
    const send = vi.fn(async () => ({ ok: true }))
    const ctrl = makeController(send)

    await write(term, BOOT_120)
    measuredCols = NARROW
    ctrl.applyFit()
    await frame()
    await macrotask()
    await write(term, SHRINK_90)
    expect(inputBoxRules(term)).toEqual({ gap: 2, widths: [NARROW, NARROW] })

    // …and then a post-settle "cleanup" runs, as armResizeRedraw's timer did.
    await eraseRuleRows(term, mode)
    expect(inputBoxRules(term)).toBeNull()

    ctrl.dispose()
  })
  it('ignores a stale ack when resizes overlap', async () => {
    // Dragging produces overlapping resizes: applyFit runs again long before the
    // previous ack returns. Each in-flight request carries the size it asked
    // for, so an ack that arrives late must not be allowed to put xterm back to
    // a width the user has already dragged past.
    const pending: Array<{ cols: number; resolve: (v: { ok: boolean }) => void }> = []
    const send = vi.fn((_op: string, payload: any) =>
      new Promise<{ ok: boolean }>((resolve) => pending.push({ cols: payload.cols, resolve })),
    )
    const ctrl = makeController(send as never)

    await write(term, BOOT_120)

    measuredCols = 104
    ctrl.applyFit()
    await frame()
    measuredCols = 88
    ctrl.applyFit()
    await frame()

    expect(pending.map((p) => p.cols)).toEqual([104, 88])

    // The newer ack lands first, then the older one straggles in.
    pending[1].resolve({ ok: true })
    await macrotask()
    pending[0].resolve({ ok: true })
    await macrotask()

    expect(term.cols).toBe(88)

    ctrl.dispose()
  })
})
