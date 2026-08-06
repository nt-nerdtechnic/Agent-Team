import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  BUILT_IN_EDITORS,
  buildEditorArgv,
  classifyOpenRequest,
  detectEditors,
  expandTemplate,
  launchEditorProcess,
  normalizeEditorId,
  resolveEditorCommand,
  whichIn,
  type DetectedEditor,
  type EditorPreference,
  type EditorProcess
} from './editors'

const prefer = (editorId: string, customCommand: string[] = []): EditorPreference => ({
  editorId,
  customCommand
})

describe('classifyOpenRequest exemptions', () => {
  // These are the requests an external editor structurally cannot serve. They
  // must ignore the preference entirely — a missed exemption turns the Git
  // window's "Open changes" into "open the raw file in VS Code".
  it('sends a diff open to the mini-IDE even when an external editor is chosen', () => {
    const route = classifyOpenRequest(
      { filepath: 'src/app.ts', diff_filepath: 'src/app.ts', diff_staged: '1' },
      prefer('vscode')
    )
    expect(route).toEqual({ via: 'mini-ide', reason: 'diff' })
  })

  it('sends a branch-diff open to the mini-IDE', () => {
    const route = classifyOpenRequest(
      { branch_diff_base: 'main', branch_diff_compare: 'feature' },
      prefer('vscode')
    )
    expect(route).toEqual({ via: 'mini-ide', reason: 'diff' })
  })

  it('sends a bare open (no filepath) to the mini-IDE', () => {
    expect(classifyOpenRequest({ workspace_path: '/ws' }, prefer('vscode'))).toEqual({
      via: 'mini-ide',
      reason: 'bare'
    })
  })

  it('sends sidebar-driven opens to the mini-IDE', () => {
    expect(classifyOpenRequest({ filepath: 'a.ts', sidebar: 'search' }, prefer('vscode'))).toEqual({
      via: 'mini-ide',
      reason: 'sidebar'
    })
    expect(classifyOpenRequest({ filepath: 'a.ts', sidebar: 'git' }, prefer('vscode'))).toEqual({
      via: 'mini-ide',
      reason: 'sidebar'
    })
  })

  it('does not exempt the explorer sidebar', () => {
    expect(
      classifyOpenRequest({ filepath: 'a.ts', sidebar: 'explorer' }, prefer('vscode'))
    ).toEqual({ via: 'external', editorId: 'vscode' })
  })
})

describe('classifyOpenRequest routing', () => {
  it('defaults to the mini-IDE', () => {
    expect(classifyOpenRequest({ filepath: 'a.ts' }, prefer('mini-ide'))).toEqual({
      via: 'mini-ide',
      reason: 'preference'
    })
  })

  it('routes to the OS default application', () => {
    expect(classifyOpenRequest({ filepath: 'a.ts' }, prefer('system'))).toEqual({ via: 'system' })
  })

  it('routes to a built-in external editor', () => {
    expect(classifyOpenRequest({ filepath: 'a.ts' }, prefer('cursor'))).toEqual({
      via: 'external',
      editorId: 'cursor'
    })
  })

  it('routes to custom only when a command exists', () => {
    expect(classifyOpenRequest({ filepath: 'a.ts' }, prefer('custom', ['code', '{file}']))).toEqual(
      { via: 'external', editorId: 'custom' }
    )
    expect(classifyOpenRequest({ filepath: 'a.ts' }, prefer('custom'))).toEqual({
      via: 'mini-ide',
      reason: 'preference'
    })
  })

  it('falls back to the mini-IDE for an unknown editor id', () => {
    expect(classifyOpenRequest({ filepath: 'a.ts' }, prefer('emacs-from-the-future'))).toEqual({
      via: 'mini-ide',
      reason: 'preference'
    })
  })
})

describe('normalizeEditorId', () => {
  it('accepts known ids', () => {
    expect(normalizeEditorId('vscode')).toBe('vscode')
    expect(normalizeEditorId('system')).toBe('system')
    expect(normalizeEditorId(' cursor ')).toBe('cursor')
  })

  it('falls back for unknown, blank, and non-string values', () => {
    expect(normalizeEditorId('nope')).toBe('mini-ide')
    expect(normalizeEditorId('')).toBe('mini-ide')
    expect(normalizeEditorId(null)).toBe('mini-ide')
    expect(normalizeEditorId(42)).toBe('mini-ide')
  })

  it('rejects custom without a command', () => {
    expect(normalizeEditorId('custom')).toBe('mini-ide')
    expect(normalizeEditorId('custom', ['code'])).toBe('custom')
  })
})

