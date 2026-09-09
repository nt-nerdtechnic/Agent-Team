import { describe, it, expect } from 'vitest'
import { closeEndsTheRun } from '../workspaceCloseRun'

const A = '/Users/x/projects/alpha'
const B = '/Users/x/projects/beta'

describe('closeEndsTheRun', () => {
  it('ends the run when the workspace being closed is the one it runs in', () => {
    expect(closeEndsTheRun({
      state: 'running',
      runWorkspacePath: B,
      closingWorkspacePath: B,
      doomedOrigins: ['pipeline', 'pipeline', 'manual'],
    })).toBe(true)
  })

  it('does NOT end a run that belongs to a different workspace', () => {
    // The regression this function exists for. A window holds A and B. The user
    // ran a pipeline in B, switched to A (which aborts — a PAUSE, so B's panes
    // stay alive with origin 'pipeline'), started a NEW run in A, then closed B
    // from the sidebar. Matching on origin alone sees B's leftovers and tears
    // down the live run in A, sending A's backend an abort it never asked for.
    expect(closeEndsTheRun({
      state: 'running',
      runWorkspacePath: A,
      closingWorkspacePath: B,
      doomedOrigins: ['pipeline', 'pipeline'],
    })).toBe(false)
  })

  it('does not end a run when the close takes none of its panes', () => {
    expect(closeEndsTheRun({
      state: 'running',
      runWorkspacePath: B,
      closingWorkspacePath: B,
      doomedOrigins: ['manual', 'mcp'],
    })).toBe(false)
  })

  it('treats an mcp-spawned pane as not a slot', () => {
    // origin has three values; "not manual" would make this true.
    expect(closeEndsTheRun({
      state: 'running',
      runWorkspacePath: B,
      closingWorkspacePath: B,
      doomedOrigins: ['mcp'],
    })).toBe(false)
  })

  it('says no for every state that is not running', () => {
    for (const state of ['idle', 'aborted', 'completed', 'paused']) {
      expect(closeEndsTheRun({
        state,
        runWorkspacePath: B,
        closingWorkspacePath: B,
        doomedOrigins: ['pipeline'],
      }), state).toBe(false)
    }
  })

  it('compares paths as given, so the caller owns normalization', () => {
    // App.vue passes both through normWs. Documented here so a caller that
    // forgets one side sees a deliberate false rather than a silent match.
    expect(closeEndsTheRun({
      state: 'running',
      runWorkspacePath: B + '/',
      closingWorkspacePath: B,
      doomedOrigins: ['pipeline'],
    })).toBe(false)
  })
})
