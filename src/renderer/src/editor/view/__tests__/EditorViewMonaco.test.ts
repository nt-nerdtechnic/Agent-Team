// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import EditorViewMonaco from '../EditorViewMonaco.vue'

// Shared holder so tests can reach the fake editor/model created by the mock.
const holder = vi.hoisted(() => ({
  editor: null as unknown as Record<string, ReturnType<typeof vi.fn>> & {
    _fireContentChange: () => void
  },
  model: null as unknown as {
    _value: string
    getValue: ReturnType<typeof vi.fn>
    pushEditOperations: ReturnType<typeof vi.fn>
  },
  setModelMarkers: null as unknown as ReturnType<typeof vi.fn>,
  registerCodeLens: null as unknown as ReturnType<typeof vi.fn>,
  /** Providers handed to registerCodeLensProvider, newest last. */
  lensProviders: [] as Array<{
    onDidChange?: (cb: () => void) => { dispose(): void }
    provideCodeLenses: (model: unknown) => {
      lenses: Array<{ range: { startLineNumber: number }; command?: { title: string; arguments?: unknown[] } }>
    }
  }>,
  lensDisposes: [] as Array<ReturnType<typeof vi.fn>>,
  /** Handlers registered through editor.addCommand, newest last. */
  commands: [] as Array<(...args: unknown[]) => void>,
  /** Every decorations collection created, in creation order. */
  decorationSets: [] as Array<ReturnType<typeof vi.fn>>,
  emitterDisposes: [] as Array<ReturnType<typeof vi.fn>>,
}))

vi.mock('../monacoWorkers', () => ({}))

vi.mock('monaco-editor', () => {
  class Range {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  }

  function createFakeModel(initial: string) {
    const model = {
      _value: initial,
      _onChange: () => {},
      getValue: vi.fn(() => model._value),
      getLineCount: () => model._value.split('\n').length,
      getLineLength: (n: number) => {
        const lines = model._value.split('\n')
        if (n < 1 || n > lines.length) throw new Error(`Illegal value for lineNumber: ${n}`)
        return lines[n - 1].length
      },
      getFullModelRange: () => {
        const lines = model._value.split('\n')
        return new Range(1, 1, lines.length, lines[lines.length - 1].length + 1)
      },
      getLineContent: (n: number) => model._value.split('\n')[n - 1] ?? '',
      getLineMaxColumn: (n: number) => (model._value.split('\n')[n - 1] ?? '').length + 1,
      pushEditOperations: vi.fn((
        _sel: unknown,
        edits: Array<{ range: Range; text: string }>,
      ) => {
        for (const e of edits) {
          const lines = model._value.split('\n')
          const off = (ln: number, col: number) =>
            lines.slice(0, ln - 1).reduce((n, l) => n + l.length + 1, 0) + (col - 1)
          model._value =
            model._value.slice(0, off(e.range.startLineNumber, e.range.startColumn)) +
            e.text +
            model._value.slice(off(e.range.endLineNumber, e.range.endColumn))
        }
        model._onChange()
      }),
    }
    return model
  }

  const setModelMarkers = vi.fn()
  holder.setModelMarkers = setModelMarkers

  function create(_el: HTMLElement, opts: { value?: string }) {
    const model = createFakeModel(opts.value ?? '')
    const contentListeners: Array<() => void> = []
    model._onChange = () => contentListeners.forEach((f) => f())
    const editor = {
      getModel: () => model,
      getValue: vi.fn(() => model._value),
      setValue: vi.fn((v: string) => { model._value = v; model._onChange() }),
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      setPosition: vi.fn(),
      onDidChangeModelContent: (cb: () => void) => { contentListeners.push(cb); return { dispose() {} } },
      onDidChangeCursorPosition: () => ({ dispose() {} }),
      addCommand: vi.fn((_kb: number, handler: (...args: unknown[]) => void) => {
        holder.commands.push(handler)
        return `cmd-${holder.commands.length}`
      }),
      createDecorationsCollection: () => {
        const set = vi.fn()
        holder.decorationSets.push(set)
        return { set }
      },
      trigger: vi.fn(),
      focus: vi.fn(),
      dispose: vi.fn(),
      updateOptions: vi.fn(),
      getOption: vi.fn(() => 13),
      _fireContentChange: () => model._onChange(),
    }
    holder.editor = editor as never
    holder.model = model as never
    return editor
  }

  const tsDefaults = () => ({
    setCompilerOptions: vi.fn(),
    setDiagnosticsOptions: vi.fn(),
    setEagerModelSync: vi.fn(),
  })

  class Emitter<T> {
    private listeners: Array<(e: T) => void> = []
    event = (cb: (e: T) => void) => {
      this.listeners.push(cb)
      return { dispose: () => {} }
    }
    fire(e: T): void { this.listeners.forEach((f) => f(e)) }
    dispose = vi.fn()
    constructor() { holder.emitterDisposes.push(this.dispose) }
  }

  const registerCodeLensProvider = vi.fn((_sel: unknown, provider: never) => {
    holder.lensProviders.push(provider)
    const dispose = vi.fn()
    holder.lensDisposes.push(dispose)
    return { dispose }
  })
  holder.registerCodeLens = registerCodeLensProvider

  return {
    Range,
    Emitter,
    KeyMod: { CtrlCmd: 2048, Alt: 512 },
    KeyCode: { KeyF: 36, KeyS: 49, Slash: 90 },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    editor: {
      create,
      defineTheme: vi.fn(),
      setModelMarkers,
      ShowLightbulbIconMode: { OnCode: 'onCode' },
      OverviewRulerLane: { Left: 1 },
      EditorOption: { fontSize: 52, lineNumbers: 67 },
    },
    languages: {
      registerInlineCompletionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerCodeLensProvider,
      typescript: {
        ScriptTarget: { ESNext: 99 },
        ModuleKind: { ESNext: 99 },
        ModuleResolutionKind: { NodeJs: 2 },
        JsxEmit: { ReactJSX: 4 },
        typescriptDefaults: tsDefaults(),
        javascriptDefaults: tsDefaults(),
      },
    },
  }
})

