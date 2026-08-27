import { describe, expect, it } from 'vitest'
import { buildStageTabs, type StageTabInput, type TabPane } from '../stageTabs'

// The tab strip's shape. It lived in App.vue and could only be grepped, and
// two of the things it decides are hard to reason about from the source: which
// groups a detached window hides, and when the synthetic tab exists at all.

const pane = (id: string, group?: string): TabPane => ({ id, ...(group ? { runGroupId: group } : {}) })
const G1 = { id: 'g1', name: 'Main work' }
const G2 = { id: 'g2', name: 'Review' }

function tabs(over: Partial<StageTabInput> = {}) {
  return buildStageTabs({
    panes: [],
    groups: [],
    isDetached: false,
    detachedGroupId: '',
    detachedGroupIds: new Set<string>(),
    manualLabel: 'manual',
    orphanLabel: 'orphan',
    ...over,
  })
}

describe('buildStageTabs', () => {
  it('makes one tab per run group, in the given order', () => {
    expect(tabs({ groups: [G1, G2] }).map((t) => [t.key, t.label])).toEqual([
      ['g1', 'Main work'],
      ['g2', 'Review'],
    ])
  })

  it('counts a group over the panes it will show', () => {
    const t = tabs({
      groups: [G1, G2],
      panes: [pane('a', 'g1'), pane('b', 'g1'), pane('c', 'g2')],
    })
    expect(t.find((x) => x.key === 'g1')?.count).toBe(2)
    expect(t.find((x) => x.key === 'g1')?.paneIds).toEqual(['a', 'b'])
    expect(t.find((x) => x.key === 'g2')?.count).toBe(1)
  })

  it('keeps an empty group as a tab', () => {
    // The group exists in the project; a tab with nothing in it is still a
    // place to spawn into.
    const t = tabs({ groups: [G1] })
    expect(t).toHaveLength(1)
    expect(t[0].count).toBe(0)
  })

  it('adds the synthetic tab only when something is ungrouped', () => {
    expect(tabs({ groups: [G1], panes: [pane('a', 'g1')] }).some((t) => t.type === 'manual')).toBe(false)
    const t = tabs({ groups: [G1], panes: [pane('a', 'g1'), pane('m')] })
    const manual = t.find((x) => x.type === 'manual')
    expect(manual?.key).toBe('manual')
    expect(manual?.paneIds).toEqual(['m'])
  })

  it('shows the synthetic tab even with no run groups left', () => {
    // Groups can be deleted while their panes are not; those panes still need
    // somewhere to appear.
    const t = tabs({ groups: [], panes: [pane('m1'), pane('m2')] })
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ type: 'manual', count: 2 })
  })

  it('puts the synthetic tab last', () => {
    const t = tabs({ groups: [G1, G2], panes: [pane('m')] })
    expect(t[t.length - 1].type).toBe('manual')
  })

  it('hides a group this window handed to a detached child', () => {
    const t = tabs({ groups: [G1, G2], detachedGroupIds: new Set(['g1']) })
    expect(t.map((x) => x.key)).toEqual(['g2'])
  })

  it('shows only its own group in a detached window', () => {
    const t = tabs({
      groups: [G1, G2],
      isDetached: true,
      detachedGroupId: 'g2',
      panes: [pane('a', 'g1'), pane('b', 'g2')],
    })
    expect(t.map((x) => x.key)).toEqual(['g2'])
    expect(t[0].paneIds).toEqual(['b'])
  })

  it('never gives a detached window the synthetic tab', () => {
    // It is one group's view; ungrouped panes are not its to show.
    const t = tabs({
      groups: [G1],
      isDetached: true,
      detachedGroupId: 'g1',
      panes: [pane('a', 'g1'), pane('m')],
    })
    expect(t.some((x) => x.type === 'manual')).toBe(false)
  })

  it('leaves an ordinary window untouched by both detach filters', () => {
    const t = tabs({ groups: [G1, G2], panes: [pane('a', 'g1'), pane('m')] })
    expect(t.map((x) => x.key)).toEqual(['g1', 'g2', 'manual'])
  })

  it('surfaces an orphan tab for panes whose group record is missing', () => {
    // A pane with a missing group record is given an orphan tab so it is not
    // lost from the UI while keeping its run group identity.
    const t = tabs({ groups: [G1], panes: [pane('a', 'g1'), pane('ghost', 'deleted-group')] })
    expect(t).toHaveLength(2)
    expect(t[0].paneIds).toEqual(['a'])
    expect(t[1]).toMatchObject({ key: 'deleted-group', label: 'orphan', paneIds: ['ghost'] })
  })
})
