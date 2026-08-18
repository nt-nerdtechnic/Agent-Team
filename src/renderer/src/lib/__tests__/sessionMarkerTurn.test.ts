import { describe, it, expect } from 'vitest'
import { markerTurnActionFor } from '../sessionMarkerTurn'

type Activity = { event_type?: string; detail?: string; text?: string }

/** The state machine App.vue runs over the gate, so the sequences below are
 *  tested the way they actually behave rather than one event at a time. */
function runGate(events: Activity[]): { suppressed: boolean[]; armedAtEnd: boolean } {
  let armed = true
  const suppressed: boolean[] = []
  for (const ev of events) {
    let isMarkerReply = false
    if (armed) {
      const action = markerTurnActionFor(ev)
      if (action) armed = false
      isMarkerReply = action === 'suppress'
    }
    if (ev.event_type === 'turn_complete') suppressed.push(isMarkerReply)
  }
  return { suppressed, armedAtEnd: armed }
}

describe('markerTurnActionFor', () => {
  it('suppresses the turn that ends the marker prompt', () => {
    expect(markerTurnActionFor({ event_type: 'turn_complete', text: 'Understood!' })).toBe('suppress')
  })

  it('disarms on a real user prompt, whichever spelling the reader uses', () => {
    for (const detail of ['user', 'prompt', 'user_message']) {
      expect(markerTurnActionFor({ event_type: 'agent_active', detail, text: 'fix the resize bug' })).toBe('disarm')
    }
  })

  it('is not disarmed by the marker record itself', () => {
    // Every reader that reports the marker's user record blanks its text via
    // user_prompt_text() (it opens with '<'); cursor emits nothing at all.
    expect(markerTurnActionFor({ event_type: 'agent_active', detail: 'user', text: '' })).toBe(null)
    expect(markerTurnActionFor({ event_type: 'agent_active', detail: 'user_message' })).toBe(null)
  })

  it('is not disarmed by an injected inter-CLI envelope', () => {
    expect(
      markerTurnActionFor({ event_type: 'agent_active', detail: 'user', text: '[Navide MSG] from: alice\nhi' })
    ).toBe(null)
  })

  it('ignores tool activity and unknown event types', () => {
    expect(markerTurnActionFor({ event_type: 'agent_active', detail: 'Bash', text: 'ls' })).toBe(null)
    expect(markerTurnActionFor({ event_type: 'agent_active' })).toBe(null)
    expect(markerTurnActionFor({ event_type: 'session_start' })).toBe(null)
  })
})

describe('session-marker gate sequences', () => {
  it('suppresses the marker reply and leaves the first real turn alone', () => {
    // cursor-shaped: the marker's user row is dropped by the reader, so the
    // reply's turn_complete is the first event the gate sees.
    const { suppressed, armedAtEnd } = runGate([
      { event_type: 'turn_complete', detail: 'assistant', text: 'Noted — how can I help?' },
      { event_type: 'agent_active', detail: 'user', text: 'refactor the watcher' },
      { event_type: 'turn_complete', detail: 'assistant', text: 'Done. ---MSG-START---' },
    ])
    expect(suppressed).toEqual([true, false])
    expect(armedAtEnd).toBe(false)
  })

  it('suppresses the marker reply when the reader also reports the marker record', () => {
    // codex/copilot/qwen-shaped: a user record arrives first, blanked to ''.
    const { suppressed } = runGate([
      { event_type: 'agent_active', detail: 'user_message', text: '' },
      { event_type: 'agent_active', detail: 'Read', text: '' },
      { event_type: 'turn_complete', detail: 'assistant', text: 'Acknowledged.' },
      { event_type: 'agent_active', detail: 'user_message', text: 'ship the release' },
      { event_type: 'turn_complete', detail: 'assistant', text: 'Shipped.' },
    ])
    expect(suppressed).toEqual([true, false])
  })

  it('never swallows a real turn when the CLI answers the marker invisibly', () => {
    // No turn_complete ever arrives for the marker. The user's own prompt
    // disarms the gate, so their turn keeps every side effect.
    const { suppressed, armedAtEnd } = runGate([
      { event_type: 'agent_active', detail: 'user', text: 'write the migration' },
      { event_type: 'turn_complete', detail: 'assistant', text: 'Migration written.' },
    ])
    expect(suppressed).toEqual([false])
    expect(armedAtEnd).toBe(false)
  })

  it('suppresses at most one turn', () => {
    const { suppressed } = runGate([
      { event_type: 'turn_complete', detail: 'assistant', text: 'Noted.' },
      { event_type: 'turn_complete', detail: 'assistant', text: 'Anything else?' },
    ])
    expect(suppressed).toEqual([true, false])
  })
})