function lastMarkers(): Array<{ startLineNumber: number; endLineNumber: number; endColumn: number }> {
  const calls = holder.setModelMarkers.mock.calls
  return calls[calls.length - 1][2]
}

beforeEach(() => {
  holder.setModelMarkers?.mockClear()
  holder.registerCodeLens?.mockClear()
  holder.lensProviders.length = 0
  holder.lensDisposes.length = 0
  holder.commands.length = 0
  holder.decorationSets.length = 0
  holder.emitterDisposes.length = 0
})

describe('EditorViewMonaco – diagnostics', () => {
  it('renders 1-based diagnostic lines without an off-by-one shift', async () => {
    const wrapper = mount(EditorViewMonaco, {
      props: {
        modelValue: 'a\nbb\nccc',
        diagnostics: [{ line: 1, col: 0, severity: 'error', message: 'boom' }],
      },
    })
    const markers = lastMarkers()
    expect(markers).toHaveLength(1)
    expect(markers[0].startLineNumber).toBe(1)
    expect(markers[0].endLineNumber).toBe(1)
    // endColumn = line length + 1 for line "a"
    expect(markers[0].endColumn).toBe(2)
    wrapper.unmount()
  })

  it('does not throw for an error on the last line and clamps out-of-range lines', async () => {
    const wrapper = mount(EditorViewMonaco, {
      props: {
        modelValue: 'a\nbb\nccc',
        diagnostics: [{ line: 3, col: 0, severity: 'error', message: 'last line' }],
      },
    })
    let markers = lastMarkers()
    expect(markers[0].startLineNumber).toBe(3)
    expect(markers[0].endColumn).toBe(4) // "ccc".length + 1

    // Stale diagnostic pointing past the document must be clamped, not throw.
    await wrapper.setProps({
      diagnostics: [{ line: 99, col: 0, severity: 'warning', message: 'stale' }],
    })
    markers = lastMarkers()
    expect(markers[0].startLineNumber).toBe(3)
    expect(markers[0].endLineNumber).toBe(3)
    wrapper.unmount()
  })
})

describe('EditorViewMonaco – external content updates', () => {
  it('applies external updates via pushEditOperations (undo preserved), not setValue', async () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: 'old text' } })
    await wrapper.setProps({ modelValue: 'new text' })
    expect(holder.model.pushEditOperations).toHaveBeenCalled()
    expect(holder.editor.setValue).not.toHaveBeenCalled()
    expect(holder.model._value).toBe('new text')
    wrapper.unmount()
  })

  it('skips re-serializing the document when the prop echoes the emitted value', async () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: 'abc' } })
    // Simulate the user typing: mutate the model then fire the change event.
    holder.model._value = 'abcd'
    holder.editor._fireContentChange()
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted?.[0]).toEqual(['abcd'])

    holder.model.getValue.mockClear()
    // Parent echoes the exact emitted string back as the prop.
    await wrapper.setProps({ modelValue: emitted![0][0] as string })
    await nextTick()
    // The watcher must bail on reference equality without a full getValue scan.
    expect(holder.model.getValue).not.toHaveBeenCalled()
    expect(holder.model.pushEditOperations).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

// ── Merge-conflict CodeLens + colouring ──────────────────────────────────────

