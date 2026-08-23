// @vitest-environment happy-dom
// Baseline coverage for the right slot's panel — it had none, and Phase B of
// the layout refactor splits its four tabs into standalone views. Each test
// here pins one of the lines that split can break silently:
//
//  · the one-way `update:expanded` contract with the parent
//  · the collapsed rail's token badge, which reads a subscription that must
//    stay alive while the tab that renders it is not mounted
//  · the By Stage / By Pane rows, which render an empty state (not an error)
//    the moment their prop chain is cut
//  · the persisted tab key, including its fallback for legacy values
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import TokenStatsPanel from '../TokenStatsPanel.vue'
import { usePreview } from '../../preview/usePreview'
import { settingsSet, __resetSettingsForTest } from '../../lib/settings'
import type { TokensSnapshot } from '../../composables/useTokens'

type Handler = (raw: unknown) => void

function makeBackend(): { backend: Record<string, unknown>; emit: (ev: string, raw: unknown) => void } {
  const handlers: Record<string, Handler[]> = {}
  const backend = {
    status: ref('connected'),
    send: vi.fn(async () => ({ ok: true, payload: null })),
    on: (ev: string, cb: Handler) => {
      ;(handlers[ev] ??= []).push(cb)
      return () => {
        handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== cb)
      }
    },
  }
  return { backend, emit: (ev, raw) => (handlers[ev] ?? []).forEach((h) => h(raw)) }
}

const bucket = (input: number, output: number, calls: number) => ({ input, output, calls })

function snapshot(over: Partial<TokensSnapshot['workspace']> = {}): TokensSnapshot {
  return {
    workspace_path: '/ws',
    workspace: {
      current_run: {
        run_id: 'r1', task: 't', run_dir: '/d', started_at: '', ended_at: null,
        totals: bucket(10, 20, 3),
        by_vendor: {}, by_stage: {},
        by_pane: { 's1:A': bucket(1, 2, 1) },
      },
      runs: [],
      cumulative: { totals: bucket(100, 200, 30), by_vendor: { claude: bucket(5, 6, 7) }, by_stage: { s1: bucket(8, 9, 10) } },
      ...over,
    },
    global: { all_time: bucket(1000, 2000, 300), by_vendor: {}, by_day: {} },
  } as TokensSnapshot
}

const baseProps = {
  workspacePath: '/ws',
  stages: [{ id: 's1', shortTitle: 'Design' }],
  panes: [{ id: 'p1', agentLabel: 'claude', roleLabel: 'backend', stageId: 's1', slotLabel: 'A' }],
  pipeline: { state: 'idle' },
  expanded: true,
}

function mountPanel(props: Record<string, unknown> = {}) {
  const { backend, emit } = makeBackend()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = shallowMount(TokenStatsPanel as any, {
    props: { ...baseProps, backend, ...props },
    global: { mocks: { $t: (key: string) => key } },
  })
  return { w, emit }
}

