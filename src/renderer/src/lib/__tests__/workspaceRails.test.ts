import { describe, expect, it } from 'vitest'
import {
  ALL_RAIL_ID,
  assignToRail,
  buildRailCells,
  createRail,
  deleteRail,
  filterRowsByRail,
  parseRails,
  railGlyph,
  railIdOf,
  renameRail,
  resolveActiveRail,
  serializeRails,
  type WorkspaceRail,
} from '../workspaceRails'

// The sidebar's rail strip, run for real. Everything here is pure: the
// component owns the sessionStorage read/write and the rendering, so these
// cover the model itself — membership, counts, and what survives bad input.

const A = '/Users/me/Desktop/alpha'
const B = '/Users/me/Desktop/beta'
const C = '/Users/me/Git/gamma'

const rail = (id: string, name: string, members: string[] = []): WorkspaceRail => ({
  id,
  name,
  members,
})
const row = (path: string, count: number): { path: string; count: number } => ({ path, count })

const cells = (over: Partial<Parameters<typeof buildRailCells>[0]> = {}) =>
  buildRailCells({
    rails: [],
    rows: [],
    currentPath: '',
    activeId: ALL_RAIL_ID,
    allLabel: '全部',
    ...over,
  })

describe('railGlyph', () => {
  it('takes the first character of a name', () => {
    expect(railGlyph('客戶案')).toBe('客')
    expect(railGlyph('Products')).toBe('P')
  })

  it('takes a whole code point, not half a surrogate pair', () => {
    expect(railGlyph('🚀 rockets')).toBe('🚀')
  })

  it('ignores leading whitespace and survives an empty name', () => {
    expect(railGlyph('  spaced')).toBe('s')
    expect(railGlyph('   ')).toBe('?')
  })
})

describe('membership', () => {
  it('reports the rail a workspace belongs to, and ALL when it belongs to none', () => {
    const rails = [rail('wr-1', '產品', [A]), rail('wr-2', '客戶', [B])]
    expect(railIdOf(rails, A)).toBe('wr-1')
    expect(railIdOf(rails, B)).toBe('wr-2')
    expect(railIdOf(rails, C)).toBe(ALL_RAIL_ID)
  })

  it('matches paths whose trailing slashes differ', () => {
    expect(railIdOf([rail('wr-1', '產品', [`${A}/`])], A)).toBe('wr-1')
    expect(railIdOf([rail('wr-1', '產品', [A])], `${A}/`)).toBe('wr-1')
  })

  it('is exclusive: assigning to one rail drops the path from the others', () => {
    const rails = [rail('wr-1', '產品', [A, B]), rail('wr-2', '客戶', [])]
    const next = assignToRail(rails, A, 'wr-2')
    expect(next[0].members).toEqual([B])
    expect(next[1].members).toEqual([A])
  })

  it('assigning to ALL takes the path out of every rail', () => {
    const rails = [rail('wr-1', '產品', [A, B])]
    expect(assignToRail(rails, A, ALL_RAIL_ID)[0].members).toEqual([B])
  })

  it('does not duplicate a path already in the target rail', () => {
    const rails = [rail('wr-1', '產品', [A])]
    expect(assignToRail(rails, A, 'wr-1')[0].members).toEqual([A])
  })

  it('leaves untouched rails identical, so renders do not churn', () => {
    const rails = [rail('wr-1', '產品', [A]), rail('wr-2', '客戶', [B])]
    const next = assignToRail(rails, C, 'wr-1')
    expect(next[1]).toBe(rails[1])
  })
})

describe('rail lifecycle', () => {
  it('creates a rail with a minted id and no members', () => {
    const next = createRail([], '客戶案', 1700000000000)
    expect(next).toHaveLength(1)
    expect(next[0].id).toBe('wr-1700000000000')
    expect(next[0].name).toBe('客戶案')
    expect(next[0].members).toEqual([])
  })

  it('refuses a blank name rather than making an invisible cell', () => {
    expect(createRail([], '   ')).toEqual([])
    const rails = [rail('wr-1', '產品')]
    expect(renameRail(rails, 'wr-1', '  ')[0].name).toBe('產品')
  })

  it('trims names on create and rename', () => {
    expect(createRail([], '  客戶案  ')[0].name).toBe('客戶案')
    expect(renameRail([rail('wr-1', '產品')], 'wr-1', ' 內部 ')[0].name).toBe('內部')
  })

  it('deleting a rail keeps its workspaces, which fall back to ALL', () => {
    const rails = [rail('wr-1', '產品', [A])]
    const next = deleteRail(rails, 'wr-1')
    expect(next).toEqual([])
    expect(railIdOf(next, A)).toBe(ALL_RAIL_ID)
  })
})

describe('resolveActiveRail', () => {
  it('keeps a rail that exists', () => {
    expect(resolveActiveRail([rail('wr-1', '產品')], 'wr-1')).toBe('wr-1')
  })

  it('falls back to ALL when the stored rail is gone', () => {
    // Otherwise the sidebar filters by a rail nobody can see and renders empty
    // with no visible cause.
    expect(resolveActiveRail([rail('wr-1', '產品')], 'wr-9')).toBe(ALL_RAIL_ID)
    expect(resolveActiveRail([], 'wr-1')).toBe(ALL_RAIL_ID)
  })
})

