import { describe, expect, it } from 'vitest'
import { droppedPrefix, remapCursor } from '../bufferCursor'
import { bufferTail, findSentinel } from '../../platform/terminal/lib/buffer'

// Mirrors useTerminal.appendClean: cleanBytesSeen counts every character ever
// appended, cleanBuffer keeps only the tail once it grows past twice the cap.
const CLEAN_BUF_CAP = 128 * 1024

function fakePane() {
  let buf = ''
  let bytesSeen = 0
  return {
    append(text: string): void {
      bytesSeen += text.length
      const next = buf + text
      buf = next.length > CLEAN_BUF_CAP * 2 ? bufferTail(next, CLEAN_BUF_CAP) : next
    },
    observe: () => ({ len: buf.length, bytesSeen }),
    read: () => buf
  }
}

describe('droppedPrefix', () => {
  it('reports nothing dropped while the buffer only grows', () => {
    const prev = { len: 1000, bytesSeen: 1000 }
    const next = { len: 1500, bytesSeen: 1500 }
    expect(droppedPrefix(prev, next)).toBe(0)
  })

  it('reports nothing dropped when no output arrived at all', () => {
    const same = { len: 1000, bytesSeen: 4000 }
    expect(droppedPrefix(same, same)).toBe(0)
  })

  it('measures the trim from the monotonic counter, not from the cap', () => {
    // 200 chars appended, buffer only grew by 50 → 150 fell off the front.
    const prev = { len: 1000, bytesSeen: 5000 }
    const next = { len: 1050, bytesSeen: 5200 }
    expect(droppedPrefix(prev, next)).toBe(150)
  })

  it('never reports a negative drop', () => {
    // Defensive: a stale/replaced ref could hand back a smaller counter.
    const prev = { len: 1000, bytesSeen: 5000 }
    const next = { len: 9000, bytesSeen: 100 }
    expect(droppedPrefix(prev, next)).toBe(0)
  })
})

describe('remapCursor', () => {
  it('leaves the cursor alone when nothing was dropped', () => {
    expect(remapCursor(600, 0)).toBe(600)
  })

  it('shifts the cursor back by the dropped prefix', () => {
    expect(remapCursor(600, 100)).toBe(500)
  })

  it('lands a cursor from inside the dropped region on the buffer start', () => {
    // Anything still in the buffer below the old cursor has never been
    // scanned, so the only safe destination is 0 — never the old index.
    expect(remapCursor(600, 900)).toBe(0)
  })
})

describe('a scan cursor survives the 128KB buffer trim', () => {
  const SENTINEL = '---SPEC-DONE---'

  // A pane that already had output when its watcher armed, then produced
  // enough to trip the trim. Everything the agent printed lands AFTER the arm
  // position, and the sentinel survives the trim — only the cursor is stale.
  function trippedPane(): { pane: ReturnType<typeof fakePane>; armCursor: number; armObs: { len: number; bytesSeen: number } } {
    const pane = fakePane()
    pane.append('P'.repeat(60 * 1024)) // pre-existing output (resume replay etc.)
    const armObs = pane.observe()
    const armCursor = armObs.len // what markBufferPosition() hands the watcher
    // The agent works: 100KB, its sentinel on its own line, then 100KB more.
    pane.append('A'.repeat(100 * 1024))
    pane.append(`\n${SENTINEL}\n`)
    pane.append('B'.repeat(100 * 1024))
    return { pane, armCursor, armObs }
  }

  it('loses the sentinel when the stale absolute cursor is used as-is', () => {
    const { pane, armCursor } = trippedPane()
    const buf = pane.read()
    // The trim happened and the sentinel is still in the buffer …
    expect(buf.length).toBeLessThan(pane.observe().bytesSeen)
    expect(findSentinel(buf, SENTINEL, 0)).toBeGreaterThanOrEqual(0)
    // … but scanning from the un-remapped cursor walks straight past it.
    expect(findSentinel(buf, SENTINEL, armCursor)).toBe(-1)
  })

  it('finds the sentinel once the cursor is remapped onto the trimmed buffer', () => {
    const { pane, armCursor, armObs } = trippedPane()
    const buf = pane.read()
    const dropped = droppedPrefix(armObs, pane.observe())
    expect(dropped).toBeGreaterThan(0)
    const cursor = remapCursor(armCursor, dropped)
    expect(findSentinel(buf, SENTINEL, cursor)).toBeGreaterThanOrEqual(0)
  })

  it('is not rescued by the "cursor past the buffer end" correction', () => {
    // The pre-existing repair only fires when scanFrom >= buf.length. Here the
    // stale cursor sits comfortably inside the buffer, so that guard stays
    // silent while 60KB of the agent's own output is skipped.
    const { pane, armCursor } = trippedPane()
    expect(armCursor).toBeLessThan(pane.read().length)
  })
})
