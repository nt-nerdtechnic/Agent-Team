// @vitest-environment happy-dom
// The panel is a dispatcher: every body is an existing component, so what has
// to be pinned is the wiring, not the rendering. Two of these are safety
// tests — the read-only flag on DiffPane and the empty sandbox on inline HTML
// — because losing either turns a read-only panel into one that can write to
// the working tree or execute pushed markup.
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, shallowMount } from '@vue/test-utils'
import { ref } from 'vue'
import PreviewPanel from '../PreviewPanel.vue'
import InlineHtmlPreview from '../InlineHtmlPreview.vue'
import DiffPane from '../../editor/DiffPane.vue'
import FilePreviewPane from '../../editor/FilePreviewPane.vue'
import { usePreview } from '../usePreview'
import { usePreviewLog, type PreviewLogEntry } from '../usePreviewLog'

// Rows the panel's record track hydrates from; each test sets what the fake
// snapshot returns before mounting.
let trackRows: PreviewLogEntry[] = []
const cleared: Record<string, unknown>[] = []

const backend = {
  httpUrl: ref('http://127.0.0.1:1234'),
  status: ref('connected'),
  send: async (type: string, payload?: Record<string, unknown>) => {
    if (type === 'preview.log_snapshot') return { ok: true, payload: { entries: trackRows.slice() } }
    if (type === 'preview.log_clear') {
      cleared.push(payload ?? {})
      return { ok: true, payload: { removed: trackRows.length } }
    }
    return { ok: true, payload: {} }
  },
  on: () => () => {},
} as unknown as Parameters<typeof mountPanel>[0]

function entry(over: Partial<PreviewLogEntry> = {}): PreviewLogEntry {
  return {
    uid: 'u1',
    created_at: Date.now(),
    change: 'modified',
    rel_path: 'src/a.ts',
    kind: 'file',
    title: null,
    source: 'watcher',
    pane_id: null,
    agent: null,
    tool: null,
    note: null,
    payload: null,
    ...over,
  }
}

// The track hydrates through an awaited send(), so a plain $nextTick is not
// enough to see the first snapshot land.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flush(w: any): Promise<void> {
  await w.vm.$nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await w.vm.$nextTick()
}

function mountPanel(_b?: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return shallowMount(PreviewPanel as any, {
    props: { backend, workspacePath: '/ws' },
    global: { mocks: { $t: (key: string) => key } },
  })
}

