import { describe, it, expect, beforeEach } from 'vitest'
import {
  setTerminalSelection,
  getTerminalSelection,
  forgetTerminalSelection
} from './terminal-selection-cache'

// Edit > Copy reads this instead of asking the focused page at ⌘C time, which
// was a 300ms race a busy renderer loses — and losing it copies nothing at all
// over a terminal, because `.xterm` is user-select: none.
describe('terminal selection cache', () => {
  beforeEach(() => {
    // Module state is shared across cases; ids used below start clean.
    for (const id of [1, 2, 99]) forgetTerminalSelection(id)
  })

  it('returns what a page reported', () => {
    setTerminalSelection(1, 'npm run build')
    expect(getTerminalSelection(1)).toBe('npm run build')
  })

  it('keeps pages apart', () => {
    setTerminalSelection(1, 'from one')
    setTerminalSelection(2, 'from two')
    expect(getTerminalSelection(1)).toBe('from one')
    expect(getTerminalSelection(2)).toBe('from two')
  })

  it('reports nothing for a page that never spoke', () => {
    expect(getTerminalSelection(99)).toBe('')
  })

  // "Has no selection" and "never reported" must collapse to one state: both
  // mean Copy should fall back to asking, not write an empty clipboard.
  it('drops the entry when the selection is cleared', () => {
    setTerminalSelection(1, 'something')
    setTerminalSelection(1, '')
    expect(getTerminalSelection(1)).toBe('')
  })

  // WebContents ids are reused, so a surviving entry would eventually answer
  // Copy for an unrelated page.
  it('forgets a page so a reused id cannot inherit its selection', () => {
    setTerminalSelection(1, 'old page')
    forgetTerminalSelection(1)
    expect(getTerminalSelection(1)).toBe('')
  })
})
