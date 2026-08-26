// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { readBufferLineBeforeCursor, serializeRenderedBuffer } from '../useTerminal'

// Minimal stand-in for the xterm buffer surface serializeRenderedBuffer reads.
// Fixture texts are pre-trimmed (translateToString(true) right-trims). The
// cursor sits on the last row, as it does in a live pane.
function mockTerm(rows: string[]): Terminal {
  return {
    buffer: {
      active: {
        baseY: rows.length - 1,
        cursorY: 0,
        getLine: (r: number) =>
          rows[r] === undefined ? undefined : { translateToString: () => rows[r] },
      },
    },
  } as unknown as Terminal
}

describe('serializeRenderedBuffer', () => {
  it('returns the rendered rows oldest→newest', () => {
    expect(serializeRenderedBuffer(mockTerm(['one', 'two', 'three']), 100)).toBe('one\ntwo\nthree')
  })

  it('drops trailing blank lines but keeps interior ones', () => {
    expect(serializeRenderedBuffer(mockTerm(['a', '', 'b', '', '   ']), 100)).toBe('a\n\nb')
  })

  it('keeps only the last maxLines rows', () => {
    expect(serializeRenderedBuffer(mockTerm(['a', 'b', 'c', 'd']), 2)).toBe('c\nd')
  })

  it("drops the CLI's trailing box-drawing input frame", () => {
    const rows = [
      '> summarize the diff',
      '  Done — 3 files changed.',
      '╭──────────────────────────╮',
      '│ >',
      '╰──────────────────────────╯',
      '',
    ]
    // Only the trailing frame line goes: the prompt row carries content, so the
    // walk stops there (deliberately simple — no widget-wide filter).
    expect(serializeRenderedBuffer(mockTerm(rows), 100)).toBe(
      '> summarize the diff\n  Done — 3 files changed.\n╭──────────────────────────╮\n│ >'
    )
  })

  it('returns an empty string for an all-blank buffer', () => {
    expect(serializeRenderedBuffer(mockTerm(['', '  ', '']), 100)).toBe('')
  })

  it('tolerates rows xterm has no line for', () => {
    const term = {
      buffer: { active: { baseY: 2, cursorY: 0, getLine: () => undefined } },
    } as unknown as Terminal
    expect(serializeRenderedBuffer(term, 100)).toBe('')
  })

  // A full-screen TUI hides the cursor while a dialog is up and leaves it
  // wherever it last wrote — which can be ABOVE the dialog. The AWAITING
  // prompt watcher reads from the viewport bottom for exactly this reason.
  describe('from: viewport-bottom', () => {
    /** Viewport is the whole fixture (baseY 0); the cursor is parked at
     *  `cursorY`, not necessarily at the end of the content. */
    function mockScreen(rows: string[], cursorY: number): Terminal {
      return {
        rows: rows.length,
        buffer: {
          active: {
            baseY: 0,
            cursorY,
            getLine: (r: number) =>
              rows[r] === undefined ? undefined : { translateToString: () => rows[r] },
          },
        },
      } as unknown as Terminal
    }

    const dialog = [
      'thinking…',
      'Would you like to run the following command?',
      '  1. Yes, just this once',
      '  3. No, and tell Codex what to do differently',
    ]

    it('reading from the cursor misses a dialog drawn below it', () => {
      // The bug this option exists to avoid.
      expect(serializeRenderedBuffer(mockScreen(dialog, 0), 25)).toBe('thinking…')
    })

    it('reading from the viewport bottom sees the whole screen', () => {
      expect(serializeRenderedBuffer(mockScreen(dialog, 0), 25, 'viewport-bottom')).toBe(
        dialog.join('\n')
      )
    })

    it('still drops trailing blanks, so the last real line stays the tail', () => {
      // What keeps aider's end-anchored pattern working: the cursor moves to a
      // blank line below the prompt, but the prompt is still the tail.
      const rows = ['Run shell command? (Y)es/(N)o [Yes]:', '', '']
      expect(serializeRenderedBuffer(mockScreen(rows, 1), 25, 'viewport-bottom')).toBe(rows[0])
    })
  })
})
describe('readBufferLineBeforeCursor', () => {
  function mockCursorTerm(rows: string[], cursorX: number): Terminal {
    return {
      buffer: {
        active: {
          baseY: rows.length - 1,
          cursorY: 0,
          cursorX,
          getLine: (r: number) =>
            rows[r] === undefined
              ? undefined
              : {
                  // Mirrors xterm: trimRight cuts the row at its last non-blank
                  // cell, which happens BEFORE the caller slices at the cursor.
                  translateToString: (trimRight?: boolean) =>
                    trimRight ? rows[r].replace(/\s+$/, '') : rows[r],
                },
        },
      },
    } as unknown as Terminal
  }

  it('returns the cursor row text up to the cursor column', () => {
    expect(readBufferLineBeforeCursor(mockCursorTerm(['history', '│ > tell @'], 10))).toBe('│ > tell @')
    expect(readBufferLineBeforeCursor(mockCursorTerm(['│ > tell @more'], 10))).toBe('│ > tell @')
  })

  it('keeps the blank before the cursor when nothing is drawn to its right', () => {
    // A plain shell prompt: without the right border there is no trailing cell
    // to protect the space, so trimming would strip it and break @-mention.
    expect(readBufferLineBeforeCursor(mockCursorTerm(['$ '], 2))).toBe('$ ')
    expect(readBufferLineBeforeCursor(mockCursorTerm(['▌ '], 2))).toBe('▌ ')
  })

  it('returns empty for a missing line', () => {
    const term = {
      buffer: { active: { baseY: 5, cursorY: 0, cursorX: 3, getLine: () => undefined } },
    } as unknown as Terminal
    expect(readBufferLineBeforeCursor(term)).toBe('')
  })
})