describe('expandTemplate', () => {
  it('substitutes placeholders inside their own argv entry', () => {
    expect(
      expandTemplate(['code', '-g', '{file}:{line}'], { file: '/ws/a.ts', line: 12 })
    ).toEqual(['code', '-g', '/ws/a.ts:12'])
  })

  it('keeps a path with spaces as one argument', () => {
    expect(expandTemplate(['code', '{file}'], { file: '/My Projects/a b.ts' })).toEqual([
      'code',
      '/My Projects/a b.ts'
    ])
  })

  it('never splits shell metacharacters into extra arguments', () => {
    expect(expandTemplate(['code', '{file}'], { file: '/ws/a;rm -rf b.ts' })).toEqual([
      'code',
      '/ws/a;rm -rf b.ts'
    ])
  })

  it('drops an argument that is only an unset placeholder', () => {
    expect(expandTemplate(['code', '--line', '{line}', '{file}'], { file: '/ws/a.ts' })).toEqual([
      'code',
      '--line',
      '/ws/a.ts'
    ])
  })

  it('resolves an unset placeholder mixed with text to empty', () => {
    expect(expandTemplate(['code', '{file}:{line}'], { file: '/ws/a.ts' })).toEqual([
      'code',
      '/ws/a.ts:'
    ])
  })

  it('substitutes dir and workspace', () => {
    expect(expandTemplate(['code', '{dir}', '--ws', '{workspace}'], {
      dir: '/ws/sub',
      workspace: '/ws'
    })).toEqual(['code', '/ws/sub', '--ws', '/ws'])
  })

  it('treats line 0 as unset', () => {
    expect(expandTemplate(['code', '{line}', '{file}'], { file: '/a.ts', line: 0 })).toEqual([
      'code',
      '/a.ts'
    ])
  })
})

describe('whichIn', () => {
  const exists = (paths: string[]) => (p: string): boolean => paths.includes(p)
  const always = (): boolean => true

  it('returns the first PATH hit', () => {
    const hit = whichIn('code', '/opt/bin:/usr/bin', exists(['/usr/bin/code', '/opt/bin/other']), always)
    expect(hit).toBe('/usr/bin/code')
  })

  it('prefers earlier PATH entries', () => {
    const hit = whichIn('code', '/opt/bin:/usr/bin', exists(['/opt/bin/code', '/usr/bin/code']), always)
    expect(hit).toBe('/opt/bin/code')
  })

  it('returns null when nothing is found', () => {
    expect(whichIn('code', '/opt/bin:/usr/bin', exists([]), always)).toBeNull()
  })

  it('requires the executable bit', () => {
    expect(whichIn('code', '/usr/bin', exists(['/usr/bin/code']), () => false)).toBeNull()
  })

  it('accepts an absolute name directly', () => {
    expect(whichIn('/custom/code', '', exists(['/custom/code']), always)).toBe('/custom/code')
    expect(whichIn('/custom/code', '', exists([]), always)).toBeNull()
  })

  it('tolerates an empty PATH', () => {
    expect(whichIn('code', '', exists(['/usr/bin/code']), always)).toBeNull()
  })
})

describe('resolveEditorCommand', () => {
  const vscode = BUILT_IN_EDITORS.find((e) => e.id === 'vscode')!
  const always = (): boolean => true

  it('resolves from PATH', () => {
    const hit = resolveEditorCommand(vscode, '/usr/bin', (p) => p === '/usr/bin/code', always)
    expect(hit).toBe('/usr/bin/code')
  })

  it('falls back to the .app-bundled CLI when PATH has no hit', () => {
    // The common macOS case: VS Code is installed but its shell command was
    // never added to PATH (that is a separate opt-in step).
    const bundled = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
    const hit = resolveEditorCommand(vscode, '/usr/bin', (p) => p === bundled, always)
    expect(hit).toBe(bundled)
  })

  it('returns null when the editor is not installed at all', () => {
    expect(resolveEditorCommand(vscode, '/usr/bin', () => false, always)).toBeNull()
  })
})

describe('detectEditors', () => {
  it('reports availability per editor', () => {
    const found = detectEditors('/usr/bin', (p) => p === '/usr/bin/cursor', () => true)
    expect(found.map((e) => e.id).sort()).toEqual(['cursor', 'vscode'])
    expect(found.find((e) => e.id === 'cursor')).toEqual({
      id: 'cursor',
      command: '/usr/bin/cursor',
      available: true
    })
    expect(found.find((e) => e.id === 'vscode')).toEqual({
      id: 'vscode',
      command: '',
      available: false
    })
  })
})

