import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { extractDropPaths, shellEscape, escapeDraggedPath, stabilizeDroppedPaths } from '../drop'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeItem(file: File): DataTransferItem {
  return {
    kind: 'file',
    type: '',
    getAsFile: () => file,
    getAsString: vi.fn(),
    webkitGetAsEntry: vi.fn(),
  } as unknown as DataTransferItem
}

function makeItemList(files: File[]): DataTransferItemList {
  const items = files.map(makeItem)
  return {
    length: items.length,
    ...Object.fromEntries(items.map((item, i) => [i, item])),
    [Symbol.iterator]: function* () { yield* items },
  } as unknown as DataTransferItemList
}

function makeFileList(files: File[]): FileList {
  return {
    length: files.length,
    ...Object.fromEntries(files.map((f, i) => [i, f])),
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () { yield* files },
  } as unknown as FileList
}

function makeEvent(files: File[], useItems = true): DragEvent {
  return {
    dataTransfer: {
      items: useItems ? makeItemList(files) : { length: 0 } as unknown as DataTransferItemList,
      files: makeFileList(files),
    },
  } as unknown as DragEvent
}

// ── setup ─────────────────────────────────────────────────────────────────────

const mockGetPath = vi.fn<(f: File) => string>()

beforeEach(() => {
  mockGetPath.mockReset()
  vi.stubGlobal('window', { agentTeam: { getPathForFile: mockGetPath } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── extractDropPaths ──────────────────────────────────────────────────────────

describe('extractDropPaths', () => {
  it('returns [] when dataTransfer is null', () => {
    expect(extractDropPaths({ dataTransfer: null } as unknown as DragEvent)).toEqual([])
  })

  it('returns [] when window.agentTeam is not available', () => {
    vi.stubGlobal('window', {})
    const f = new File([], 'folder')
    expect(extractDropPaths(makeEvent([f]))).toEqual([])
  })

  it('returns [] when getPathForFile is missing', () => {
    vi.stubGlobal('window', { agentTeam: {} })
    const f = new File([], 'folder')
    expect(extractDropPaths(makeEvent([f]))).toEqual([])
  })

  it('extracts a single path via items', () => {
    mockGetPath.mockReturnValue('/Users/test/my-project')
    const f = new File([], 'my-project')
    expect(extractDropPaths(makeEvent([f]))).toEqual(['/Users/test/my-project'])
    expect(mockGetPath).toHaveBeenCalledWith(f)
  })

  it('extracts multiple paths', () => {
    mockGetPath
      .mockReturnValueOnce('/Users/test/a')
      .mockReturnValueOnce('/Users/test/b')
    const f1 = new File([], 'a')
    const f2 = new File([], 'b')
    expect(extractDropPaths(makeEvent([f1, f2]))).toEqual(['/Users/test/a', '/Users/test/b'])
  })

  it('filters out empty paths returned by getPathForFile', () => {
    mockGetPath.mockReturnValueOnce('').mockReturnValueOnce('/Users/test/ok')
    const f1 = new File([], 'empty')
    const f2 = new File([], 'ok')
    expect(extractDropPaths(makeEvent([f1, f2]))).toEqual(['/Users/test/ok'])
  })

  it('falls back to dt.files when dt.items is empty', () => {
    mockGetPath.mockReturnValue('/Users/test/fallback')
    const f = new File([], 'fallback')
    expect(extractDropPaths(makeEvent([f], false))).toEqual(['/Users/test/fallback'])
  })

  it('skips non-file items (kind !== file)', () => {
    mockGetPath.mockReturnValue('/Users/test/file')
    const f = new File([], 'file')
    const items = {
      length: 2,
      0: { kind: 'string', type: 'text/plain', getAsFile: () => null } as unknown as DataTransferItem,
      1: makeItem(f),
      [Symbol.iterator]: function* () { yield (this as DataTransferItemList)[0]; yield (this as DataTransferItemList)[1] },
    } as unknown as DataTransferItemList
    const e = { dataTransfer: { items, files: makeFileList([]) } } as unknown as DragEvent
    expect(extractDropPaths(e)).toEqual(['/Users/test/file'])
  })

  it('handles paths with spaces and Unicode', () => {
    mockGetPath.mockReturnValue('/Users/test/我的專案 v2')
    const f = new File([], '我的專案 v2')
    expect(extractDropPaths(makeEvent([f]))).toEqual(['/Users/test/我的專案 v2'])
  })

  it('falls back to text/plain when no file sources (in-app drag)', () => {
    const e = {
      dataTransfer: {
        items: { length: 0 } as unknown as DataTransferItemList,
        files: makeFileList([]),
        getData: (type: string) => type === 'text/plain' ? '/Users/test/in-app.ts' : '',
      },
    } as unknown as DragEvent
    expect(extractDropPaths(e)).toEqual(['/Users/test/in-app.ts'])
  })

  it('text/plain fallback supports multiple paths separated by newline', () => {
    const e = {
      dataTransfer: {
        items: { length: 0 } as unknown as DataTransferItemList,
        files: makeFileList([]),
        getData: (type: string) => type === 'text/plain' ? '/Users/a.ts\n/Users/b.ts' : '',
      },
    } as unknown as DragEvent
    expect(extractDropPaths(e)).toEqual(['/Users/a.ts', '/Users/b.ts'])
  })

  it('in-app drag: string-kind item in dt.items falls through to text/plain (dir path)', () => {
    // Simulates ExplorerPane @dragstart → setData('text/plain', absPath)
    // dt.items gets one kind='string' entry; no file sources → text/plain fallback
    const stringItem = { kind: 'string', type: 'text/plain', getAsFile: () => null } as unknown as DataTransferItem
    const e = {
      dataTransfer: {
        items: {
          length: 1,
          0: stringItem,
          [Symbol.iterator]: function* () { yield stringItem },
        } as unknown as DataTransferItemList,
        files: makeFileList([]),
        getData: (type: string) => type === 'text/plain' ? '/Users/test/my-folder' : '',
      },
    } as unknown as DragEvent
    expect(extractDropPaths(e)).toEqual(['/Users/test/my-folder'])
  })

  it('native file sources take priority over text/plain', () => {
    mockGetPath.mockReturnValue('/Users/test/native.ts')
    const f = new File([], 'native.ts')
    const e = {
      dataTransfer: {
        items: makeItemList([f]),
        files: makeFileList([f]),
        getData: (type: string) => type === 'text/plain' ? '/Users/test/should-be-ignored.ts' : '',
      },
    } as unknown as DragEvent
    expect(extractDropPaths(e)).toEqual(['/Users/test/native.ts'])
  })
})

// ── shellEscape ───────────────────────────────────────────────────────────────

describe('shellEscape', () => {
  it('wraps a simple path in single quotes', () => {
    expect(shellEscape('/Users/test/folder')).toBe("'/Users/test/folder'")
  })

  it('handles path with spaces', () => {
    expect(shellEscape('/Users/test/my project')).toBe("'/Users/test/my project'")
  })

  it("escapes embedded single quotes with '\\''", () => {
    expect(shellEscape("/Users/test/it's")).toBe("'/Users/test/it'\\''s'")
  })

  it('handles multiple single quotes', () => {
    expect(shellEscape("/a'b'c")).toBe("'/a'\\''b'\\''c'")
  })
})

// ── stabilizeDroppedPaths ─────────────────────────────────────────────────────

describe('stabilizeDroppedPaths', () => {
  const mockStabilize = vi.fn<(paths: string[]) => Promise<{ ok: boolean; paths: string[] }>>()

  beforeEach(() => {
    mockStabilize.mockReset()
    vi.stubGlobal('window', {
      agentTeam: { getPathForFile: mockGetPath, stabilizeDroppedPaths: mockStabilize },
    })
  })

  it('returns the paths main hands back', async () => {
    mockStabilize.mockResolvedValue({ ok: true, paths: ['/userData/dropped-files/shot.png'] })
    expect(await stabilizeDroppedPaths(['/tmp/NSIRD_x/shot.png'])).toEqual([
      '/userData/dropped-files/shot.png',
    ])
  })

  it('skips the round-trip when there is nothing to stabilize', async () => {
    expect(await stabilizeDroppedPaths([])).toEqual([])
    expect(mockStabilize).not.toHaveBeenCalled()
  })

  it('falls back to the raw paths when the bridge is missing', async () => {
    vi.stubGlobal('window', { agentTeam: { getPathForFile: mockGetPath } })
    expect(await stabilizeDroppedPaths(['/tmp/shot.png'])).toEqual(['/tmp/shot.png'])
  })

  it('falls back when main reports failure', async () => {
    mockStabilize.mockResolvedValue({ ok: false, paths: [] })
    expect(await stabilizeDroppedPaths(['/tmp/shot.png'])).toEqual(['/tmp/shot.png'])
  })

  it('falls back when the reply length does not match the request', async () => {
    mockStabilize.mockResolvedValue({ ok: true, paths: ['/only/one.png'] })
    expect(await stabilizeDroppedPaths(['/tmp/a.png', '/tmp/b.png'])).toEqual([
      '/tmp/a.png',
      '/tmp/b.png',
    ])
  })

  it('falls back when the bridge throws', async () => {
    mockStabilize.mockRejectedValue(new Error('ipc down'))
    expect(await stabilizeDroppedPaths(['/tmp/shot.png'])).toEqual(['/tmp/shot.png'])
  })
})

// ── escapeDraggedPath ─────────────────────────────────────────────────────────

describe('escapeDraggedPath', () => {
  it('leaves an ordinary path untouched', () => {
    expect(escapeDraggedPath('/Users/test/notes.md')).toBe('/Users/test/notes.md')
  })

  it('backslash-escapes spaces instead of quoting, the way Terminal.app does', () => {
    expect(escapeDraggedPath('/Users/test/my project.png')).toBe(
      '/Users/test/my\\ project.png'
    )
  })

  it('escapes shell metacharacters', () => {
    expect(escapeDraggedPath("/a/it's (v2) [x] $y & z;.png")).toBe(
      "/a/it\\'s\\ \\(v2\\)\\ \\[x\\]\\ \\$y\\ \\&\\ z\\;.png"
    )
  })

  it('escapes a literal backslash', () => {
    expect(escapeDraggedPath('/a/b\\c')).toBe('/a/b\\\\c')
  })

  it('leaves CJK and the narrow no-break space in macOS screenshot names alone', () => {
    // Not shell metacharacters, and Terminal.app does not escape them either.
    expect(escapeDraggedPath('/Users/test/我的專案/Screenshot at 9.22.19 PM.png')).toBe(
      '/Users/test/我的專案/Screenshot\\ at\\ 9.22.19 PM.png'
    )
  })

  it('produces a path the shell resolves back to the original', () => {
    // The escaped form must round-trip: unescaping every backslash-pair
    // recovers exactly what was dropped.
    const original = "/a/weird name's (dir)/shot.png"
    expect(escapeDraggedPath(original).replace(/\\(.)/g, '$1')).toBe(original)
  })
})
