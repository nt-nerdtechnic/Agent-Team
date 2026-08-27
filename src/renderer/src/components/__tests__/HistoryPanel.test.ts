// @vitest-environment happy-dom
// Baseline coverage for the History view — it had none, and Phase B of the
// layout refactor moves it out of TokenStatsPanel into a slot container.
//
// The behaviours pinned here are the ones a move breaks quietly rather than
// loudly: the panel carries its own vertical split with a globally-keyed
// persisted height (it will collide with any other split in the same slot),
// the timeline sticks to the bottom only while the user is already there, and
// filters compose rather than override each other.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import HistoryPanel from '../HistoryPanel.vue'
import { settingsGet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import type { HistoryEvent } from '../../composables/useHistory'

type Handler = (raw: unknown) => void

function ev(over: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    id: 'e1', ts: '2026-08-22T10:00:00Z', type: 'log', summary: 'hello', stage_id: '', detail: null,
    ...over,
  } as HistoryEvent
}

function makeBackend(events: HistoryEvent[]) {
  const handlers: Record<string, Handler[]> = {}
  const backend = {
    status: ref('connected'),
    send: vi.fn(async () => ({ ok: true, payload: { events, path: '/ws/.agent-team/history.jsonl' } })),
    on: (e: string, cb: Handler) => {
      ;(handlers[e] ??= []).push(cb)
      return () => { handlers[e] = (handlers[e] ?? []).filter((h) => h !== cb) }
    },
  }
  return { backend, emit: (e: string, raw: unknown) => (handlers[e] ?? []).forEach((h) => h(raw)) }
}

const pipeline = { state: 'idle', log: [] as string[], projectId: '', projectFile: '', pipelineLogFile: '', backendLogFile: '' }

async function mountPanel(events: HistoryEvent[] = [], over: Record<string, unknown> = {}) {
  const { backend, emit } = makeBackend(events)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = mount(HistoryPanel as any, {
    props: { backend, workspacePath: '/ws', pipeline: { ...pipeline, ...over } },
    global: { mocks: { $t: (key: string) => key } },
  })
  await w.vm.$nextTick()
  await w.vm.$nextTick()
  return { w, emit }
}

function rows(w: VueWrapper): string[] {
  return w.findAll('.timeline .row .summary').map((n) => n.text())
}

describe('HistoryPanel', () => {
  beforeEach(() => {
    __resetSettingsForTest()
  })

  it('renders the timeline from the snapshot and appends live events', async () => {
    const { w, emit } = await mountPanel([ev({ id: 'a', summary: 'first' })])
    expect(rows(w)).toEqual(['first'])
    emit('history.appended', { workspace_path: '/ws', event: ev({ id: 'b', summary: 'second' }) })
    await w.vm.$nextTick()
    expect(rows(w)).toEqual(['first', 'second'])
    w.unmount()
  })

  it('ignores appends belonging to a sibling workspace', async () => {
    const { w, emit } = await mountPanel([ev({ id: 'a', summary: 'first' })])
    emit('history.appended', { workspace_path: '/other', event: ev({ id: 'b', summary: 'stray' }) })
    await w.vm.$nextTick()
    expect(rows(w)).toEqual(['first'])
    w.unmount()
  })

  it('composes the type, stage and search filters instead of overriding', async () => {
    const { w } = await mountPanel([
      ev({ id: 'a', type: 'log', stage_id: 's1', summary: 'alpha' }),
      ev({ id: 'b', type: 'warning', stage_id: 's1', summary: 'alpha too' }),
      ev({ id: 'c', type: 'log', stage_id: 's2', summary: 'beta' }),
    ])
    const [typeSel, stageSel] = w.findAll('.filters .flt')
    await typeSel.setValue('log')
    expect(rows(w)).toEqual(['alpha', 'beta'])
    await stageSel.setValue('s1')
    expect(rows(w)).toEqual(['alpha'])
    await w.find('.filters .search').setValue('zzz')
    expect(rows(w)).toEqual([])
    expect(w.find('.msg').text()).toBe('label.no-events')
    w.unmount()
  })

  it('expands one row at a time without collapsing the others', async () => {
    const { w } = await mountPanel([
      ev({ id: 'a', summary: 'alpha', detail: { k: 1 } }),
      ev({ id: 'b', summary: 'beta', detail: { k: 2 } }),
    ])
    await w.findAll('.timeline .row')[0].trigger('click')
    await w.findAll('.timeline .row')[1].trigger('click')
    expect(w.findAll('.timeline .row.open')).toHaveLength(2)
    await w.findAll('.timeline .row')[0].trigger('click')
    expect(w.findAll('.timeline .row.open')).toHaveLength(1)
    w.unmount()
  })

  it('persists its split height under a key that is not scoped to a slot', async () => {
    // The key is global, so two panels carrying their own split cannot both
    // live in one slot without fighting over it. Phase B has to scope this.
    const { w } = await mountPanel()
    const grip = w.find('.log-resize')
    await grip.trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 160 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await w.vm.$nextTick()
    expect(settingsGet('agentTeam.history.logHeight', '')).toBe('220')
    expect(w.find('.log-panel').attributes('style')).toContain('220px')
    w.unmount()
  })

  it('clamps the split height to its static bounds', async () => {
    const { w } = await mountPanel()
    await w.find('.log-resize').trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: -5000 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await w.vm.$nextTick()
    expect(settingsGet('agentTeam.history.logHeight', '')).toBe('60')

    await w.find('.log-resize').trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 5000 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await w.vm.$nextTick()
    expect(settingsGet('agentTeam.history.logHeight', '')).toBe('480')
    w.unmount()
  })

  it('shows the console empty state until the pipeline logs something', async () => {
    const { w } = await mountPanel([], { log: [] })
    expect(w.find('.pipeline-log-empty').exists()).toBe(true)
    await w.setProps({ pipeline: { ...pipeline, log: ['boom: error happened', 'plain'] } })
    expect(w.find('.pipeline-log-empty').exists()).toBe(false)
    const lines = w.findAll('.pipeline-log-line')
    expect(lines[0].classes()).toContain('is-error')
    expect(lines[1].classes()).not.toContain('is-error')
    w.unmount()
  })
})
