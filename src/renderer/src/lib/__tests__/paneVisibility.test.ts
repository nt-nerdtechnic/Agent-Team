import { describe, expect, it } from 'vitest'
import {
  panesOfActiveTab,
  panesOfViewedWorkspace,
  type VisibilityPane,
} from '../paneVisibility'

// The two filters that decide what the stage draws. Both lived in App.vue and
// could only be grepped; both were changed three times while multi-workspace
// windows were built, and each wrong version was invisible until something
// else disagreed — a tab counting panes it would not show, a focused pane the
// grid filtered out.

const A = '/Users/me/alpha'
const B = '/Users/me/beta'
const ELSEWHERE = '/tmp/resumed-from-anywhere'

const pane = (id: string, ws: string, group?: string): VisibilityPane => ({
  id,
  workspacePath: ws,
  ...(group ? { runGroupId: group } : {}),
})

const ids = (s: Set<string>) => [...s].sort()

describe('panesOfViewedWorkspace', () => {
  it('returns the input itself when the window holds one workspace', () => {
    // Identity, not equality: this is what makes every downstream filter a
    // no-op for a single-workspace window.
    const panes = [pane('a1', A), pane('a2', A)]
    expect(panesOfViewedWorkspace(panes, [])).toBe(panes)
  })

  it('holds back only the other workspaces this window has', () => {
    const panes = [pane('a1', A), pane('b1', B)]
    expect(panesOfViewedWorkspace(panes, [B]).map((p) => p.id)).toEqual(['a1'])
  })

  it('keeps a pane whose workspace is in neither list', () => {
    // A manual resume can pull a session in from any folder; that pane was
    // always shown and must stay shown.
    const panes = [pane('a1', A), pane('odd', ELSEWHERE), pane('b1', B)]
    expect(panesOfViewedWorkspace(panes, [B]).map((p) => p.id)).toEqual(['a1', 'odd'])
  })

  it('treats a trailing slash as the same workspace', () => {
    const panes = [pane('b1', `${B}/`)]
    expect(panesOfViewedWorkspace(panes, [B])).toEqual([])
  })

  it('holds back several at once', () => {
    const panes = [pane('a1', A), pane('b1', B), pane('c1', '/Users/me/gamma')]
    expect(panesOfViewedWorkspace(panes, [B, '/Users/me/gamma']).map((p) => p.id)).toEqual(['a1'])
  })
})

describe('panesOfActiveTab', () => {
  const panes = [
    pane('g1', A, 'group-1'),
    pane('g2', A, 'group-1'),
    pane('h1', A, 'group-2'),
    pane('m1', A),
    pane('m2', A),
  ]
  const groupIds = ['group-1', 'group-2']

  it('shows everything when the window has no tabs', () => {
    expect(ids(panesOfActiveTab(panes, { hasTabs: false, activeTab: 'group-1', groupIds })))
      .toEqual(['g1', 'g2', 'h1', 'm1', 'm2'])
  })

  it('narrows to the selected run group', () => {
    expect(ids(panesOfActiveTab(panes, { hasTabs: true, activeTab: 'group-1', groupIds })))
      .toEqual(['g1', 'g2'])
  })

  it('shows the ungrouped panes on the manual tab', () => {
    expect(ids(panesOfActiveTab(panes, { hasTabs: true, activeTab: 'manual', groupIds })))
      .toEqual(['m1', 'm2'])
  })

  it('shows everything when the selected tab belongs to another workspace', () => {
    // Run-group ids are per workspace, so the tab id carried over from the one
    // you just left matches nothing. Showing everything beats a blank stage
    // while the new workspace's tabs load.
    expect(ids(panesOfActiveTab(panes, { hasTabs: true, activeTab: 'group-from-elsewhere', groupIds })))
      .toEqual(['g1', 'g2', 'h1', 'm1', 'm2'])
  })

  it('shows everything when no tab is selected', () => {
    expect(ids(panesOfActiveTab(panes, { hasTabs: true, activeTab: '', groupIds })))
      .toEqual(['g1', 'g2', 'h1', 'm1', 'm2'])
  })

  it('returns nothing for a group with no panes', () => {
    expect(ids(panesOfActiveTab(panes, { hasTabs: true, activeTab: 'group-3', groupIds: [...groupIds, 'group-3'] })))
      .toEqual([])
  })
})

describe('the two layers together', () => {
  it('a tab never reaches into another workspace', () => {
    // Both workspaces have a group of the same id — impossible in practice
    // (ids are uuids) but it is the failure this ordering prevents.
    const panes = [pane('a1', A, 'shared'), pane('b1', B, 'shared')]
    const here = panesOfViewedWorkspace(panes, [B])
    expect(ids(panesOfActiveTab(here, { hasTabs: true, activeTab: 'shared', groupIds: ['shared'] })))
      .toEqual(['a1'])
  })

  it('the manual tab does not collect another workspace\'s ungrouped panes', () => {
    // The bug that made a tab read "3" with nothing behind it: counts were
    // taken over every pane in the window while the stage filtered by
    // workspace first.
    const panes = [pane('a1', A), pane('b1', B), pane('b2', B)]
    const here = panesOfViewedWorkspace(panes, [B])
    expect(ids(panesOfActiveTab(here, { hasTabs: true, activeTab: 'manual', groupIds: ['g'] })))
      .toEqual(['a1'])
  })
})