const CONFLICT_FILE = [
  'line before',
  '<<<<<<< HEAD',
  'ours 1',
  'ours 2',
  '=======',
  'theirs 1',
  '>>>>>>> feature',
  'line after',
  '',
].join('\n')

const DIFF3_FILE = [
  '<<<<<<< HEAD',
  'ours 1',
  '||||||| base',
  'base 1',
  '=======',
  'theirs 1',
  '>>>>>>> feature',
  '',
].join('\n')

const TWO_CONFLICT_FILE = [
  '<<<<<<< HEAD',      // 1
  'alpha ours',        // 2
  '=======',           // 3
  'alpha theirs',      // 4
  '>>>>>>> feature',   // 5
  'middle',            // 6
  '<<<<<<< HEAD',      // 7
  'beta ours',         // 8
  '=======',           // 9
  'beta theirs',       // 10
  '>>>>>>> feature',   // 11
  '',
].join('\n')

function lenses() {
  const provider = holder.lensProviders[holder.lensProviders.length - 1]
  return provider.provideCodeLenses(holder.model).lenses
}

function runCommand(args: unknown): void {
  // Mirror the real command service, which prepends a services accessor.
  holder.commands[holder.commands.length - 1]({}, args)
}

describe('EditorViewMonaco – merge conflict CodeLens', () => {
  it('stays completely inert for a file without conflict markers', () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: 'plain\nfile\n' } })
    expect(holder.registerCodeLens).not.toHaveBeenCalled()
    // Only the base decorations collection exists — none for conflicts.
    expect(holder.decorationSets).toHaveLength(1)
    expect(holder.editor.updateOptions).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not offer lenses after typing into a conflict-free file', async () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: 'plain\n' } })
    holder.model._value = 'plainer\n'
    holder.editor._fireContentChange()
    await nextTick()
    expect(holder.registerCodeLens).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('enables codeLens and offers three actions on a 2-way conflict', () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: CONFLICT_FILE } })
    expect(holder.registerCodeLens).toHaveBeenCalledTimes(1)
    expect(holder.editor.updateOptions).toHaveBeenCalledWith({ codeLens: true })
    const ls = lenses()
    expect(ls.map((l) => l.command?.title)).toEqual([
      'Accept Current Change', 'Accept Incoming Change', 'Accept Both Changes',
    ])
    // Anchored on the `<<<<<<<` line (1-based).
    expect(ls.every((l) => l.range.startLineNumber === 2)).toBe(true)
    wrapper.unmount()
  })

  it('adds Accept Base only when the block carries a ||||||| section', () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: DIFF3_FILE } })
    expect(lenses().map((l) => l.command?.title)).toEqual([
      'Accept Current Change', 'Accept Incoming Change', 'Accept Both Changes', 'Accept Base',
    ])
    wrapper.unmount()
  })

  it('accepts the current side through pushEditOperations, not setValue', async () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: CONFLICT_FILE } })
    runCommand(lenses()[0].command!.arguments![0])
    expect(holder.model.pushEditOperations).toHaveBeenCalled()
    expect(holder.editor.setValue).not.toHaveBeenCalled()
    expect(holder.model._value).toBe('line before\nours 1\nours 2\nline after\n')
    await nextTick()
    // The parent is told about the change.
    expect(wrapper.emitted('update:modelValue')?.pop()).toEqual([holder.model._value])
    wrapper.unmount()
  })

  it('accepts the incoming side and the base side correctly', () => {
    let wrapper = mount(EditorViewMonaco, { props: { modelValue: DIFF3_FILE } })
    runCommand(lenses()[1].command!.arguments![0])
    expect(holder.model._value).toBe('theirs 1\n')
    wrapper.unmount()

    wrapper = mount(EditorViewMonaco, { props: { modelValue: DIFF3_FILE } })
    runCommand(lenses()[3].command!.arguments![0])
    expect(holder.model._value).toBe('base 1\n')
    wrapper.unmount()
  })

  it('accepts both sides in ours-then-theirs order', () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: CONFLICT_FILE } })
    runCommand(lenses()[2].command!.arguments![0])
    expect(holder.model._value).toBe('line before\nours 1\nours 2\ntheirs 1\nline after\n')
    wrapper.unmount()
  })

  it('recomputes line numbers after an earlier block is accepted', () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: TWO_CONFLICT_FILE } })
    let ls = lenses()
    expect(ls).toHaveLength(6)
    expect(ls[0].range.startLineNumber).toBe(1)
    expect(ls[3].range.startLineNumber).toBe(7)

    // Accept the first block: 5 lines collapse to 1, shifting the second block.
    runCommand(ls[0].command!.arguments![0])
    expect(holder.model._value).toBe('alpha ours\nmiddle\n<<<<<<< HEAD\nbeta ours\n=======\nbeta theirs\n>>>>>>> feature\n')

    ls = lenses()
    expect(ls).toHaveLength(3)
    expect(ls[0].range.startLineNumber).toBe(3)

    // …and the shifted lens still edits the right block.
    runCommand(ls[1].command!.arguments![0])
    expect(holder.model._value).toBe('alpha ours\nmiddle\nbeta theirs\n')
    wrapper.unmount()
  })

  it('fires onDidChange so Monaco re-requests lenses after every edit', () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: CONFLICT_FILE } })
    const changed = vi.fn()
    holder.lensProviders[0].onDidChange!(changed)
    holder.model._value = CONFLICT_FILE + 'more\n'
    holder.editor._fireContentChange()
    expect(changed).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('turns codeLens back off and clears decorations once conflicts are gone', () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: CONFLICT_FILE } })
    const conflictSet = holder.decorationSets[1]
    runCommand(lenses()[0].command!.arguments![0])
    expect(holder.editor.updateOptions).toHaveBeenLastCalledWith({ codeLens: false })
    expect(conflictSet).toHaveBeenLastCalledWith([])
    expect(lenses()).toHaveLength(0)
    wrapper.unmount()
  })
})

