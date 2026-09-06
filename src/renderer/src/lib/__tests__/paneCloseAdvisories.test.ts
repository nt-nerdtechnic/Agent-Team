import { describe, expect, it } from 'vitest'

import { closeAdvisoriesFor } from '../paneCloseAdvisories'

const facts = (over: Partial<Parameters<typeof closeAdvisoriesFor>[0]> = {}) => ({
  name: 'worker',
  queuedMessages: 0,
  childCount: 0,
  ...over,
})

describe('closeAdvisoriesFor', () => {
  it('says nothing about closing an idle pane with nothing pending', () => {
    // The common case has to stay quiet, or the advisories stop being read.
    expect(closeAdvisoriesFor(facts({ status: 'idle' }))).toEqual([])
  })

  it('reports a pane that was in the middle of something', () => {
    for (const status of ['running', 'starting', 'awaiting']) {
      const notes = closeAdvisoriesFor(facts({ status }))
      expect(notes, status).toHaveLength(1)
      expect(notes[0]).toContain(status)
    }
  })

  it('counts awaiting as busy, because a question was about to be answered', () => {
    // Not merely "producing output": closing here throws away a decision
    // someone was waiting to make.
    expect(closeAdvisoriesFor(facts({ status: 'awaiting' }))).not.toEqual([])
  })

  it('does not call a stopped or exited pane busy', () => {
    for (const status of ['idle', 'stopped', 'exited', 'error', 'disconnected']) {
      expect(closeAdvisoriesFor(facts({ status })), status).toEqual([])
    }
  })

  it('reports messages that die with the pane, and who finds out', () => {
    const notes = closeAdvisoriesFor(facts({ queuedMessages: 3 }))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('3')
    // The sender's side of it matters as much as the count.
    expect(notes[0]).toContain('pane-closed')
  })

  it('reports children left reporting to nobody', () => {
    const notes = closeAdvisoriesFor(facts({ childCount: 2 }))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('2')
  })

  it('reports every consequence at once rather than only the first', () => {
    const notes = closeAdvisoriesFor(
      facts({ status: 'running', queuedMessages: 1, childCount: 4 }),
    )
    expect(notes).toHaveLength(3)
  })

  it('falls back to a readable subject when the pane has no name', () => {
    const notes = closeAdvisoriesFor(facts({ name: '   ', status: 'running' }))
    expect(notes[0]).not.toContain('「」')
  })

  it('treats an unknown status as not busy rather than guessing', () => {
    // A status this file has never heard of must not be reported as busy —
    // a false alarm here trains the caller to ignore the whole channel.
    expect(closeAdvisoriesFor(facts({ status: 'some-new-status' }))).toEqual([])
  })
})
