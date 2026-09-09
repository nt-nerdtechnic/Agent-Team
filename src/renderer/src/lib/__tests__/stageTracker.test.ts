import { describe, it, expect } from 'vitest'
import {
  registerStage,
  completeSlot,
  releaseSlot,
  stageRemaining,
  isStageDone,
  type StageTrackers,
} from '../stageTracker'

function trackers(): StageTrackers {
  return new Map()
}

describe('stageTracker', () => {
  it('waits for every registered slot', () => {
    const t = trackers()
    registerStage(t, 0, 2)
    expect(completeSlot(t, 0, 'paneA')).toEqual({
      kind: 'counted', done: 1, expected: 2, remaining: 1,
    })
    expect(isStageDone(t, 0)).toBe(false)
    expect(completeSlot(t, 0, 'paneB')).toEqual({
      kind: 'counted', done: 2, expected: 2, remaining: 0,
    })
    expect(isStageDone(t, 0)).toBe(true)
  })

  // The #2 hang: a 2-slot stage whose second pane is closed used to wait for a
  // signal that could never arrive.
  it('register 2 -> release 1 -> complete 1 finishes the stage', () => {
    const t = trackers()
    registerStage(t, 0, 2)
    expect(releaseSlot(t, 0, 'paneB')).toEqual({
      kind: 'released', done: 0, expected: 1, remaining: 1,
    })
    expect(isStageDone(t, 0)).toBe(false)
    expect(completeSlot(t, 0, 'paneA')).toEqual({
      kind: 'counted', done: 1, expected: 1, remaining: 0,
    })
    expect(isStageDone(t, 0)).toBe(true)
  })

  it('does not decrement expected twice for a repeated release', () => {
    const t = trackers()
    registerStage(t, 0, 2)
    releaseSlot(t, 0, 'paneB')
    expect(releaseSlot(t, 0, 'paneB')).toEqual({ kind: 'already-released' })
    expect(stageRemaining(t, 0)).toBe(1)
  })

  it('never drives expected below zero', () => {
    const t = trackers()
    registerStage(t, 0, 2)
    releaseSlot(t, 0, 'a')
    const last = releaseSlot(t, 0, 'b')
    expect(last).toEqual({ kind: 'released', done: 0, expected: 0, remaining: 0 })
    expect(releaseSlot(t, 0, 'c')).toEqual({
      kind: 'released', done: 0, expected: 0, remaining: 0,
    })
    expect(stageRemaining(t, 0)).toBe(0)
  })

  it('refuses to release a slot that already completed', () => {
    const t = trackers()
    registerStage(t, 0, 2)
    completeSlot(t, 0, 'paneA')
    expect(releaseSlot(t, 0, 'paneA')).toEqual({ kind: 'already-done' })
    // expected must still cover the slot that was counted
    expect(stageRemaining(t, 0)).toBe(1)
  })

  it('ignores a late completion signal from a released slot', () => {
    const t = trackers()
    registerStage(t, 0, 2)
    releaseSlot(t, 0, 'paneB')
    expect(completeSlot(t, 0, 'paneB')).toEqual({ kind: 'duplicate' })
    expect(stageRemaining(t, 0)).toBe(1)
  })

  it('ignores a double completion for the same slot', () => {
    const t = trackers()
    registerStage(t, 0, 2)
    completeSlot(t, 0, 'paneA')
    expect(completeSlot(t, 0, 'paneA')).toEqual({ kind: 'duplicate' })
    expect(stageRemaining(t, 0)).toBe(1)
  })

  it('reports an unknown stage instead of inventing one', () => {
    const t = trackers()
    expect(completeSlot(t, 3, 'paneA')).toEqual({ kind: 'unknown-stage' })
    expect(releaseSlot(t, 3, 'paneA')).toEqual({ kind: 'unknown-stage' })
    expect(isStageDone(t, 3)).toBe(false)
    expect(stageRemaining(t, 3)).toBe(0)
  })

  it('releasing every slot leaves expected 0 with nothing done', () => {
    const t = trackers()
    registerStage(t, 0, 2)
    releaseSlot(t, 0, 'a')
    const out = releaseSlot(t, 0, 'b')
    expect(out).toEqual({ kind: 'released', done: 0, expected: 0, remaining: 0 })
    // Caller distinguishes "all finished" from "all gone" by expected/done.
    expect(isStageDone(t, 0)).toBe(true)
  })

  it('registerStage resets a partially consumed tracker', () => {
    const t = trackers()
    registerStage(t, 0, 2)
    completeSlot(t, 0, 'paneA')
    releaseSlot(t, 0, 'paneB')
    registerStage(t, 0, 2)
    expect(stageRemaining(t, 0)).toBe(2)
    expect(completeSlot(t, 0, 'paneA')).toEqual({
      kind: 'counted', done: 1, expected: 2, remaining: 1,
    })
  })
})