describe('EditorViewMonaco – merge conflict decorations', () => {
  it('paints whole-line ours/theirs blocks on a separate collection', () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: CONFLICT_FILE } })
    const items = holder.decorationSets[1].mock.calls[0][0] as Array<{
      range: { startLineNumber: number; endLineNumber: number }
      options: { isWholeLine: boolean; className: string; glyphMarginClassName?: string; overviewRuler?: unknown }
    }>
    expect(items).toHaveLength(2)
    expect(items[0].options.className).toBe('ev-dec-conflict-ours')
    expect(items[0].range.startLineNumber).toBe(2) // <<<<<<< line
    expect(items[0].range.endLineNumber).toBe(4)   // last ours line
    expect(items[1].options.className).toBe('ev-dec-conflict-theirs')
    expect(items[1].range.startLineNumber).toBe(5) // ======= line
    expect(items[1].range.endLineNumber).toBe(7)   // >>>>>>> line
    for (const it of items) {
      expect(it.options.isWholeLine).toBe(true)
      expect(it.options.glyphMarginClassName).toBe(`ev-glyph-${it.options.className.replace('ev-dec-', '')}`)
      // Conflict blocks must not hijack the diff overview ruler.
      expect(it.options.overviewRuler).toBeUndefined()
    }
    wrapper.unmount()
  })

  it('paints a third band for the diff3 base block', () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: DIFF3_FILE } })
    const items = holder.decorationSets[1].mock.calls[0][0] as Array<{
      range: { startLineNumber: number; endLineNumber: number }
      options: { className: string }
    }>
    expect(items.map((i) => i.options.className)).toEqual([
      'ev-dec-conflict-ours', 'ev-dec-conflict-base', 'ev-dec-conflict-theirs',
    ])
    expect(items[1].range.startLineNumber).toBe(3) // ||||||| line
    expect(items[1].range.endLineNumber).toBe(4)   // base 1
    wrapper.unmount()
  })
})

describe('EditorViewMonaco – conflict lifecycle', () => {
  it('disposes the CodeLens provider and its emitter on unmount', () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: CONFLICT_FILE } })
    wrapper.unmount()
    expect(holder.lensDisposes[0]).toHaveBeenCalled()
    expect(holder.emitterDisposes[0]).toHaveBeenCalled()
  })

  it('registers exactly one provider per editor, even across many edits', () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: CONFLICT_FILE } })
    holder.model._value = CONFLICT_FILE + 'x\n'
    holder.editor._fireContentChange()
    holder.model._value = 'clean\n'
    holder.editor._fireContentChange()
    holder.model._value = CONFLICT_FILE
    holder.editor._fireContentChange()
    expect(holder.registerCodeLens).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('still costs a single getValue per content change on an ordinary file', () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: 'plain\n' } })
    holder.editor.getValue.mockClear()
    holder.model._value = 'plainer\n'
    holder.editor._fireContentChange()
    expect(holder.editor.getValue).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('re-arms conflict support when an external update swaps in a conflicted file', async () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: 'clean\n' } })
    expect(holder.registerCodeLens).not.toHaveBeenCalled()
    await wrapper.setProps({ modelValue: CONFLICT_FILE })
    expect(holder.registerCodeLens).toHaveBeenCalledTimes(1)
    expect(lenses()).toHaveLength(3)
    wrapper.unmount()
  })
})
