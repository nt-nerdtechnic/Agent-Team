// @vitest-environment happy-dom
//
// Guards the four limits that keep the divider fix from touching anything else.
//
// An earlier attempt blanked the folded row with ESC[2K. The row stayed in
// place, and because Claude Code paints with absolute coordinates the extra row
// pushed its whole frame down — the input area visibly broke. The fix is to
// DELETE the row so the row count the CLI draws against is restored, and to
// keep the whole thing confined to the prompt frame.
//
// Source-scanned: the function is internal to the controller and the behaviour
// worth protecting is which rows it will and will not consider.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/composables/useTerminalResize.ts'), 'utf8')

const body = (() => {
  const at = src.indexOf('function unfoldPromptDivider(')
  expect(at).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf('\n  }', at))
})()

describe('prompt-divider unfold stays inside its lane', () => {
  it('deletes the folded row rather than blanking it', () => {
    // ESC[1M shifts the rows below up; ESC[2K would leave a blank row behind
    // and shift the CLI's whole frame down.
    expect(body).toContain('\\x1b[1M')
    expect(body).not.toContain('\\x1b[2K')
  })

  it('only ever acts on a row xterm folded, never one the CLI drew', () => {
    // A short divider the CLI drew on purpose has isWrapped false. Erasing
    // those would delete frames the CLI still considers current.
    expect(body).toContain('if (!line?.isWrapped) continue')
  })

  it('only considers rows that are entirely box-drawing horizontals', () => {
    expect(body).toContain('RULE_ONLY.test(text)')
    expect(src).toContain('const RULE_ONLY = /^[\\u2500-\\u257f\\u2014\\u2015-]+$/')
  })

  it('is confined to the prompt frame at the bottom of the screen', () => {
    // The scrollback and the conversation above must never be scanned.
    expect(body).toContain('term.rows - PROMPT_FRAME_ROWS')
    expect(src).toContain('const PROMPT_FRAME_ROWS = 12')
  })

  it('scans bottom-up so a deletion cannot move a row still to be examined', () => {
    expect(body).toContain('for (let y = term.rows - 1; y >= first; y--)')
  })

  it('runs only when the terminal got NARROWER', () => {
    // Widening does not fold anything, so there is nothing to undo.
    expect(src).toContain('if (term.cols < colsBefore) unfoldPromptDivider()')
  })

  it('cannot break the resize it runs inside', () => {
    // applyFit wraps fit + sendResizeNow in one try/catch: anything thrown here
    // would swallow the resize and the PTY would never learn its new width.
    // That regression was caught once already — 421 passing tests went to 4
    // failures because every resize silently stopped being sent.
    expect(body).toContain('try {')
    expect(body).toContain('catch')
    const call = src.slice(src.indexOf('const colsBefore = term.cols'))
    expect(call.indexOf('unfoldPromptDivider()')).toBeLessThan(call.indexOf('sendResizeNow()'))
  })
})