describe('filterRowsByRail', () => {
  const rows = [row(A, 19), row(B, 3), row(C, 1)]

  it('ALL shows every row', () => {
    expect(filterRowsByRail(rows, [], ALL_RAIL_ID)).toEqual(rows)
  })

  it('a rail shows only its members', () => {
    const rails = [rail('wr-1', '產品', [A, C])]
    expect(filterRowsByRail(rows, rails, 'wr-1').map((r) => r.path)).toEqual([A, C])
  })

  it('keeps the list order rather than the membership order', () => {
    const rails = [rail('wr-1', '產品', [C, A])]
    expect(filterRowsByRail(rows, rails, 'wr-1').map((r) => r.path)).toEqual([A, C])
  })

  it('a rail whose members are all closed shows nothing, not everything', () => {
    const rails = [rail('wr-1', '客戶', ['/Users/me/Desktop/never-opened'])]
    expect(filterRowsByRail(rows, rails, 'wr-1')).toEqual([])
  })

  it('an unknown rail id shows everything rather than nothing', () => {
    expect(filterRowsByRail(rows, [rail('wr-1', '產品', [A])], 'wr-9')).toEqual(rows)
  })
})

describe('buildRailCells', () => {
  const rows = [row(A, 19), row(B, 3), row(C, 1)]

  it('always puts ALL first, totalling every held pane', () => {
    const out = cells({ rows })
    expect(out[0].id).toBe(ALL_RAIL_ID)
    expect(out[0].glyph).toBe('全')
    expect(out[0].count).toBe(23)
    expect(out[0].active).toBe(true)
  })

  it('takes the ALL glyph from the label it is given, so it follows the locale', () => {
    expect(cells({ allLabel: 'All' })[0].glyph).toBe('A')
  })

  it('sums only the members this window actually holds', () => {
    const rails = [rail('wr-1', '產品', [A, B, '/Users/me/Desktop/closed'])]
    expect(cells({ rows, rails })[1].count).toBe(22)
  })

  it('marks the rail holding the workspace on screen', () => {
    const rails = [rail('wr-1', '產品', [A]), rail('wr-2', '客戶', [B])]
    const out = cells({ rows, rails, currentPath: B })
    expect(out[1].hasCurrent).toBe(false)
    expect(out[2].hasCurrent).toBe(true)
  })

  it('never dots ALL, which holds the current workspace by definition', () => {
    expect(cells({ rows, currentPath: A })[0].hasCurrent).toBe(false)
  })

  it('marks a rail with no open member as empty but still returns it', () => {
    const rails = [rail('wr-1', '客戶', ['/Users/me/Desktop/closed'])]
    const out = cells({ rows, rails })
    expect(out).toHaveLength(2)
    expect(out[1].empty).toBe(true)
    expect(out[1].count).toBe(0)
  })

  it('marks the active rail, and ALL when the active one is gone', () => {
    const rails = [rail('wr-1', '產品', [A])]
    expect(cells({ rows, rails, activeId: 'wr-1' }).map((c) => c.active)).toEqual([false, true])
    expect(cells({ rows, rails, activeId: 'wr-9' }).map((c) => c.active)).toEqual([true, false])
  })
})

describe('persistence', () => {
  it('round-trips', () => {
    const rails = [rail('wr-1', '產品', [A]), rail('wr-2', '客戶', [B, C])]
    expect(parseRails(serializeRails(rails))).toEqual(rails)
  })

  it('treats nothing stored as no rails', () => {
    expect(parseRails(null)).toEqual([])
    expect(parseRails('')).toEqual([])
  })

  it('survives corrupt data with the grouping lost, not the sidebar', () => {
    expect(parseRails('{oh no')).toEqual([])
    expect(parseRails('"a string"')).toEqual([])
    expect(parseRails('{"id":"wr-1"}')).toEqual([])
  })

  it('drops only the malformed entries', () => {
    const raw = JSON.stringify([
      { id: 'wr-1', name: '產品', members: [A] },
      { id: '', name: 'no id', members: [] },
      { id: 'wr-2', name: '   ', members: [] },
      null,
      'nope',
      { id: 'wr-3', name: '客戶', members: [B, 7, null] },
    ])
    expect(parseRails(raw)).toEqual([
      rail('wr-1', '產品', [A]),
      rail('wr-3', '客戶', [B]),
    ])
  })

  it('enforces exclusive membership on the way in', () => {
    const raw = JSON.stringify([
      { id: 'wr-1', name: '產品', members: [A, A, B] },
      { id: 'wr-2', name: '客戶', members: [B, C] },
    ])
    expect(parseRails(raw)).toEqual([rail('wr-1', '產品', [A, B]), rail('wr-2', '客戶', [C])])
  })

  it('drops a duplicate id rather than letting two cells share it', () => {
    const raw = JSON.stringify([
      { id: 'wr-1', name: '產品', members: [A] },
      { id: 'wr-1', name: '重複', members: [B] },
    ])
    expect(parseRails(raw)).toEqual([rail('wr-1', '產品', [A])])
  })

  it('normalises trailing slashes so membership compares equal', () => {
    expect(parseRails(JSON.stringify([{ id: 'wr-1', name: '產品', members: [`${A}/`] }]))).toEqual([
      rail('wr-1', '產品', [A]),
    ])
  })
})
