import { describe, it, expect } from 'vitest'
import { createResumeGate } from './resume-gate'

describe('createResumeGate', () => {
  it('admits the first resume', () => {
    const gate = createResumeGate(3_000)
    expect(gate.admit(1_000)).toBe(true)
  })

  it('collapses a burst of resumes into one', () => {
    const gate = createResumeGate(3_000)
    expect(gate.admit(1_000)).toBe(true)
    expect(gate.admit(1_200)).toBe(false)
    expect(gate.admit(3_900)).toBe(false)
  })

  it('admits again once the window has passed', () => {
    const gate = createResumeGate(3_000)
    expect(gate.admit(1_000)).toBe(true)
    expect(gate.admit(4_000)).toBe(true)
  })

  it('measures the window from the admitted resume, not the suppressed ones', () => {
    const gate = createResumeGate(3_000)
    expect(gate.admit(1_000)).toBe(true)
    expect(gate.admit(2_500)).toBe(false) // suppressed — must not extend the window
    expect(gate.admit(4_000)).toBe(true)
  })
})
