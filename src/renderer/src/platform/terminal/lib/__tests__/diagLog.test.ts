import { describe, it, expect, vi, afterEach } from 'vitest'
import { createThrottledDiag, diagLog } from '../diagLog'

// The renderer forwards its latency observations through a named diagnostic
// port. Two properties matter: it must never throw into the path it observes,
// and the probes that sit on a per-keystroke path must not add a message per
// keystroke to a connection that is already the suspect.

function mockBackend() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    backend: {
      diagnostic: (category: string, message: string, level: 'info' | 'warning') => {
        const payload = { category, message, level }
        sent.push({ type: 'client.diagnostic', payload })
      },
    },
  }
}

function messages(m: ReturnType<typeof mockBackend>): string[] {
  return m.sent.map((s) => String(s.payload.message))
}

describe('diagLog', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends the line under client.diagnostic', () => {
    const m = mockBackend()
    diagLog(m.backend, 'ime', 'something happened')
    expect(m.sent[0].type).toBe('client.diagnostic')
    expect(m.sent[0].payload).toMatchObject({
      category: 'ime',
      message: 'something happened',
      level: 'info',
    })
  })

  it('swallows a diagnostic sink that refuses to report', () => {
    const backend = { diagnostic: () => { throw new Error('not connected') } }
    expect(() => diagLog(backend, 'ime', 'x')).not.toThrow()
  })
})

describe('createThrottledDiag', () => {
  afterEach(() => vi.restoreAllMocks())

  it('lets the first line straight through', () => {
    const m = mockBackend()
    const report = createThrottledDiag(m.backend, 'echo', 5000)
    report('round-trip 600ms')
    expect(messages(m)).toEqual(['round-trip 600ms'])
  })

  it('holds back the ones that follow too soon', () => {
    const m = mockBackend()
    const now = vi.spyOn(Date, 'now')
    const report = createThrottledDiag(m.backend, 'echo', 5000)

    now.mockReturnValue(1_000_000)
    report('first')
    now.mockReturnValue(1_000_100)
    report('second')
    now.mockReturnValue(1_000_200)
    report('third')

    expect(messages(m)).toEqual(['first'])
  })

  // Throttling must not make the log understate the problem: the whole point of
  // these probes is to show how bad it got.
  it('reports how many it suppressed on the next line through', () => {
    const m = mockBackend()
    const now = vi.spyOn(Date, 'now')
    const report = createThrottledDiag(m.backend, 'echo', 5000)

    now.mockReturnValue(1_000_000)
    report('first')
    now.mockReturnValue(1_000_100)
    report('dropped')
    now.mockReturnValue(1_000_200)
    report('dropped')
    now.mockReturnValue(1_006_000)
    report('later')

    expect(messages(m)).toEqual(['first', 'later (+2 suppressed since the last line)'])
  })

  it('goes back to plain lines once the trouble stops', () => {
    const m = mockBackend()
    const now = vi.spyOn(Date, 'now')
    const report = createThrottledDiag(m.backend, 'echo', 5000)

    now.mockReturnValue(1_000_000)
    report('first')
    now.mockReturnValue(1_000_100)
    report('dropped')
    now.mockReturnValue(1_006_000)
    report('second')
    now.mockReturnValue(1_012_000)
    report('third')

    expect(messages(m)[2]).toBe('third')
  })

  it('keeps each category on its own clock', () => {
    const m = mockBackend()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    const echo = createThrottledDiag(m.backend, 'echo', 5000)
    const ime = createThrottledDiag(m.backend, 'ime', 5000)

    echo('echo line')
    ime('ime line')

    expect(messages(m)).toEqual(['echo line', 'ime line'])
  })

  it('passes the level through', () => {
    const m = mockBackend()
    const report = createThrottledDiag(m.backend, 'echo', 5000)
    report('bad', 'warning')
    expect(m.sent[0].payload.level).toBe('warning')
  })
})