describe('PreviewPanel', () => {
  beforeEach(() => {
    usePreview().reset()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    usePreviewLog(backend as any, ref('/ws')).reset()
    trackRows = []
    cleared.length = 0
  })

  it('shows the empty state when nothing has been pushed', () => {
    const w = mountPanel()
    expect(w.find('.pv-empty').exists()).toBe(true)
    expect(w.find('.pv-hdr').exists()).toBe(false)
    w.unmount()
  })

  it('mounts FilePreviewPane for a file target with the paths it expects', async () => {
    usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'src/a.png' })
    const w = mountPanel()
    await w.vm.$nextTick()
    const fp = w.findComponent(FilePreviewPane)
    expect(fp.exists()).toBe(true)
    expect(fp.props('relPath')).toBe('src/a.png')
    expect(fp.props('workspacePath')).toBe('/ws')
    // The header shows the basename, not the whole path.
    expect(w.find('.pv-title').text()).toBe('a.png')
    w.unmount()
  })

  it('always mounts DiffPane read-only', async () => {
    usePreview().show({ kind: 'diff', workspacePath: '/ws', relPath: 'a.ts', staged: true })
    const w = mountPanel()
    await w.vm.$nextTick()
    const dp = w.findComponent(DiffPane)
    expect(dp.exists()).toBe(true)
    expect(dp.props('readonly')).toBe(true)
    expect(dp.props('staged')).toBe(true)
    expect(dp.props('filepath')).toBe('a.ts')
    w.unmount()
  })

  it('offers copy for inline content and open-in-editor for file-backed targets', async () => {
    const w = mountPanel()
    usePreview().show({ kind: 'snippet', content: 'const a = 1' })
    await w.vm.$nextTick()
    let labels = w.findAll('.pv-btn').map((b) => b.text())
    expect(labels).toContain('preview.copy')
    expect(labels).not.toContain('preview.open')

    usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'a.ts' })
    await w.vm.$nextTick()
    labels = w.findAll('.pv-btn').map((b) => b.text())
    expect(labels).toContain('preview.open')
    expect(labels).not.toContain('preview.copy')
    w.unmount()
  })

  it('flags a sandboxed HTML preview in the footer', async () => {
    usePreview().show({ kind: 'html', content: '<p>x</p>' })
    const w = mountPanel()
    await w.vm.$nextTick()
    expect(w.find('.pv-foot').text()).toContain('preview.sandboxed')
    w.unmount()
  })

  it('attributes agent pushes and stays silent for user actions', async () => {
    usePreview().show({ kind: 'markdown', content: '# t', source: 'agent', origin: 'claude' })
    const w = mountPanel()
    await w.vm.$nextTick()
    expect(w.find('.pv-foot').text()).toContain('claude')

    usePreview().show({ kind: 'markdown', content: '# t2', source: 'user' })
    await w.vm.$nextTick()
    expect(w.find('.pv-foot').text()).not.toContain('user')
    w.unmount()
  })

  it('refuses "open in editor" for a target from another workspace', async () => {
    // The payload's workspacePath is not validated anywhere upstream, so a
    // pushed target could otherwise aim a read-write editor window at an
    // arbitrary directory.
    usePreview().show({ kind: 'file', workspacePath: '/somewhere/else', relPath: 'id_rsa' })
    const w = mountPanel()
    await w.vm.$nextTick()
    expect(w.findAll('.pv-btn').map((b) => b.text())).not.toContain('preview.open')
    expect(w.find('.pv-foot').text()).toContain('preview.foreign-workspace')
    w.unmount()
  })

  it('still offers "open in editor" for the panel\'s own workspace', async () => {
    // Guard the guard: the refusal above must not be passing because the
    // button never renders.
    usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'a.ts' })
    const w = mountPanel()
    await w.vm.$nextTick()
    expect(w.findAll('.pv-btn').map((b) => b.text())).toContain('preview.open')
    expect(w.find('.pv-foot').text()).not.toContain('preview.foreign-workspace')
    w.unmount()
  })

  it('close clears the target back to the empty state', async () => {
    usePreview().show({ kind: 'snippet', content: 'x' })
    const w = mountPanel()
    await w.vm.$nextTick()
    await w.find('.pv-x').trigger('click')
    expect(w.find('.pv-empty').exists()).toBe(true)
    w.unmount()
  })
})

