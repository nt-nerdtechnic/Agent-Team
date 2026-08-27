// @vitest-environment happy-dom
//
// PROBE (not a guard). Replays bytes recorded from a real `claude` across a
// width change, so the stray-rule artefact can be reproduced and fixes tried
// without touching a live pane.
//
// What the recording shows Claude does on SIGWINCH: ESC[2J zero times, ESC[K
// zero times, ESC[H twice. It repaints by homing the cursor and drawing over
// whatever is there — it never clears. At a new width the old frame no longer
// lines up with the new one, so the leftovers stay on screen. That is the
// artefact, and it is why "stop it wrapping" cannot be the fix: the short rule
// is a real line Claude drew at the narrow width, not a wrap fragment.
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import capture from './resize_capture.json'

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

/** Widths of every line that is nothing but box-drawing horizontals. */
function ruleWidths(term: Terminal): number[] {
  const buf = term.buffer.active
  const out: number[] = []
  for (let i = 0; i < buf.length; i++) {
    const t = buf.getLine(i)?.translateToString(true).trim() ?? ''
    if (t.length >= 3 && /^[─━┄┅]+$/.test(t)) out.push(t.length)
  }
  return out
}

/** Non-blank lines, so a fix can be checked for destroying content. */
function contentLines(term: Terminal): number {
  const buf = term.buffer.active
  let n = 0
  for (let i = 0; i < buf.length; i++) {
    if ((buf.getLine(i)?.translateToString(true).trim() ?? '') !== '') n++
  }
  return n
}

/** Conversation history above the frame — without it the viewport sits at the
 *  top of an almost-empty buffer and the artefact cannot appear. A real pane
 *  has scrolled far past that. Lines are deliberately longer than the narrow
 *  width so they wrap, the way prose does. */
async function seedHistory(term: Terminal, lines: number): Promise<void> {
  let out = ''
  for (let i = 0; i < lines; i++) {
    out += `line ${i} ` + 'x'.repeat(95) + '\r\n'
  }
  await write(term, out)
}

async function replay(clearBeforeRepaint: boolean, history = 60) {
  const term = new Terminal({ cols: 110, rows: 20, allowProposedApi: true })
  term.open(document.createElement('div'))
  await seedHistory(term, history)
  await write(term, capture.start_110)

  term.resize(87, 20)
  if (clearBeforeRepaint) await write(term, '\x1b[2J\x1b[H')
  await write(term, capture.after_narrow_87)
  const narrow = { rules: ruleWidths(term), content: contentLines(term) }

  term.resize(110, 20)
  if (clearBeforeRepaint) await write(term, '\x1b[2J\x1b[H')
  await write(term, capture.after_wide_110)
  const wide = { rules: ruleWidths(term), content: contentLines(term) }

  term.dispose()
  return { narrow, wide }
}

describe('stray rules across a width change — real Claude bytes', () => {
  it('reproduces the artefact with today behaviour (no clear)', async () => {
    const r = await replay(false)
    console.log('[today]  at 87 — rules:', JSON.stringify(r.narrow.rules),
      'content lines:', r.narrow.content)
    console.log('[today]  at 110 — rules:', JSON.stringify(r.wide.rules),
      'content lines:', r.wide.content)
    expect(r.wide.rules.length).toBeGreaterThan(0)
  })

  it('shows what clearing the screen before the repaint would do', async () => {
    const r = await replay(true)
    console.log('[cleared] at 87 — rules:', JSON.stringify(r.narrow.rules),
      'content lines:', r.narrow.content)
    console.log('[cleared] at 110 — rules:', JSON.stringify(r.wide.rules),
      'content lines:', r.wide.content)
    // The question this probe exists to answer: does clearing cost content?
    expect(r.wide.content).toBeGreaterThanOrEqual(0)
  })
})
