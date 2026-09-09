import { describe, it, expect } from 'vitest'
import { evaluateManagerStage, fullAutoStallAction } from '../managerStageWatchdog'

const HOUR = 60 * 60_000

describe('evaluateManagerStage', () => {
  it('is ok while the Manager pane is alive and inside the cap', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: true,
      armedAt: 1_000, now: 1_000 + 60_000, maxDurationMs: HOUR,
    })).toBe('ok')
  })

  it('is ok before the Manager pane has been spawned', () => {
    expect(evaluateManagerStage({
      managerPaneId: '', managerPaneAlive: false,
      armedAt: 0, now: 10 * HOUR, maxDurationMs: HOUR,
    })).toBe('ok')
  })

  // The #1 hang: the Manager pane is gone, so ---STAGE-DONE--- can never be
  // printed and the router polls an empty buffer forever.
  it('reports manager-gone when the Manager pane disappeared', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: false,
      armedAt: 1_000, now: 2_000, maxDurationMs: HOUR,
    })).toBe('manager-gone')
  })

  it('prefers manager-gone over timeout when both hold', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: false,
      armedAt: 1_000, now: 1_000 + 2 * HOUR, maxDurationMs: HOUR,
    })).toBe('manager-gone')
  })

  // Manager mode skips the per-pane watcher, so the stage cap has to be
  // evaluated here or it never fires at all.
  it('reports timeout past the stage cap', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: true,
      armedAt: 1_000, now: 1_000 + HOUR + 1, maxDurationMs: HOUR,
    })).toBe('timeout')
  })

  it('does not time out exactly at the cap', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: true,
      armedAt: 1_000, now: 1_000 + HOUR, maxDurationMs: HOUR,
    })).toBe('ok')
  })

  it('does not time out before the stage was armed', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: true,
      armedAt: 0, now: 10 * HOUR, maxDurationMs: HOUR,
    })).toBe('ok')
  })

  it('treats a non-positive cap as disabled', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: true,
      armedAt: 1, now: 10 * HOUR, maxDurationMs: 0,
    })).toBe('ok')
  })
})

describe('fullAutoStallAction', () => {
  const never = (): boolean => {
    throw new Error('slotsFinished must not be consulted here')
  }

  it('force-advances a gone Manager instead of waiting for a signal that cannot come', () => {
    // The regression this exists for: holding here leaves the run at
    // state='running' with the prompt dismissed, the watchdog latched, and
    // nobody watching — silent forever, under the mode whose whole promise is
    // that it does not need anybody.
    expect(fullAutoStallAction({
      managerVerdict: 'manager-gone', multiSlot: true, slotsFinished: never,
    })).toBe('force-advance')
  })

  it('does not even ask the slot gate for a gone Manager', () => {
    // Manager mode arms no per-pane watcher, so the gate is structurally false
    // for such a stage — asking it can only produce the wrong answer slowly.
    let asked = 0
    fullAutoStallAction({
      managerVerdict: 'manager-gone',
      multiSlot: true,
      slotsFinished: () => { asked++; return false },
    })
    expect(asked).toBe(0)
  })

  it('still gates a Manager-mode cap on the slot signals', () => {
    // 'timeout' means the Manager is alive and can still print STAGE-DONE, so
    // the ordinary gate applies and the cap re-raises later.
    expect(fullAutoStallAction({
      managerVerdict: 'timeout', multiSlot: true, slotsFinished: () => false,
    })).toBe('keep-waiting')
    expect(fullAutoStallAction({
      managerVerdict: 'timeout', multiSlot: true, slotsFinished: () => true,
    })).toBe('force-advance')
  })

  it('keeps single-slot behaviour exactly as it was: blind force-advance', () => {
    expect(fullAutoStallAction({
      multiSlot: false, slotsFinished: never,
    })).toBe('force-advance')
  })

  it('keeps the multi-slot watcher stall gated on N/N', () => {
    expect(fullAutoStallAction({
      multiSlot: true, slotsFinished: () => false,
    })).toBe('keep-waiting')
    expect(fullAutoStallAction({
      multiSlot: true, slotsFinished: () => true,
    })).toBe('force-advance')
  })

  it('asks the gate at most once', () => {
    let asked = 0
    fullAutoStallAction({
      multiSlot: true, slotsFinished: () => { asked++; return false },
    })
    expect(asked).toBe(1)
  })
})
