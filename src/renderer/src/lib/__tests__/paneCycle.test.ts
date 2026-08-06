import { describe, it, expect } from 'vitest'
import { nextPaneId } from '../paneCycle'

const order = ['a', 'b', 'c', 'd']

describe('nextPaneId', () => {
  it('walks forward', () => {
    expect(nextPaneId(order, 'a', 1)).toBe('b')
    expect(nextPaneId(order, 'c', 1)).toBe('d')
  })

  it('walks backward', () => {
    expect(nextPaneId(order, 'd', -1)).toBe('c')
    expect(nextPaneId(order, 'b', -1)).toBe('a')
  })

  it('wraps around at both ends', () => {
    expect(nextPaneId(order, 'd', 1)).toBe('a')
    expect(nextPaneId(order, 'a', -1)).toBe('d')
  })

  it('starts from the leading edge when nothing is focused', () => {
    expect(nextPaneId(order, null, 1)).toBe('a')
    expect(nextPaneId(order, null, -1)).toBe('d')
  })

  it('starts from the leading edge when the current pane is not in the list', () => {
    expect(nextPaneId(order, 'gone', 1)).toBe('a')
    expect(nextPaneId(order, 'gone', -1)).toBe('d')
  })

  it('returns null for an empty list', () => {
    expect(nextPaneId([], 'a', 1)).toBeNull()
    expect(nextPaneId([], null, -1)).toBeNull()
  })

  it('stays put with a single pane', () => {
    expect(nextPaneId(['only'], 'only', 1)).toBe('only')
    expect(nextPaneId(['only'], 'only', -1)).toBe('only')
  })
})