class FakeEditorProcess implements EditorProcess {
  private errorListeners: ((code: number | null) => void)[] = []
  private exitListeners: ((code: number | null) => void)[] = []
  unrefCount = 0

  once(event: 'error' | 'exit', listener: (code: number | null) => void): unknown {
    if (event === 'error') this.errorListeners.push(listener)
    else this.exitListeners.push(listener)
    return this
  }

  unref(): void {
    this.unrefCount += 1
  }

  emitError(): void {
    // The error listener takes no argument; the payload is ignored.
    for (const listener of this.errorListeners) listener(null)
  }

  emitExit(code: number | null): void {
    for (const listener of this.exitListeners) listener(code)
  }
}

describe('launchEditorProcess', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports failure when the process cannot be spawned', async () => {
    const launched = await launchEditorProcess(() => {
      throw new Error('ENOENT')
    })
    expect(launched).toBe(false)
  })

  it('reports failure on an error event', async () => {
    vi.useFakeTimers()
    const child = new FakeEditorProcess()
    const pending = launchEditorProcess(() => child, 800)
    child.emitError()
    await expect(pending).resolves.toBe(false)
  })

  it('reports failure on a non-zero exit inside the window', async () => {
    vi.useFakeTimers()
    const child = new FakeEditorProcess()
    const pending = launchEditorProcess(() => child, 800)
    child.emitExit(1)
    await expect(pending).resolves.toBe(false)
  })

  it('treats an immediate exit 0 as success — GUI editors hand off and exit', async () => {
    vi.useFakeTimers()
    const child = new FakeEditorProcess()
    const pending = launchEditorProcess(() => child, 800)
    child.emitExit(0)
    await vi.advanceTimersByTimeAsync(800)
    await expect(pending).resolves.toBe(true)
  })

  it('reports success and detaches when nothing happens in the window', async () => {
    vi.useFakeTimers()
    const child = new FakeEditorProcess()
    const pending = launchEditorProcess(() => child, 800)
    await vi.advanceTimersByTimeAsync(800)
    await expect(pending).resolves.toBe(true)
    expect(child.unrefCount).toBe(1)
  })

  it('does not detach when the launch already failed', async () => {
    vi.useFakeTimers()
    const child = new FakeEditorProcess()
    const pending = launchEditorProcess(() => child, 800)
    child.emitExit(127)
    await expect(pending).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(child.unrefCount).toBe(0)
  })

  it('ignores a late failure after the window closed', async () => {
    vi.useFakeTimers()
    const child = new FakeEditorProcess()
    const pending = launchEditorProcess(() => child, 800)
    await vi.advanceTimersByTimeAsync(800)
    await expect(pending).resolves.toBe(true)
    child.emitExit(1) // user quit the editor later — not a launch failure
    await expect(pending).resolves.toBe(true)
  })
})

describe('buildEditorArgv', () => {
  const detected: DetectedEditor[] = [
    { id: 'vscode', command: '/usr/bin/code', available: true },
    { id: 'cursor', command: '', available: false }
  ]

  it('builds a file open with a goto flag', () => {
    expect(buildEditorArgv('vscode', detected, [], { file: '/ws/a.ts', line: 7 })).toEqual([
      '/usr/bin/code',
      '-g',
      '/ws/a.ts:7'
    ])
  })

  it('omits the goto flag without a line', () => {
    expect(buildEditorArgv('vscode', detected, [], { file: '/ws/a.ts' })).toEqual([
      '/usr/bin/code',
      '/ws/a.ts'
    ])
  })

  it('builds a folder open', () => {
    expect(buildEditorArgv('vscode', detected, [], { dir: '/ws' })).toEqual(['/usr/bin/code', '/ws'])
  })

  it('returns null for an undetected editor', () => {
    expect(buildEditorArgv('cursor', detected, [], { file: '/ws/a.ts' })).toBeNull()
  })

  it('returns null for an unknown editor id', () => {
    expect(buildEditorArgv('emacs', detected, [], { file: '/ws/a.ts' })).toBeNull()
  })

  it('expands a custom template', () => {
    expect(
      buildEditorArgv('custom', detected, ['subl', '{file}:{line}'], { file: '/ws/a.ts', line: 3 })
    ).toEqual(['subl', '/ws/a.ts:3'])
  })

  it('returns null when the custom template is empty', () => {
    expect(buildEditorArgv('custom', detected, [], { file: '/ws/a.ts' })).toBeNull()
  })
})
