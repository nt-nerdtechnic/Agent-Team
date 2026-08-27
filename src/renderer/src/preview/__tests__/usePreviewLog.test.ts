// The record track's merge rules live in the backend; what has to be pinned
// here is that the renderer mirrors them faithfully. The one that bites is the
// upsert: the store re-broadcasts an upgraded row with the SAME uid, so a
// naive append would show one file change twice.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { usePreviewLog, MAX_ENTRIES, type PreviewLogEntry } from '../usePreviewLog'

type Listener = (payload: unknown) => void

function makeEntry(over: Partial<PreviewLogEntry> = {}): PreviewLogEntry {
  return {
    uid: '1000:1',
    created_at: 1000,
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

// `root` mirrors what the backend resolves a workspace to: `undefined` echoes
// the requested path back (the common case, a window opened at the project
// root), a string stands in for a window opened on a subdirectory, and `null`
// omits the field entirely — a backend too old to report it.
function makeBackend(rows: PreviewLogEntry[] = [], root?: string | null) {
  const listeners = new Map<string, Listener[]>()
  const status = ref<string>('connected')
  const snapshots: Record<string, unknown>[] = []
  const clears: Record<string, unknown>[] = []
  const send = vi.fn(async (type: string, payload?: Record<string, unknown>) => {
    if (type === 'preview.log_snapshot') {
      snapshots.push(payload ?? {})
      const resolved = root === undefined ? payload?.workspace_path : root
      return {
        ok: true,
        payload:
          resolved === null
            ? { entries: rows.slice() }
            : { entries: rows.slice(), root: resolved },
      }
    }
    if (type === 'preview.log_clear') {
      clears.push(payload ?? {})
      return { ok: true, payload: { removed: rows.length } }
    }
    return { ok: true, payload: {} }
  })
  const on = (type: string, cb: Listener) => {
    const list = listeners.get(type) ?? []
    list.push(cb)
    listeners.set(type, list)
    return () => {
      listeners.set(type, (listeners.get(type) ?? []).filter((c) => c !== cb))
    }
  }
  function emit(type: string, payload: unknown): void {
    for (const cb of listeners.get(type) ?? []) cb(payload)
  }
  return {
    backend: { status, send, on },
    emit,
    snapshots,
    clears,
    setRows: (r: PreviewLogEntry[]) => { rows = r },
    setRoot: (r: string | null) => { root = r },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mount(fake: ReturnType<typeof makeBackend>, ws = '/ws'): any {
  const workspacePath = ref(ws)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = usePreviewLog(fake.backend as any, workspacePath)
  return { log, workspacePath }
}

describe('usePreviewLog', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    usePreviewLog(makeBackend().backend as any, ref('')).reset()
  })

  it('hydrates from a snapshot on the connected transition', async () => {
    const fake = makeBackend([makeEntry({ uid: 'a' }), makeEntry({ uid: 'b' })])
    const { log } = mount(fake)
    await nextTick()
    expect(log.entries.value.map((e: PreviewLogEntry) => e.uid)).toEqual(['a', 'b'])
    expect(fake.snapshots[0]).toEqual({ workspace_path: '/ws', limit: MAX_ENTRIES })
  })

  it('upserts a re-broadcast row instead of showing the change twice', async () => {
    const fake = makeBackend([makeEntry({ uid: 'x', source: 'watcher', agent: null })])
    const { log } = mount(fake)
    await nextTick()
    expect(log.entries.value).toHaveLength(1)

    // The store upgraded the watcher row: same uid, now attributed.
    fake.emit('preview.recorded', {
      workspace_path: '/ws',
      entry: makeEntry({ uid: 'x', source: 'agent', agent: 'claude', created_at: 2000 }),
    })
    expect(log.entries.value).toHaveLength(1)
    expect(log.entries.value[0].source).toBe('agent')
    expect(log.entries.value[0].agent).toBe('claude')
  })

  it('ignores rows recorded for another workspace', async () => {
    const fake = makeBackend([])
    const { log } = mount(fake)
    await nextTick()
    fake.emit('preview.recorded', {
      workspace_path: '/other',
      entry: makeEntry({ uid: 'foreign' }),
    })
    expect(log.entries.value).toHaveLength(0)
  })

  it('applies a whole watcher burst sent as one frame, newest last', async () => {
    const fake = makeBackend([])
    const { log } = mount(fake)
    await nextTick()
    // The file watcher coalesces a burst (a `git checkout` can debounce
    // thousands of paths) into a single event carrying `entries`.
    fake.emit('preview.recorded', {
      workspace_path: '/ws',
      entries: [
        makeEntry({ uid: 'a', created_at: 1000 }),
        makeEntry({ uid: 'b', created_at: 1001 }),
      ],
    })
    expect(log.entries.value.map((e: PreviewLogEntry) => e.uid)).toEqual(['b', 'a'])
  })

  it('ignores a burst recorded for another workspace', async () => {
    const fake = makeBackend([])
    const { log } = mount(fake)
    await nextTick()
    fake.emit('preview.recorded', {
      workspace_path: '/other',
      entries: [makeEntry({ uid: 'foreign' })],
    })
    expect(log.entries.value).toHaveLength(0)
  })

  it('caps the track even if the backend keeps sending rows', async () => {
    const fake = makeBackend([])
    const { log } = mount(fake)
    await nextTick()
    for (let i = 0; i < MAX_ENTRIES + 20; i++) {
      fake.emit('preview.recorded', {
        workspace_path: '/ws',
        entry: makeEntry({ uid: `u${i}`, created_at: 1000 + i }),
      })
    }
    expect(log.entries.value).toHaveLength(MAX_ENTRIES)
    // Newest first, so the oldest rows are the ones that went.
    expect(log.entries.value[0].uid).toBe(`u${MAX_ENTRIES + 19}`)
  })

  it('re-snapshots on reconnect to recover events missed while down', async () => {
    const fake = makeBackend([makeEntry({ uid: 'a' })])
    const { log } = mount(fake)
    await nextTick()
    expect(fake.snapshots).toHaveLength(1)

    fake.backend.status.value = 'disconnected'
    await nextTick()
    fake.setRows([makeEntry({ uid: 'a' }), makeEntry({ uid: 'missed' })])
    fake.backend.status.value = 'connected'
    await nextTick()
    await nextTick()
    expect(fake.snapshots).toHaveLength(2)
    expect(log.entries.value.map((e: PreviewLogEntry) => e.uid)).toContain('missed')
  })

  it('drops the previous workspace rows when the project switches', async () => {
    const fake = makeBackend([makeEntry({ uid: 'a' })])
    const { log, workspacePath } = mount(fake)
    await nextTick()
    expect(log.entries.value).toHaveLength(1)
    fake.setRows([])
    workspacePath.value = '/other'
    await nextTick()
    expect(log.entries.value).toHaveLength(0)
  })

  it('clear asks the backend to keep anything recorded after the click', async () => {
    const fake = makeBackend([makeEntry({ uid: 'old', created_at: 10 })])
    const { log } = mount(fake)
    await nextTick()
    const removed = await log.clear()
    expect(removed).toBe(1)
    expect(log.entries.value).toHaveLength(0)
    expect(typeof fake.clears[0].before).toBe('number')
    expect(fake.clears[0].workspace_path).toBe('/ws')
  })

  it('applies another window clear broadcast to its own track', async () => {
    const fake = makeBackend([makeEntry({ uid: 'old', created_at: 10 })])
    const { log } = mount(fake)
    await nextTick()
    fake.emit('preview.log_cleared', { workspace_path: '/ws', before: 500, removed: 1 })
    expect(log.entries.value).toHaveLength(0)
  })

  // A window opened on a subdirectory of a repository: the backend resolves
  // every write and every broadcast to the project root, so matching on the
  // raw path this window was opened with drops every live row.
  it('applies rows broadcast under the root the snapshot resolved', async () => {
    const fake = makeBackend([], '/repo')
    const { log } = mount(fake, '/repo/pkg')
    await nextTick()
    await nextTick()
    fake.emit('preview.recorded', {
      workspace_path: '/repo',
      entry: makeEntry({ uid: 'resolved' }),
    })
    expect(log.entries.value.map((e: PreviewLogEntry) => e.uid)).toEqual(['resolved'])

    fake.emit('preview.log_cleared', { workspace_path: '/repo', before: 5000, removed: 1 })
    expect(log.entries.value).toHaveLength(0)
  })

  it('still ignores another workspace once the root is known', async () => {
    const fake = makeBackend([], '/repo')
    const { log } = mount(fake, '/repo/pkg')
    await nextTick()
    await nextTick()
    fake.emit('preview.recorded', {
      workspace_path: '/elsewhere',
      entry: makeEntry({ uid: 'foreign' }),
    })
    expect(log.entries.value).toHaveLength(0)
  })

  it('falls back to the raw path while the root is unknown', async () => {
    // Nothing has answered yet — and a backend too old to report `root` never
    // will. Matching the raw path is the old behaviour; accepting everything
    // would let another workspace's rows onto this track.
    const fake = makeBackend([], null)
    const { log } = mount(fake, '/ws')
    fake.emit('preview.recorded', { workspace_path: '/ws', entry: makeEntry({ uid: 'early' }) })
    expect(log.entries.value.map((e: PreviewLogEntry) => e.uid)).toEqual(['early'])

    await nextTick()
    await nextTick()
    fake.emit('preview.recorded', { workspace_path: '/ws', entry: makeEntry({ uid: 'late' }) })
    expect(log.entries.value.map((e: PreviewLogEntry) => e.uid)).toContain('late')
    fake.emit('preview.recorded', { workspace_path: '/other', entry: makeEntry({ uid: 'no' }) })
    expect(log.entries.value.map((e: PreviewLogEntry) => e.uid)).not.toContain('no')
  })

  it('does not keep the previous project root after a switch', async () => {
    const fake = makeBackend([], '/repo')
    const { log, workspacePath } = mount(fake, '/repo/pkg')
    await nextTick()
    await nextTick()

    fake.setRoot('/other')
    workspacePath.value = '/other/pkg'
    await nextTick()
    await nextTick()

    fake.emit('preview.recorded', { workspace_path: '/repo', entry: makeEntry({ uid: 'stale' }) })
    expect(log.entries.value).toHaveLength(0)
    fake.emit('preview.recorded', { workspace_path: '/other', entry: makeEntry({ uid: 'fresh' }) })
    expect(log.entries.value.map((e: PreviewLogEntry) => e.uid)).toEqual(['fresh'])
  })
})
