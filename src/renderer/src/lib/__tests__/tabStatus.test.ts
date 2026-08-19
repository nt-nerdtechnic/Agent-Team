// rollupTabStatus — one dot per StageTabBar tab, rolled up from the statuses of
// the panes in that tab. Two colours by design: "is anything moving here?"
// Every case below is a rule the UI depends on, so a change in the vocabulary
// (a new DisplayStatus, say) fails here rather than silently reading as idle.
import { describe, expect, it } from 'vitest'
import { rollupTabStatus, sameRenderedTabs } from '../tabStatus'

describe('rollupTabStatus', () => {
  it('reports empty for a tab with no panes', () => {
    expect(rollupTabStatus([])).toBe('empty')
  })

  it('reports empty when every pane is an unrealized cold-restore placeholder', () => {
    expect(rollupTabStatus(['waiting', 'waiting'])).toBe('empty')
  })

  it('reports active when any pane is running', () => {
    expect(rollupTabStatus(['idle', 'idle', 'running'])).toBe('active')
  })

  it('counts starting as active — the CLI is booting, not stalled', () => {
    expect(rollupTabStatus(['idle', 'starting'])).toBe('active')
  })

  it('reports idle when every pane is idle', () => {
    expect(rollupTabStatus(['idle', 'idle'])).toBe('idle')
  })

  it.each([
    ['awaiting'],
    ['stopped'],
    ['exited'],
    ['error'],
    ['disconnected'],
  ])('reports idle for a tab whose panes are all %s — none of them will move on their own', (status) => {
    expect(rollupTabStatus([status, status])).toBe('idle')
  })

  it('lets a realized pane outweigh unrealized placeholders', () => {
    expect(rollupTabStatus(['waiting', 'idle'])).toBe('idle')
    expect(rollupTabStatus(['waiting', 'running'])).toBe('active')
  })

  it('does not treat an unknown status as active', () => {
    expect(rollupTabStatus(['something-new'])).toBe('idle')
  })
})

describe('sameRenderedTabs', () => {
  const tabs = [
    { key: 'rg-1', label: 'Main', count: 2, status: 'active' as const },
    { key: 'rg-2', label: 'Specs', count: 1, status: 'idle' as const }
  ]

  it('treats an identical list as unchanged', () => {
    expect(sameRenderedTabs(tabs, tabs.map((t) => ({ ...t })))).toBe(true)
  })

  it.each([
    ['status', { status: 'idle' as const }],
    ['count', { count: 3 }],
    ['label', { label: 'Renamed' }],
    ['key', { key: 'rg-9' }]
  ])('sees a changed %s', (_field, patch) => {
    const next = [{ ...tabs[0], ...patch }, tabs[1]]
    expect(sameRenderedTabs(tabs, next)).toBe(false)
  })

  it('sees an added or removed tab', () => {
    expect(sameRenderedTabs(tabs, tabs.slice(0, 1))).toBe(false)
    expect(sameRenderedTabs(tabs.slice(0, 1), tabs)).toBe(false)
  })
})
