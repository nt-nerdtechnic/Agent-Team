import { describe, it, expect } from 'vitest'
import {
  PLAN_REF_MIME,
  writePlanDragPayload,
  parsePlanRefPayload,
  isPlanDrag,
  planDropPrompt,
  type PlanDragRef
} from '../planDrag'

function fakeDataTransfer(): { store: Record<string, string>; setData: (k: string, v: string) => void } {
  const store: Record<string, string> = {}
  return { store, setData: (k, v) => { store[k] = v } }
}

describe('writePlanDragPayload / parsePlanRefPayload round-trip', () => {
  it('round-trips a ref with an overview', () => {
    const ref: PlanDragRef = {
      relPath: '.agent-team/plans/foo_abc123.html',
      name: 'Foo Plan',
      overview: 'Ship the foo feature'
    }
    const dt = fakeDataTransfer()
    writePlanDragPayload(dt, ref)
    expect(parsePlanRefPayload(dt.store[PLAN_REF_MIME])).toEqual(ref)
  })

  it('round-trips a ref without an overview', () => {
    const ref: PlanDragRef = { relPath: '.agent-team/plans/bar_def456.html', name: 'Bar' }
    const dt = fakeDataTransfer()
    writePlanDragPayload(dt, ref)
    expect(parsePlanRefPayload(dt.store[PLAN_REF_MIME])).toEqual(ref)
  })
})

describe('parsePlanRefPayload', () => {
  it('returns null for malformed JSON', () => {
    expect(parsePlanRefPayload('{not json')).toBeNull()
  })

  it('returns null for a non-object payload', () => {
    expect(parsePlanRefPayload('"just a string"')).toBeNull()
    expect(parsePlanRefPayload('42')).toBeNull()
    expect(parsePlanRefPayload('null')).toBeNull()
  })

  it('returns null when relPath is missing or empty', () => {
    expect(parsePlanRefPayload(JSON.stringify({ name: 'x' }))).toBeNull()
    expect(parsePlanRefPayload(JSON.stringify({ relPath: '' }))).toBeNull()
  })
})

describe('isPlanDrag', () => {
  it('is true when types include the plan MIME', () => {
    expect(isPlanDrag([PLAN_REF_MIME])).toBe(true)
    expect(isPlanDrag(['text/plain', PLAN_REF_MIME])).toBe(true)
  })

  it('is false when types lack the plan MIME or are undefined', () => {
    expect(isPlanDrag(['text/plain'])).toBe(false)
    expect(isPlanDrag([])).toBe(false)
    expect(isPlanDrag(undefined)).toBe(false)
  })
})

describe('planDropPrompt', () => {
  it('pastes only the relPath, ignoring the overview', () => {
    const out = planDropPrompt({ relPath: '.agent-team/plans/foo_abc123.html', overview: 'Ship foo' })
    expect(out).toBe('.agent-team/plans/foo_abc123.html')
  })

  it('pastes only the relPath when there is no overview', () => {
    expect(planDropPrompt({ relPath: '.agent-team/plans/bar_def456.html' })).toBe(
      '.agent-team/plans/bar_def456.html'
    )
  })
})
