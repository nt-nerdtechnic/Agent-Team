import { describe, expect, it } from 'vitest'
import { flattenSidebarOrder, resolveFocusedPane, type SidebarSection } from '../paneFocus'
import type { LineageRow } from '../workspaceGroups'

// Both of these produced a visible fault while multi-workspace windows were
// built, and both lived in App.vue where they could only be grepped.

const p = (id: string) => ({ id })
const none = new Set<string>()
const row = (id: string, depth = 0): LineageRow => ({ id, depth, hasChildren: false, collapsed: false, ancestors: [], descendantCount: 0 })
const section = (isCurrent: boolean, ...ids: string[]): SidebarSection => ({
  isCurrent,
  lineage: ids.map((id) => row(id)),
})

describe('resolveFocusedPane', () => {
  it('keeps the requested pane when the stage can show it', () => {
    expect(resolveFocusedPane('b', [p('a'), p('b')], none)).toBe('b')
  })

  it('falls back when the requested pane is not on this stage', () => {
    // The blank main area: focus was set in another workspace, and the caller
    // passes only the workspace on screen.
    expect(resolveFocusedPane('elsewhere', [p('a'), p('b')], none)).toBe('a')
  })

  it('falls back when the requested pane is minimized', () => {
    // Docked, not on the stage — returning it leaves the stage empty just as
    // surely as naming a pane from another workspace.
    expect(resolveFocusedPane('a', [p('a'), p('b')], new Set(['a']))).toBe('b')
  })

  it('skips minimized panes when falling back', () => {
    expect(resolveFocusedPane(null, [p('a'), p('b'), p('c')], new Set(['a', 'b']))).toBe('c')
  })

  it('answers null when every pane is minimized', () => {
    expect(resolveFocusedPane('a', [p('a'), p('b')], new Set(['a', 'b']))).toBeNull()
  })

  it('answers null with no panes at all', () => {
    expect(resolveFocusedPane('a', [], none)).toBeNull()
    expect(resolveFocusedPane(null, [], none)).toBeNull()
  })

  it('takes the first pane when nothing is requested', () => {
    expect(resolveFocusedPane(null, [p('a'), p('b')], none)).toBe('a')
    expect(resolveFocusedPane('', [p('a')], none)).toBe('a')
  })
})

describe('flattenSidebarOrder', () => {
  it('walks each of this window\'s workspaces in turn', () => {
    expect(flattenSidebarOrder([section(true, 'a1', 'a2'), section(true, 'b1')]))
      .toEqual(['a1', 'a2', 'b1'])
  })

  it('skips rows belonging to another window', () => {
    // Their panes have no terminal here, so a range must not sweep them in.
    expect(flattenSidebarOrder([section(true, 'a1'), section(false, 'r1'), section(true, 'b1')]))
      .toEqual(['a1', 'b1'])
  })

  it('preserves lineage order within a workspace', () => {
    // The rendered tree order, not spawn order — that is the whole point.
    const nested: SidebarSection = {
      isCurrent: true,
      lineage: [row('parent'), row('child', 1), row('sibling')],
    }
    expect(flattenSidebarOrder([nested])).toEqual(['parent', 'child', 'sibling'])
  })

  it('is empty when nothing is listed', () => {
    expect(flattenSidebarOrder([])).toEqual([])
    expect(flattenSidebarOrder([section(false, 'r1')])).toEqual([])
  })
})
