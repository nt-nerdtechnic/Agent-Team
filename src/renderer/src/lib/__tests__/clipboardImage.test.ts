import { describe, it, expect } from 'vitest'
import { extractClipboardImage } from '../clipboardImage'

// A ⌘⇧4 screenshot reaches the paste event as an image file with no text, so
// these cover picking it out of the clipboard and handing the bytes to main.

function clipboard(items: Array<{ kind: string; type: string; file: File | null }>): DataTransfer {
  const list = items.map((it) => ({ kind: it.kind, type: it.type, getAsFile: () => it.file }))
  return {
    items: { length: list.length, ...Object.fromEntries(list.map((it, i) => [i, it])),
      [Symbol.iterator]: function* () { yield* list } }
  } as unknown as DataTransfer
}

describe('extractClipboardImage', () => {
  it('returns the image on the clipboard', () => {
    const file = new File([new Uint8Array([0x89, 0x50])], 'shot.png', { type: 'image/png' })
    expect(extractClipboardImage(clipboard([{ kind: 'file', type: 'image/png', file }]))).toBe(file)
  })

  it('skips non-image files and plain text entries', () => {
    expect(
      extractClipboardImage(
        clipboard([
          { kind: 'string', type: 'text/plain', file: null },
          { kind: 'file', type: 'application/pdf', file: new File([''], 'a.pdf') }
        ])
      )
    ).toBeNull()
  })

  it('picks the image out of a mixed clipboard', () => {
    const file = new File([new Uint8Array([0x89, 0x50])], 'shot.png', { type: 'image/png' })
    expect(
      extractClipboardImage(
        clipboard([
          { kind: 'string', type: 'text/html', file: null },
          { kind: 'file', type: 'image/png', file }
        ])
      )
    ).toBe(file)
  })

  it('returns null for an empty or absent clipboard', () => {
    expect(extractClipboardImage(null)).toBeNull()
    expect(extractClipboardImage(clipboard([]))).toBeNull()
  })

  it('returns null when the entry claims to be a file but yields none', () => {
    expect(extractClipboardImage(clipboard([{ kind: 'file', type: 'image/png', file: null }]))).toBeNull()
  })
})
