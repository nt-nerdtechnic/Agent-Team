import { describe, expect, it } from 'vitest'
import { CLI_AGENT_SPECS } from '../index'
import { AI_CLI_PROFILES } from '../../../../../../src/shared/aiCliProfiles'

describe('shared AI CLI profiles', () => {
  it('matches every renderer CLI spec command and yolo flag', () => {
    const specs = Object.fromEntries(
      CLI_AGENT_SPECS.map((spec) => [spec.agentKey, {
        command: spec.defaultCommand,
        ...(spec.skipPermissionFlag ? { yoloFlag: spec.skipPermissionFlag } : {}),
      }]),
    )
    expect(specs).toEqual(AI_CLI_PROFILES)
  })
})
