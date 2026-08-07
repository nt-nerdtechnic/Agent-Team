// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import QuestionAlert from '../QuestionAlert.vue'

// Coverage for dropping a file onto an answer box. The path is stabilized
// first (macOS reclaims screenshot temp files moments after the drag), which
// made the handler async — so these also pin the insertion point, which now
// has to survive an await.

const mockGetPathForFile = vi.fn<(f: File) => string>()
const mockStabilize = vi.fn<(paths: string[]) => Promise<{ ok: boolean; paths: string[] }>>()

function fileDropEvent(paths: string[]): Event {
  const files = paths.map((p) => new File([''], p.split('/').pop() ?? 'f'))
  files.forEach((_f, i) => mockGetPathForFile.mockReturnValueOnce(paths[i]))
  const items = files.map((file) => ({ kind: 'file', type: '', getAsFile: () => file }))
  const ev = new Event('drop', { bubbles: true, cancelable: true })
  Object.assign(ev, {
    dataTransfer: {
      types: ['Files'],
      items: { length: items.length, ...Object.fromEntries(items.map((it, i) => [i, it])),
        [Symbol.iterator]: function* () { yield* items } },
      files: { length: files.length, ...Object.fromEntries(files.map((f, i) => [i, f])),
        [Symbol.iterator]: function* () { yield* files } },
      getData: () => ''
    }
  })
  return ev
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** The modal is teleported to body, so it is not inside the wrapper's tree. */
function answerBox(): HTMLTextAreaElement {
  const el = document.body.querySelector('textarea')
  expect(el, 'answer textarea should be rendered').not.toBeNull()
  return el as HTMLTextAreaElement
}

/** Types into the box the way the component's @input handler expects. */
function typeInto(box: HTMLTextAreaElement, text: string): void {
  box.value = text
  box.dispatchEvent(new Event('input'))
}

describe('QuestionAlert – dropping a file onto an answer box', () => {
  let wrapper: VueWrapper

  beforeEach(async () => {
    mockGetPathForFile.mockReset()
    mockStabilize.mockReset()
    vi.stubGlobal('window', {
      ...window,
      agentTeam: { getPathForFile: mockGetPathForFile, stabilizeDroppedPaths: mockStabilize }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = mount(QuestionAlert as any, {
      props: {
        visible: true,
        questions: [{ prompt: 'Which file?', type: 'text', options: [] }]
      },
      global: { mocks: { $t: (key: string) => key } }
    })
    await settle()
  })

  afterEach(() => {
    wrapper.unmount()
    vi.unstubAllGlobals()
  })

  async function drop(paths: string[]): Promise<void> {
    answerBox().dispatchEvent(fileDropEvent(paths))
    await settle()
  }

  it('inserts the stabilized path, not the temp path macOS is about to reclaim', async () => {
    mockStabilize.mockResolvedValue({ ok: true, paths: ['/userData/dropped-files/shot.png'] })
    await drop(['/var/folders/T/TemporaryItems/NSIRD_x/shot.png'])

    expect(answerBox().value).toBe('/userData/dropped-files/shot.png')
  })

  it('falls back to the raw path when the bridge is unavailable', async () => {
    vi.stubGlobal('window', { ...window, agentTeam: { getPathForFile: mockGetPathForFile } })
    await drop(['/Users/test/notes.md'])

    expect(answerBox().value).toBe('/Users/test/notes.md')
  })

  it('inserts at the caret rather than overwriting what is already typed', async () => {
    const box = answerBox()
    typeInto(box, 'see  please')
    await settle()
    answerBox().selectionStart = 4 // between "see " and " please"
    mockStabilize.mockResolvedValue({ ok: true, paths: ['/a/shot.png'] })
    await drop(['/a/shot.png'])

    expect(answerBox().value).toBe('see /a/shot.png please')
  })

  it('ignores a drop that carries no resolvable path', async () => {
    mockGetPathForFile.mockReturnValue('')
    typeInto(answerBox(), 'typed')
    await settle()
    answerBox().dispatchEvent(fileDropEvent([]))
    await settle()

    expect(mockStabilize).not.toHaveBeenCalled()
    expect(answerBox().value).toBe('typed')
  })
})
