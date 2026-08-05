// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope, flush } from './mockBackend'

// ⌘-clicking a path in terminal output opens it in the mini-IDE. The wire
// contract is snake_case and cross-process (`openEditorWindow` → main →
// EditorWindowApp's entry query), and it decides which workspace the mini-IDE
// ends up on:
//   • inside the pane's workspace → a workspace-relative `filepath`
//   • outside it                  → `filepath` is the basename and `file_ws`
//     names the file's own root, so the mini-IDE ADDS a tab instead of
//     reloading onto another workspace and dropping every open tab
//   • no pane workspace           → the file's own directory IS the workspace
// xterm won't boot in happy-dom, so the mock stands in and the test performs a
// real ⌘-click on the mounted element, then confirms the picker with Enter —
// the same two DOM events a user produces.

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(),
  sendResizeNow: vi.fn(),
  requestResizeRedraw: vi.fn(),
  attachObserver: vi.fn(),
  dispose: vi.fn(),
  ackedCols: 0,
  ackedRows: 0,
}))

vi.mock('../useTerminalResize', () => ({
  createResizeController: () => ctrl,
}))

// The single line of terminal output the click lands on.
const screen = vi.hoisted(() => ({ line: '' }))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    textarea: HTMLTextAreaElement | undefined
    // Cell metrics the ⌘-click handler reads to turn pixels into (row, col).
    _core = { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } }
    get modes(): { mouseTrackingMode: string; bracketedPasteMode: boolean } {
      return { mouseTrackingMode: 'none', bracketedPasteMode: false }
    }
    buffer = {
      active: {
        type: 'normal',
        viewportY: 0,
        baseY: 0,
        cursorX: 0,
        cursorY: 0,
        getLine: (row: number) =>
          row === 0
            ? { isWrapped: false, translateToString: () => screen.line }
            : undefined,
      },
    }
    loadAddon(): void {}
    open(el: HTMLElement): void {
      this.textarea = document.createElement('textarea')
      el.appendChild(this.textarea)
      // The click handler measures against xterm's screen layer.
      const scr = document.createElement('div')
      scr.className = 'xterm-screen'
      el.appendChild(scr)
    }
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onResize(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onData(): { dispose(): void } {
      return { dispose(): void {} }
    }
    write(): void {}
    writeln(): void {}
    resize(): void {}
    focus(): void {}
    select(): void {}
    clearSelection(): void {}
    scrollLines(): void {}
    scrollToBottom(): void {}
    dispose(): void {}
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 }
    }
  },
}))

import { useTerminal } from '../useTerminal'

type OpenParams = Record<string, string | number>

afterEach(() => {
  document.querySelector('.term-file-picker-root')?.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

/**
 * ⌘-click the (only) path on screen and confirm the picker with Enter.
 * Returns the params handed to `openEditorWindow` — i.e. the cross-process
 * open contract as the mini-IDE will receive it.
 */
async function cmdClickOpen(
  absPath: string,
  workspacePath: string | undefined,
  opts: { exists?: boolean } = {}
): Promise<{ params: OpenParams | undefined; scope: ReturnType<typeof withScope>['scope'] }> {
  screen.line = absPath
  const openEditorWindow = vi.fn()
  Object.assign(window, {
    agentTeam: { openEditorWindow, getHomeDir: async () => '/Users/u' },
  })

  const mock = createMockBackend()
  mock.setResponse('fs.stat_path', { exists: opts.exists ?? true })
  const { result, scope } = withScope(() =>
    useTerminal('pane-1', mock.backend, workspacePath === undefined ? {} : { workspacePath })
  )
  const el = document.createElement('div')
  document.body.appendChild(el)
  result.mount(el)

  el.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      button: 0,
      clientX: 5,
      clientY: 10,
    })
  )
  // stat + home lookup + the picker's own workspace search.
  await flush()
  await flush()

  const input = document.querySelector('.term-file-picker-root input') as HTMLInputElement | null
  input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

  return { params: openEditorWindow.mock.calls[0]?.[0] as OpenParams | undefined, scope }
}

describe('useTerminal — ⌘-click opens a path in the mini-IDE', () => {
  it('keeps a file inside the pane workspace relative, with no file_ws', async () => {
    const { params, scope } = await cmdClickOpen('/ws/src/app.ts', '/ws')
    expect(params).toEqual({ workspace_path: '/ws', filepath: 'src/app.ts' })
    expect(params).not.toHaveProperty('file_ws')
    scope.stop()
  })

  it('names the file own root in file_ws for a file outside the pane workspace', async () => {
    // The mini-IDE stays on /ws and adds a tab for /ext/dir/notes.txt; without
    // file_ws it would reload onto /ext/dir and lose every open tab.
    const { params, scope } = await cmdClickOpen('/ext/dir/notes.txt', '/ws')
    expect(params).toEqual({
      workspace_path: '/ws',
      filepath: 'notes.txt',
      file_ws: '/ext/dir',
    })
    scope.stop()
  })

  it('tolerates a trailing slash on the pane workspace', async () => {
    const { params, scope } = await cmdClickOpen('/ws/src/app.ts', '/ws/')
    expect(params).toEqual({ workspace_path: '/ws', filepath: 'src/app.ts' })
    scope.stop()
  })

  it('falls back to the file own directory as workspace when the pane has none', async () => {
    // Previous behaviour, unchanged: with no workspace to stay on, there is
    // nothing for file_ws to be relative to.
    const { params, scope } = await cmdClickOpen('/ext/dir/notes.txt', undefined)
    expect(params).toEqual({ workspace_path: '/ext/dir', filepath: 'notes.txt' })
    expect(params).not.toHaveProperty('file_ws')
    scope.stop()
  })

  // Regression: an EMPTY-STRING workspace (a pane whose workspace was never
  // set, as opposed to `undefined`) used to pass `?? dir`, so `workspace_path`
  // went out as ''. The mini-IDE then reloaded as a workspace-less window and
  // opened nothing at all, because its entry-query open is gated on
  // `workspacePath && initialRel`.
  it('treats an empty-string pane workspace like no workspace, never sending an empty root', async () => {
    const { params, scope } = await cmdClickOpen('/ext/dir/notes.txt', '')
    expect(params).toEqual({ workspace_path: '/ext/dir', filepath: 'notes.txt' })
    expect(params?.workspace_path).not.toBe('')
    scope.stop()
  })

  it('carries the :line suffix through as a numeric line', async () => {
    const { params, scope } = await cmdClickOpen('/ws/src/app.ts:42', '/ws')
    expect(params).toEqual({ workspace_path: '/ws', filepath: 'src/app.ts', line: 42 })
    scope.stop()
  })

  it('uses the file own root for a file at the filesystem root', async () => {
    const { params, scope } = await cmdClickOpen('/notes.txt', '/ws')
    expect(params).toEqual({ workspace_path: '/ws', filepath: 'notes.txt', file_ws: '/' })
    scope.stop()
  })
})