describe('PreviewPanel record track', () => {
  beforeEach(() => {
    usePreview().reset()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    usePreviewLog(backend as any, ref('/ws')).reset()
    trackRows = []
    cleared.length = 0
  })

  it('fills the panel with the track when nothing has been pushed', async () => {
    trackRows = [entry({ uid: 'a', rel_path: 'src/a.ts' })]
    const w = mountPanel()
    await flush(w)
    expect(w.find('.pv-live').exists()).toBe(false)
    expect(w.find('.pv-track-full').exists()).toBe(true)
    expect(w.findAll('.pv-row')).toHaveLength(1)
    // The empty state is what the track replaces, not something shown beside it.
    expect(w.find('.pv-empty').exists()).toBe(false)
    w.unmount()
  })

  it('keeps the live target above the track when both exist', async () => {
    trackRows = [entry({ uid: 'a' })]
    const w = mountPanel()
    await flush(w)
    usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'b.ts' })
    await w.vm.$nextTick()
    expect(w.find('.pv-live').exists()).toBe(true)
    expect(w.findComponent(FilePreviewPane).exists()).toBe(true)
    expect(w.find('.pv-track').exists()).toBe(true)
    expect(w.find('.pv-track-full').exists()).toBe(false)
    w.unmount()
  })

  it('shows the empty state when there is neither a target nor a record', async () => {
    const w = mountPanel()
    await flush(w)
    expect(w.find('.pv-empty').exists()).toBe(true)
    expect(w.findAll('.pv-row')).toHaveLength(0)
    w.unmount()
  })

  it('replays a recorded file into the live preview when its row is clicked', async () => {
    trackRows = [entry({ uid: 'a', rel_path: 'src/deep/a.ts' })]
    const w = mountPanel()
    await flush(w)
    await w.find('.pv-row').trigger('click')
    const t = usePreview().current.value
    expect(t).toMatchObject({ kind: 'file', workspacePath: '/ws', relPath: 'src/deep/a.ts' })
    w.unmount()
  })

  it('does not offer a deleted file for replay', async () => {
    trackRows = [entry({ uid: 'a', change: 'deleted' })]
    const w = mountPanel()
    await flush(w)
    const row = w.find('.pv-row')
    expect(row.attributes('disabled')).toBeDefined()
    await row.trigger('click')
    expect(usePreview().current.value).toBe(null)
    w.unmount()
  })

  it('names the author only when the record has one', async () => {
    trackRows = [
      entry({ uid: 'a', source: 'agent', agent: 'claude' }),
      entry({ uid: 'b', source: 'watcher', agent: null }),
    ]
    const w = mountPanel()
    await flush(w)
    const who = w.findAll('.pv-row-who').map((n) => n.text())
    expect(who).toEqual(['claude', '—'])
    w.unmount()
  })

  it('filters the track by source', async () => {
    trackRows = [
      entry({ uid: 'a', source: 'agent', agent: 'claude' }),
      entry({ uid: 'b', source: 'watcher' }),
    ]
    const w = mountPanel()
    await flush(w)
    expect(w.findAll('.pv-row')).toHaveLength(2)
    const agentFilter = w.findAll('.pv-btn').find((b) => b.text() === 'preview.filter-agent')
    await agentFilter?.trigger('click')
    expect(w.findAll('.pv-row')).toHaveLength(1)
    expect(w.find('.pv-row-who').text()).toBe('claude')
    w.unmount()
  })

  it('clear empties the track through the backend', async () => {
    // Stamped in the past on purpose: clear keeps anything recorded at or
    // after the click, so a row minted this same millisecond would survive.
    trackRows = [entry({ uid: 'a', created_at: Date.now() - 60_000 })]
    const w = mountPanel()
    await flush(w)
    const clearBtn = w.findAll('.pv-btn').find((b) => b.text() === 'preview.track-clear')
    await clearBtn?.trigger('click')
    await flush(w)
    expect(cleared).toHaveLength(1)
    expect(cleared[0].workspace_path).toBe('/ws')
    expect(w.findAll('.pv-row')).toHaveLength(0)
    w.unmount()
  })
})

describe('InlineHtmlPreview', () => {
  it('renders pushed HTML in a fully locked-down iframe', () => {
    // Two independent layers. sandbox="" (no allow-*) stops scripts, forms and
    // same-origin access; the injected CSP stops subresource requests, which
    // the sandbox attribute does NOT cover — without it a pushed
    // <img src="http://…"> would still phone home.
    const w = mount(InlineHtmlPreview, { props: { content: '<p>hi</p>', title: 't' } })
    const frame = w.find('iframe')
    expect(frame.attributes('sandbox')).toBe('')
    const srcdoc = frame.attributes('srcdoc') ?? ''
    expect(srcdoc).toContain("default-src 'none'")
    expect(srcdoc).toContain('<p>hi</p>')
    // The CSP must precede the content, or the document has already started
    // fetching by the time the policy is parsed.
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<p>hi</p>'))
    w.unmount()
  })
})
