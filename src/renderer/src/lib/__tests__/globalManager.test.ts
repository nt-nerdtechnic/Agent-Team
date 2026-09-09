import { describe, it, expect } from 'vitest'
import { deriveGlobalManager } from '../globalManager'
import type { Stage } from '../../data/stages'

const slot = (label: string, isCommander: boolean) => ({
  agentKey: 'claude' as never,
  roleKey: '',
  label,
  kickoffBody: '',
  isCommander,
})

const stage = (id: string, slots: ReturnType<typeof slot>[]): Stage =>
  ({
    id,
    title: id,
    shortTitle: id,
    question: '',
    description: '',
    recommendedRoles: [],
    sentinel: '',
    allowQuestions: false,
    docQuery: '',
    slots,
  }) as unknown as Stage

describe('deriveGlobalManager', () => {
  it('returns null when no stage declares a commander', () => {
    expect(
      deriveGlobalManager([
        stage('01', [slot('Spec', false)]),
        stage('02', [slot('Build', false), slot('Test', false)]),
      ])
    ).toBeNull()
  })

  it('returns null for an empty stage list', () => {
    expect(deriveGlobalManager([])).toBeNull()
  })

  it('finds the commander slot and reports its stage id and label', () => {
    const gm = deriveGlobalManager([
      stage('01', [slot('Worker', false), slot('Planning', true)]),
      stage('02', [slot('Build', false)]),
    ])
    expect(gm).toEqual({ stageId: '01', slotLabel: 'Planning' })
  })

  it('takes the FIRST stage that declares one, not a later one', () => {
    const gm = deriveGlobalManager([
      stage('01', [slot('Worker', false)]),
      stage('02', [slot('Lead', true)]),
      stage('03', [slot('Other lead', true)]),
    ])
    expect(gm).toEqual({ stageId: '02', slotLabel: 'Lead' })
  })
})
