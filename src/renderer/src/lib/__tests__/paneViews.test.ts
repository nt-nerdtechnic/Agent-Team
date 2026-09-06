import { describe, it, expect } from 'vitest'
import { sameRenderedPaneViews } from '../paneViews'

/** A pane snapshot shaped like the ones syncViews builds: primitives only. */
function view(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    agentKey: 'claude',
    agentLabel: 'Claude',
    status: 'idle',
    error: undefined,
    collapsed: false,
    loopWaitUntil: null,
    ...over
  }
}

describe('sameRenderedPaneViews', () => {
  it('holds the array still when a tick reports the same thing', () => {
    expect(sameRenderedPaneViews([view(), view({ id: 'p2' })], [view(), view({ id: 'p2' })])).toBe(
      true
    )
  })

  it('reports a changed status, which is what the badge is for', () => {
    expect(sameRenderedPaneViews([view()], [view({ status: 'running' })])).toBe(false)
  })

  it('reports a pane appearing or disappearing', () => {
    expect(sameRenderedPaneViews([view()], [view(), view({ id: 'p2' })])).toBe(false)
    expect(sameRenderedPaneViews([], [view()])).toBe(false)
  })

  it('reports panes reordered even when the set is the same', () => {
    const a = [view({ id: 'p1' }), view({ id: 'p2' })]
    const b = [view({ id: 'p2' }), view({ id: 'p1' })]
    expect(sameRenderedPaneViews(a, b)).toBe(false)
  })

  it('reports a field that went from a value to absent', () => {
    const { error: _dropped, ...withoutError } = view()
    expect(sameRenderedPaneViews([view({ error: 'boom' })], [withoutError])).toBe(false)
  })

  it('treats undefined and null as the distinct values they are', () => {
    expect(sameRenderedPaneViews([view({ loopWaitUntil: null })], [view({ loopWaitUntil: 0 })])).toBe(
      false
    )
    expect(
      sameRenderedPaneViews([view({ loopWaitUntil: null })], [view({ loopWaitUntil: null })])
    ).toBe(true)
  })

  it('falls back to unequal when a field holds a fresh object', () => {
    expect(sameRenderedPaneViews([view({ meta: {} })], [view({ meta: {} })])).toBe(false)
  })

  it('compares every field, not a fixed few', () => {
    expect(
      sameRenderedPaneViews([view({ somethingAddedLater: 1 })], [view({ somethingAddedLater: 2 })])
    ).toBe(false)
  })

  it('is true for two empty lists', () => {
    expect(sameRenderedPaneViews([], [])).toBe(true)
  })
})