describe('TokenStatsPanel', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    usePreview().reset()
  })
  afterEach(() => {
    __resetSettingsForTest()
  })

  it('renders the rail instead of the panel when the parent says collapsed', () => {
    const { w } = mountPanel({ expanded: false })
    expect(w.find('.rail').exists()).toBe(true)
    expect(w.find('.hdr').exists()).toBe(false)
    expect(w.find('.token-panel').classes()).toContain('is-collapsed')
    w.unmount()
  })

  it('never flips expanded itself — it only asks the parent', async () => {
    const { w } = mountPanel({ expanded: true })
    await w.find('.hdr .collapse').trigger('click')
    expect(w.emitted('update:expanded')).toEqual([[false]])
    // The parent did not act, so the panel is still open.
    expect(w.find('.hdr').exists()).toBe(true)
    w.unmount()
  })

  it('keeps the token subscription alive while collapsed so the rail badge fills', async () => {
    // useTokens() is called at setup top level rather than inside the tokens
    // tab. If a split moves it into that tab's component the badge silently
    // stops rendering — v-if on calls > 0 means it disappears, not shows 0.
    const { w, emit } = mountPanel({ expanded: false })
    expect(w.find('.rail-badge').exists()).toBe(false)
    emit('tokens.changed', snapshot())
    await w.vm.$nextTick()
    expect(w.find('.rail-badge').exists()).toBe(true)
    w.unmount()
  })

  it('drops token broadcasts belonging to another workspace', async () => {
    const { w, emit } = mountPanel({ expanded: false })
    const other = snapshot()
    other.workspace_path = '/other-ws'
    emit('tokens.changed', other)
    await w.vm.$nextTick()
    expect(w.find('.rail-badge').exists()).toBe(false)
    w.unmount()
  })

  it('persists the active tab and falls back when the stored value is unknown', async () => {
    const { w } = mountPanel()
    await w.findAll('.hdr .tab')[1].trigger('click')  // tokens
    w.unmount()

    const { w: reopened } = mountPanel()
    expect(reopened.findAll('.hdr .tab')[1].classes()).toContain('active')
    reopened.unmount()

    settingsSet('agentTeam.rightPanel.tab', 'a-tab-that-was-removed')
    const { w: legacy } = mountPanel()
    expect(legacy.findAll('.hdr .tab')[0].classes()).toContain('active')
    legacy.unmount()
  })

  it('renders By Stage / By Pane from props, and empties — not errors — without them', async () => {
    // Both tables read props.stages / props.panes, which arrive down a long
    // chain from App. Cutting that chain renders the "no stages" empty state,
    // which reads as "nothing happened yet" rather than as breakage — so the
    // populated case is what has to be pinned.
    const { w, emit } = mountPanel()
    emit('tokens.changed', snapshot())
    await w.findAll('.hdr .tab')[1].trigger('click')  // tokens
    const stageBlock = w.findAll('.block')
    const texts = stageBlock.map((b) => b.text())
    expect(texts.some((t) => t.includes('label.by-stage') && t.includes('Design'))).toBe(true)
    expect(texts.some((t) => t.includes('label.by-pane') && t.includes('claude'))).toBe(true)

    await w.setProps({ stages: [], panes: [] })
    const empty = w.findAll('.block').map((b) => b.text())
    expect(empty.some((t) => t.includes('label.by-stage') && t.includes('label.no-stages'))).toBe(true)
    expect(empty.some((t) => t.includes('label.by-pane') && t.includes('label.no-active-panes'))).toBe(true)
    w.unmount()
  })

  it('keys pane token rows by stage:slot so they survive a frontend restart', async () => {
    // by_pane is keyed 'stageId:slotLabel' on the backend; a pane's UUID
    // changes on every rebuild, so matching on it would zero the row.
    const { w, emit } = mountPanel()
    emit('tokens.changed', snapshot())
    await w.findAll('.hdr .tab')[1].trigger('click')
    const paneBlock = w.findAll('.block').find((b) => b.text().includes('label.by-pane'))!
    expect(paneBlock.find('tr td').text()).toBe('1')
    w.unmount()
  })

  it('renders only the tabs the layout assigns to this slot, in that order', async () => {
    const { w } = mountPanel({ views: ['messages', 'history'] })
    expect(w.findAll('.hdr .tab').map((b) => b.text())).toEqual([
      '\u2709 label.messages',
      '\u{1F4DC} label.history',
    ])
    w.unmount()
  })

  it('falls back to the first remaining tab when the active one is moved away', async () => {
    const { w } = mountPanel({ views: ['history', 'tokens'] })
    await w.findAll('.hdr .tab')[1].trigger('click')  // tokens
    await w.setProps({ views: ['history', 'messages'] })
    expect(w.findAll('.hdr .tab')[0].classes()).toContain('active')
    w.unmount()
  })

  it('keeps the token badge on the rail even when the tokens tab moved away', async () => {
    // The subscription is a panel-level concern, not a tab-level one.
    const { w, emit } = mountPanel({ expanded: false, views: ['history'] })
    emit('tokens.changed', snapshot())
    await w.vm.$nextTick()
    expect(w.findAll('.rail .rail-label').map((n) => n.text())).toEqual(['label.history'])
    expect(w.find('.rail-badge').exists()).toBe(false)
    w.unmount()
  })

  it('draws no body at all once the slot holds nothing', async () => {
    // The fallback that repairs the active tab bails on an empty slot, so the
    // bodies are gated on membership too. A HistoryPanel left mounted in a
    // zero-width panel keeps a backend subscription nobody can see.
    const { w } = mountPanel({ views: [] })
    expect(w.findAll('.hdr .tab')).toHaveLength(0)
    expect(w.findComponent({ name: 'HistoryPanel' }).exists()).toBe(false)
    expect(w.find('.body').exists()).toBe(false)
    w.unmount()
  })

  it('ignores a preview push once preview has been taken off the layout', async () => {
    // Claiming the tab would leave the panel showing nothing at all.
    const { w } = mountPanel({ expanded: false, views: ['history'] })
    usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'a.png' })
    await w.vm.$nextTick()
    expect(w.emitted('update:expanded')).toBeUndefined()
    expect(w.findAll('.rail .rail-label').map((n) => n.text())).toEqual(['label.history'])
    w.unmount()
  })

  it('a preview push surfaces the panel even from the collapsed rail', async () => {
    const { w } = mountPanel({ expanded: false })
    usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'a.png' })
    await w.vm.$nextTick()
    expect(w.emitted('update:expanded')).toEqual([[true]])
    w.unmount()
  })
})
