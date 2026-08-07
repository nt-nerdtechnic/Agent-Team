import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { extractClipboardImage, saveClipboardImage } from '../clipboardImage'

// A ⌘⇧4 screenshot reaches the paste event as an image file with no text, so
// these cover picking it out of the clipboard and handing the bytes to main.

function clipboard(items: Array<{ kind: string; type: string; file: File | null }>): DataTransfer {
  const list = items.map((it) => ({ kind: it.kind, type: it.type, getAsFile: () => it.file }))
  return {
    items: { length: list.length, ...Object.fromEntries(list.map((it, i) => [i, it])),
      [Symbol.iterator]: function* () { yield* list } }
  } as unknown as DataTransfer
}

const png = (): File => new File([new Uint8Array([0x89, 0x50])], 'shot.png', { type: 'image/png' })

describe('extractClipboardImage', () => {
  it('returns the image on the clipboard', () => {
    const file = png()
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
    const file = png()
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

describe('saveClipboardImage', () => {
  const mockSave = vi.fn<
    (args: { bytes: Uint8Array; mediaType: string }) => Promise<{ ok: boolean; path?: string }>
  >()

  beforeEach(() => {
    mockSave.mockReset()
    vi.stubGlobal('window', { agentTeam: { saveClipboardImage: mockSave } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the bytes and media type to main and returns the path', async () => {
    mockSave.mockResolvedValue({ ok: true, path: '/userData/dropped-files/Pasted Image.png' })

    expect(await saveClipboardImage(png())).toBe('/userData/dropped-files/Pasted Image.png')
    const arg = mockSave.mock.calls[0]![0]
    expect(arg.mediaType).toBe('image/png')
    expect(Array.from(arg.bytes)).toEqual([0x89, 0x50])
  })

  it('returns null when the bridge is unavailable', async () => {
    vi.stubGlobal('window', { agentTeam: {} })
    expect(await saveClipboardImage(png())).toBeNull()
  })

  it('returns null when main declines to write the image', async () => {
    mockSave.mockResolvedValue({ ok: false })
    expect(await saveClipboardImage(png())).toBeNull()
  })

  it('returns null when the bridge throws', async () => {
    mockSave.mockRejectedValue(new Error('ipc down'))
    expect(await saveClipboardImage(png())).toBeNull()
  })
})
