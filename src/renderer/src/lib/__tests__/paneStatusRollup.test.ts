// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { PANE_STATUS_ATTENTION_ORDER, rollupPaneStatus } from '../paneStatusRollup'
import { PANE_STATUS_ORDER } from '../statusBadgePalette'

describe('rollupPaneStatus', () => {
  it('reports nothing for an empty set', () => {
    // The badge then keeps its neutral default rather than being painted a
    // status no pane is actually in.
    expect(rollupPaneStatus([])).toBeUndefined()
  })

  it('surfaces the one pane that broke among nine that are fine', () => {
    // The whole reason the tally is coloured: an error inside a folded section
    // has nowhere else to show.
    const statuses = [...Array(9).fill('running'), 'error']
    expect(rollupPaneStatus(statuses)).toBe('error')
  })

  it('surfaces one question among nine errors', () => {
    // The top of the order, so nothing can hide it.
    const statuses = [...Array(9).fill('error'), 'awaiting']
    expect(rollupPaneStatus(statuses)).toBe('awaiting')
  })

  it('surfaces a pane waiting on the user over panes that are running', () => {
    // 'awaiting' is the one the human has to act on; 'running' will move by
    // itself. Ranking activity first would bury the only actionable pane.
    expect(rollupPaneStatus(['running', 'awaiting', 'running'])).toBe('awaiting')
  })

  it('ranks a pane asking a question above one that already died', () => {
    // Not severity order. The question is blocking a run RIGHT NOW and stays
    // blocked until someone answers; the errored pane has already stopped and
    // is wasting nothing while it waits to be read.
    expect(rollupPaneStatus(['error', 'awaiting'])).toBe('awaiting')
  })

  it('prefers movement to quiet', () => {
    expect(rollupPaneStatus(['idle', 'running'])).toBe('running')
    expect(rollupPaneStatus(['exited', 'starting'])).toBe('starting')
    expect(rollupPaneStatus(['stopped', 'idle'])).toBe('idle')
  })

  it('does not care what order the panes arrive in', () => {
    expect(rollupPaneStatus(['awaiting', 'running', 'idle'])).toBe('awaiting')
    expect(rollupPaneStatus(['idle', 'running', 'awaiting'])).toBe('awaiting')
  })

  it('reports a set of cold-restore placeholders as waiting, not as nothing', () => {
    // They are panes the workspace holds; the count includes them, so the
    // colour has to describe them rather than fall back to "empty".
    expect(rollupPaneStatus(['waiting', 'waiting'])).toBe('waiting')
  })

  it('skips a status this build cannot name instead of painting it', () => {
    // A settings blob or a pane view from a newer build must degrade to the
    // statuses we do know, never drag the badge to var(--undefined).
    expect(rollupPaneStatus(['nonsense'])).toBeUndefined()
    expect(rollupPaneStatus(['nonsense', 'idle'])).toBe('idle')
  })

  it('ranks every status the app can paint, and no others', () => {
    // A status missing here would silently drop out of the rollup: a workspace
    // holding only that status would read as empty. Both lists are the whole
    // vocabulary, so they must hold the same members.
    expect([...PANE_STATUS_ATTENTION_ORDER].sort()).toEqual([...PANE_STATUS_ORDER].sort())
  })

  it('returns a status that came from the input', () => {
    for (const status of PANE_STATUS_ORDER) {
      expect(rollupPaneStatus([status])).toBe(status)
    }
  })
})
