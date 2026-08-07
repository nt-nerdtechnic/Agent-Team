// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  comparePlanRows,
  loadStoredChoice,
  planMatchesQuery,
  saveStoredChoice,
  type PlanSortDirection,
  type PlanSortMode,
  type SortablePlanRow,
} from '../plansPaneModel'

beforeEach(() => localStorage.clear())

describe('planMatchesQuery', () => {
  const fields = {
    title: 'Terminal Search',
    filename: 'terminal-search_a1b2c3.html',
    overview: 'Find logs fast',
  }

  it('matches everything on an empty or whitespace-only query', () => {
    expect(planMatchesQuery('', fields)).toBe(true)
    expect(planMatchesQuery('   ', fields)).toBe(true)
  })

  it('matches the title case-insensitively', () => {
    expect(planMatchesQuery('TERMINAL', fields)).toBe(true)
    expect(planMatchesQuery('terminal se', fields)).toBe(true)
  })

  it('matches the filename', () => {
    expect(planMatchesQuery('a1b2c3', fields)).toBe(true)
  })

  it('matches the overview text', () => {
    expect(planMatchesQuery('logs fast', fields)).toBe(true)
  })

  it('rejects a query that appears nowhere', () => {
    expect(planMatchesQuery('nope', fields)).toBe(false)
  })

  it('tolerates a missing overview', () => {
    expect(planMatchesQuery('logs', { title: 'A', filename: 'a.md' })).toBe(false)
    expect(planMatchesQuery('a.md', { title: 'A', filename: 'a.md' })).toBe(true)
  })
})

describe('comparePlanRows', () => {
  const row = (title: string, extra?: Partial<SortablePlanRow>): SortablePlanRow => ({
    title,
    done: 0,
    total: 0,
    ...extra,
  })

  const sortTitles = (
    mode: PlanSortMode,
    rows: SortablePlanRow[],
    direction?: PlanSortDirection,
  ): string[] =>
    [...rows].sort((a, b) => comparePlanRows(mode, a, b, direction)).map((r) => r.title)

  it('orders by title in title mode', () => {
    expect(sortTitles('title', [row('Zebra'), row('Apple'), row('Mango')])).toEqual([
      'Apple',
      'Mango',
      'Zebra',
    ])
  })

  it('orders newest mtime first in updated mode, missing mtime last', () => {
    const rows = [row('Old', { mtime: 100 }), row('New', { mtime: 200 }), row('None')]
    expect(sortTitles('updated', rows)).toEqual(['New', 'Old', 'None'])
  })

  it('falls back to title order on equal mtimes', () => {
    const rows = [row('Zebra', { mtime: 100 }), row('Apple', { mtime: 100 })]
    expect(sortTitles('updated', rows)).toEqual(['Apple', 'Zebra'])
  })

  it('orders by done/total ratio in progress mode, todo-less plans last', () => {
    const rows = [
      row('Half', { done: 1, total: 2 }),
      row('Full', { done: 2, total: 2 }),
      row('Empty', { done: 0, total: 3 }),
      row('NoTodos', { done: 0, total: 0 }),
    ]
    expect(sortTitles('progress', rows)).toEqual(['Full', 'Half', 'Empty', 'NoTodos'])
  })

  it('falls back to title order on equal progress', () => {
    const rows = [row('Zebra', { done: 1, total: 2 }), row('Apple', { done: 2, total: 4 })]
    expect(sortTitles('progress', rows)).toEqual(['Apple', 'Zebra'])
  })

  it('collates digits numerically so "Plan 2" precedes "Plan 10"', () => {
    expect(sortTitles('title', [row('Plan 10'), row('Plan 2'), row('Plan 1')])).toEqual([
      'Plan 1',
      'Plan 2',
      'Plan 10',
    ])
  })

  it('reverses each mode when the direction is flipped', () => {
    expect(sortTitles('title', [row('Apple'), row('Zebra')], 'desc')).toEqual(['Zebra', 'Apple'])
    expect(
      sortTitles('updated', [row('Old', { mtime: 100 }), row('New', { mtime: 200 })], 'asc'),
    ).toEqual(['Old', 'New'])
    expect(
      sortTitles('progress', [row('Full', { done: 2, total: 2 }), row('Empty', { done: 0, total: 2 })], 'asc'),
    ).toEqual(['Empty', 'Full'])
  })

  it('keeps rows missing the sort key at the bottom in both directions', () => {
    const updated = [row('Old', { mtime: 100 }), row('New', { mtime: 200 }), row('None')]
    expect(sortTitles('updated', updated, 'asc').at(-1)).toBe('None')
    expect(sortTitles('updated', updated, 'desc').at(-1)).toBe('None')

    const progress = [row('Half', { done: 1, total: 2 }), row('NoTodos'), row('Full', { done: 2, total: 2 })]
    expect(sortTitles('progress', progress, 'asc').at(-1)).toBe('NoTodos')
    expect(sortTitles('progress', progress, 'desc').at(-1)).toBe('NoTodos')
  })
})

describe('loadStoredChoice / saveStoredChoice', () => {
  const ALLOWED = ['title', 'updated', 'progress'] as const

  it('round-trips a valid stored value', () => {
    saveStoredChoice('navide.plans.sort./ws', 'updated')
    expect(loadStoredChoice('navide.plans.sort./ws', ALLOWED, 'title')).toBe('updated')
  })

  it('falls back on a missing key', () => {
    expect(loadStoredChoice('navide.plans.sort./missing', ALLOWED, 'title')).toBe('title')
  })

  it('falls back on a value outside the allowed set', () => {
    localStorage.setItem('navide.plans.sort./ws', 'garbage')
    expect(loadStoredChoice('navide.plans.sort./ws', ALLOWED, 'title')).toBe('title')
  })

  it('falls back when storage reads throw', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(loadStoredChoice('navide.plans.sort./ws', ALLOWED, 'title')).toBe('title')
    spy.mockRestore()
  })

  it('swallows storage write errors', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => saveStoredChoice('navide.plans.sort./ws', 'updated')).not.toThrow()
    spy.mockRestore()
  })
})
