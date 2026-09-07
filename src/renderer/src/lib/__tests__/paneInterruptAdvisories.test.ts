import { describe, expect, it } from 'vitest'

import { interruptAdvisoriesFor } from '../paneInterruptAdvisories'

const facts = (over: Partial<Parameters<typeof interruptAdvisoriesFor>[0]> = {}) => ({
  name: 'worker',
  sent: true,
  ...over,
})

describe('interruptAdvisoriesFor', () => {
  it('says nothing when the interrupt landed on a turn that was running', () => {
    // The intended case has to stay quiet, or the advisories stop being read.
    for (const status of ['running', 'starting']) {
      expect(interruptAdvisoriesFor(facts({ status })), status).toEqual([])
    }
  })

  it('warns that interrupting an idle pane hit no turn and may eat a draft', () => {
    const notes = interruptAdvisoriesFor(facts({ status: 'idle' }))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('idle')
    // The draft half is the point: an idle interrupt is not merely a no-op,
    // it can destroy something a human typed and had not sent.
    expect(notes[0]).toContain('輸入框')
  })

  it('warns for every non-working status, not just idle', () => {
    for (const status of ['stopped', 'exited', 'error', 'some-new-status']) {
      const notes = interruptAdvisoriesFor(facts({ status }))
      expect(notes, status).toHaveLength(1)
      expect(notes[0], status).toContain(status)
    }
  })

  it('says an unknown status is unknown rather than leaving a blank', () => {
    const notes = interruptAdvisoriesFor(facts({ status: '' }))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('unknown')
  })

  it('treats awaiting as its own case: the question is what got thrown away', () => {
    // awaiting is not "working" — nothing was cut short — but calling it an
    // idle no-op would be worse: a decision someone was about to make is gone.
    const notes = interruptAdvisoriesFor(facts({ status: 'awaiting' }))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('問題')
    expect(notes[0]).not.toContain('輸入框')
  })

  it('names what the pane was waiting for when that is known', () => {
    const notes = interruptAdvisoriesFor(facts({ status: 'awaiting', awaitingKind: 'question' }))
    expect(notes[0]).toContain('question')
  })

  it('reports that nothing was written at all, and says nothing else', () => {
    // `sent: false` means no byte reached a PTY, so the idle/awaiting notes
    // would be describing an event that did not happen.
    const notes = interruptAdvisoriesFor(facts({ sent: false, status: 'awaiting' }))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('沒有送出')
    expect(notes[0]).not.toContain('問題')
  })

  it('names a placeholder pane’s missing status rather than printing a blank', () => {
    const notes = interruptAdvisoriesFor(facts({ sent: false, status: '' }))
    expect(notes[0]).toContain('not-opened')
  })

  it('falls back to a readable subject when the pane has no name', () => {
    const notes = interruptAdvisoriesFor(facts({ name: '   ', status: 'idle' }))
    expect(notes[0]).not.toContain('「」')
  })
})
