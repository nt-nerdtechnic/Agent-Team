import { describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseExecutionPolicy,
  parseExecutionPolicyJson,
  V2_SYSTEM_NAMESPACES,
  executionPolicyV1Schema,
  type ExecutionPolicy,
} from '../../../packages/plugin-contracts/src/index'

const bootstrapFailure = vi.hoisted(() => ({ enabled: false }))
const chmodCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      chmodCalls.count += 1
      return actual.chmodSync(...args)
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (bootstrapFailure.enabled) throw new Error('simulated bootstrap failure')
      return actual.linkSync(...args)
    },
  }
})

import { PluginCapabilityGrantStore } from './pluginCapabilityGrantStore'
import {
  EXECUTION_POLICY_FILE,
  EXECUTION_POLICY_REVISION_FILE,
  EXECUTION_POLICY_DIRECTORY,
  ExecutionPolicyStore,
  ExecutionPolicyManualRepairError,
  ExecutionPolicyRevisionConflictError,
  FAIL_CLOSED_EXECUTION_POLICY,
  HOST_DEFAULT_EXECUTION_POLICY,
} from './executionPolicyStore'

const FULL_POLICY: ExecutionPolicy = {
  schemaVersion: 1,
  mode: 'full',
  system: [],
  shell: [],
}

const USER_POLICY: ExecutionPolicy = {
  schemaVersion: 1,
  mode: 'allowlist',
  system: ['fs', 'ui'],
  shell: ['git'],
}

function policyDirectory(userData: string): string {
  return join(userData, EXECUTION_POLICY_DIRECTORY)
}

function policyFile(userData: string): string {
  return join(policyDirectory(userData), EXECUTION_POLICY_FILE)
}

function revisionFile(userData: string): string {
  return join(policyDirectory(userData), EXECUTION_POLICY_REVISION_FILE)
}

function temporaryUserData(): string {
  return mkdtempSync(join(tmpdir(), 'navide-execution-policy-'))
}

function writePolicyFile(userData: string, raw: string, mode = 0o600): void {
  mkdirSync(policyDirectory(userData), { recursive: true, mode: 0o700 })
  chmodSync(policyDirectory(userData), 0o700)
  writeFileSync(policyFile(userData), raw, { encoding: 'utf8', mode })
  chmodSync(policyFile(userData), mode)
}

function writeRevisionFile(userData: string, raw: string, mode = 0o600): void {
  mkdirSync(policyDirectory(userData), { recursive: true, mode: 0o700 })
  chmodSync(policyDirectory(userData), 0o700)
  writeFileSync(revisionFile(userData), raw, { encoding: 'utf8', mode })
  chmodSync(revisionFile(userData), mode)
}

function persistedState(userPolicy: ExecutionPolicy | null, revision = 1): string {
  return `${JSON.stringify({ schemaVersion: 1, revision, userPolicy })}\n`
}

function persistedRevision(highWater: number): string {
  return `${JSON.stringify({ schemaVersion: 1, highWater })}\n`
}

function expectFailClosed(
  snapshot: ReturnType<ExecutionPolicyStore['getEffectivePolicy']>,
  revision = 0
): void {
  expect(snapshot).toEqual({
    policy: FAIL_CLOSED_EXECUTION_POLICY,
    revision,
    state: 'corrupt',
  })
}

describe('Execution Policy public contract', () => {
  it('accepts the three global policy modes with required arrays', () => {
    expect(parseExecutionPolicy(FULL_POLICY)).toEqual(FULL_POLICY)
    expect(parseExecutionPolicy({
      schemaVersion: 1,
      mode: 'allowlist',
      system: ['fs', 'ui', 'aiCli'],
      shell: ['git', 'gh', 'glab'],
    })).toEqual({
      schemaVersion: 1,
      mode: 'allowlist',
      system: ['fs', 'ui', 'aiCli'],
      shell: ['git', 'gh', 'glab'],
    })
    expect(parseExecutionPolicy({
      schemaVersion: 1,
      mode: 'denylist',
      system: ['aiCli'],
      shell: ['sudo', 'bash'],
    })).toEqual({
      schemaVersion: 1,
      mode: 'denylist',
      system: ['aiCli'],
      shell: ['sudo', 'bash'],
    })
  })

  it('rejects unsupported fields, namespaces, modes, duplicates, unsafe spellings, and non-empty full mode', () => {
    const invalidPolicies: unknown[] = [
      { schemaVersion: 2, mode: 'allowlist', system: [], shell: [] },
      { schemaVersion: 1, mode: 'unknown', system: [], shell: [] },
      { schemaVersion: 1, mode: 'allowlist', system: ['unknown'], shell: [] },
      { schemaVersion: 1, mode: 'allowlist', system: ['fs', 'fs'], shell: [] },
      { schemaVersion: 1, mode: 'allowlist', system: [], shell: ['git', 'git'] },
      { schemaVersion: 1, mode: 'allowlist', system: [], shell: ['../git'] },
      { schemaVersion: 1, mode: 'allowlist', system: [], shell: ['-git'] },
      { schemaVersion: 1, mode: 'allowlist', system: [], shell: ['.'] },
      { schemaVersion: 1, mode: 'allowlist', system: [], shell: ['git status'] },
      { schemaVersion: 1, mode: 'allowlist', system: [], shell: ['git\n'] },
      { schemaVersion: 1, mode: 'allowlist', system: [], shell: ['Ｇit'] },
      { schemaVersion: 1, mode: 'full', system: ['fs'], shell: [] },
      { schemaVersion: 1, mode: 'full', system: [], shell: ['git'] },
      { schemaVersion: 1, mode: 'allowlist', system: [], shell: [], extra: true },
    ]

    for (const policy of invalidPolicies) {
      expect(() => parseExecutionPolicy(policy)).toThrow()
    }
  })

  it('rejects duplicate JSON keys before policy validation', () => {
    expect(() => parseExecutionPolicyJson(
      '{"schemaVersion":1,"mode":"allowlist","system":[],"shell":[],"shell":[]}'
    )).toThrow('duplicate JSON object key: shell')
  })

  it('canonicalizes shell names before duplicate detection', () => {
    expect(parseExecutionPolicy({
      schemaVersion: 1,
      mode: 'allowlist',
      system: [],
      shell: ['GIT', 'Gh'],
    })).toEqual({
      schemaVersion: 1,
      mode: 'allowlist',
      system: [],
      shell: ['git', 'gh'],
    })
    expect(() => parseExecutionPolicy({
      schemaVersion: 1,
      mode: 'allowlist',
      system: [],
      shell: ['git', 'GIT'],
    })).toThrow()
  })

  it('keeps the public schema system namespace enum aligned with the public namespace list', () => {
    expect(executionPolicyV1Schema.properties.system.items.enum).toEqual([...V2_SYSTEM_NAMESPACES])
    expect(executionPolicyV1Schema.properties.shell.items.pattern)
      .toBe('^[a-z0-9][a-z0-9._+-]*$')
  })
})

describe('ExecutionPolicyStore', () => {
  it('uses the Host default without creating persisted state', () => {
    const userData = temporaryUserData()
    try {
      const store = new ExecutionPolicyStore(userData)

      expect(store.getEffectivePolicy()).toEqual({
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 0,
        state: 'default',
      })
      expect(store.getUserPolicy()).toBeNull()
      expect(existsSync(policyDirectory(userData))).toBe(false)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('keeps a fresh reset at revision zero without creating persisted state', () => {
    const userData = temporaryUserData()
    try {
      expect(new ExecutionPolicyStore(userData).resetUserPolicy()).toEqual({
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 0,
        state: 'default',
      })
      expect(existsSync(policyDirectory(userData))).toBe(false)
      expect(existsSync(policyFile(userData))).toBe(false)
      expect(existsSync(revisionFile(userData))).toBe(false)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('round-trips a user policy, increments every valid set, and resets monotonically', () => {
    const userData = temporaryUserData()
    try {
      const store = new ExecutionPolicyStore(userData)

      expect(store.setUserPolicy(USER_POLICY)).toEqual({
        policy: USER_POLICY,
        revision: 1,
        state: 'user',
      })
      expect(new ExecutionPolicyStore(userData).getEffectivePolicy()).toEqual({
        policy: USER_POLICY,
        revision: 1,
        state: 'user',
      })
      expect(store.setUserPolicy(USER_POLICY)).toEqual({
        policy: USER_POLICY,
        revision: 2,
        state: 'user',
      })
      expect(store.resetUserPolicy()).toEqual({
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 3,
        state: 'default',
      })
      expect(readFileSync(policyFile(userData), 'utf8')).toBe(persistedState(null, 3))
      expect(readFileSync(revisionFile(userData), 'utf8')).toBe(persistedRevision(3))
      expect(new ExecutionPolicyStore(userData).getEffectivePolicy()).toEqual({
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 3,
        state: 'default',
      })

      const beforeNoOpReset = readFileSync(policyFile(userData), 'utf8')
      const beforeNoOpRevision = readFileSync(revisionFile(userData), 'utf8')
      expect(store.resetUserPolicy()).toEqual({
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 3,
        state: 'default',
      })
      expect(readFileSync(policyFile(userData), 'utf8')).toBe(beforeNoOpReset)
      expect(readFileSync(revisionFile(userData), 'utf8')).toBe(beforeNoOpRevision)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('does not mutate persisted state when a user policy is invalid', () => {
    const userData = temporaryUserData()
    try {
      const store = new ExecutionPolicyStore(userData)
      store.setUserPolicy(USER_POLICY)
      const before = readFileSync(policyFile(userData), 'utf8')

      expect(() => store.setUserPolicy({
        schemaVersion: 1,
        mode: 'allowlist',
        system: [],
        shell: ['git status'],
      })).toThrow()
      expect(readFileSync(policyFile(userData), 'utf8')).toBe(before)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it.each([
    ['invalid JSON', '{not-json'],
    ['unknown persisted field', `${persistedState(null).trim().slice(0, -1)},"extra":true}`],
    ['duplicate persisted key', '{"schemaVersion":1,"revision":0,"revision":0,"userPolicy":null}'],
    ['unknown policy schema', persistedState({ ...USER_POLICY, schemaVersion: 2 } as unknown as ExecutionPolicy)],
    ['unsafe policy executable', persistedState({ ...USER_POLICY, shell: ['../git'] })],
  ])('fails closed and preserves %s', (_label, raw) => {
    const userData = temporaryUserData()
    try {
      writePolicyFile(userData, raw)
      const before = readFileSync(policyFile(userData), 'utf8')

      expectFailClosed(new ExecutionPolicyStore(userData).getEffectivePolicy())
      expect(readFileSync(policyFile(userData), 'utf8')).toBe(before)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('bootstraps a missing high-water sidecar from a valid legacy policy without incrementing', async () => {
    const userData = temporaryUserData()
    try {
      writePolicyFile(userData, persistedState(USER_POLICY, 57))

      const [first, second] = await Promise.all([
        Promise.resolve().then(() => new ExecutionPolicyStore(userData).getEffectivePolicy()),
        Promise.resolve().then(() => new ExecutionPolicyStore(userData).getEffectivePolicy()),
      ])
      expect(first).toEqual({
        policy: USER_POLICY,
        revision: 57,
        state: 'user',
      })
      expect(second).toEqual(first)
      expect(readFileSync(revisionFile(userData), 'utf8')).toBe(persistedRevision(57))
      const beforeSecondRead = lstatSync(revisionFile(userData))
      expect(new ExecutionPolicyStore(userData).getEffectivePolicy()).toEqual(first)
      expect(lstatSync(revisionFile(userData)).ino).toBe(beforeSecondRead.ino)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it.each([
    ['corrupt policy', '{not-json', true],
    ['policy behind high-water', persistedState(null, 56), true],
    ['missing policy', null, false],
  ])('fails closed at the durable high-water for %s', (_label, raw, hasPolicy) => {
    const userData = temporaryUserData()
    try {
      writeRevisionFile(userData, persistedRevision(57))
      if (hasPolicy) writePolicyFile(userData, raw as string)

      expectFailClosed(new ExecutionPolicyStore(userData).getEffectivePolicy(), 57)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('fails closed and refuses writes when the high-water sidecar is corrupt', () => {
    const userData = temporaryUserData()
    try {
      writeRevisionFile(userData, '{not-json')
      writePolicyFile(userData, persistedState(USER_POLICY, 57))
      const beforeRevision = readFileSync(revisionFile(userData), 'utf8')
      const beforePolicy = readFileSync(policyFile(userData), 'utf8')
      const store = new ExecutionPolicyStore(userData)

      expectFailClosed(store.getEffectivePolicy())
      expect(() => store.setUserPolicy(USER_POLICY)).toThrow()
      expect(() => store.resetUserPolicy()).toThrow()
      expect(readFileSync(revisionFile(userData), 'utf8')).toBe(beforeRevision)
      expect(readFileSync(policyFile(userData), 'utf8')).toBe(beforePolicy)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('retains the trusted instance floor after the sidecar becomes corrupt', () => {
    const userData = temporaryUserData()
    try {
      writeRevisionFile(userData, persistedRevision(57))
      writePolicyFile(userData, persistedState(USER_POLICY, 57))
      const store = new ExecutionPolicyStore(userData)
      expect(store.getEffectivePolicy().revision).toBe(57)

      writeRevisionFile(userData, '{not-json')
      const beforeRevision = readFileSync(revisionFile(userData), 'utf8')
      const beforePolicy = readFileSync(policyFile(userData), 'utf8')

      expectFailClosed(store.getEffectivePolicy(), 57)
      expect(() => store.setUserPolicy(USER_POLICY)).toThrow()
      expect(() => store.resetUserPolicy()).toThrow()
      expect(readFileSync(revisionFile(userData), 'utf8')).toBe(beforeRevision)
      expect(readFileSync(policyFile(userData), 'utf8')).toBe(beforePolicy)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it.each([
    ['invalid JSON', '{not-json'],
    ['unknown field', '{"schemaVersion":1,"highWater":57,"extra":true}'],
    ['duplicate high-water key', '{"schemaVersion":1,"highWater":57,"highWater":57}'],
    ['invalid high-water', '{"schemaVersion":1,"highWater":-1}'],
  ])('strictly rejects and preserves a %s high-water sidecar', (_label, raw) => {
    const userData = temporaryUserData()
    try {
      writeRevisionFile(userData, raw)
      writePolicyFile(userData, persistedState(USER_POLICY, 57))
      const before = readFileSync(revisionFile(userData), 'utf8')

      expectFailClosed(new ExecutionPolicyStore(userData).getEffectivePolicy())
      expect(readFileSync(revisionFile(userData), 'utf8')).toBe(before)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('fails closed for non-owner-only state and does not follow a policy symlink', () => {
    const permissionUserData = temporaryUserData()
    const symlinkUserData = temporaryUserData()
    try {
      writePolicyFile(permissionUserData, persistedState(USER_POLICY), 0o644)
      expectFailClosed(new ExecutionPolicyStore(permissionUserData).getEffectivePolicy())

      mkdirSync(policyDirectory(symlinkUserData), { recursive: true, mode: 0o700 })
      const target = join(symlinkUserData, 'target.json')
      writeFileSync(target, persistedState(USER_POLICY), { encoding: 'utf8', mode: 0o600 })
      symlinkSync(target, policyFile(symlinkUserData))
      expectFailClosed(new ExecutionPolicyStore(symlinkUserData).getEffectivePolicy())
      expect(lstatSync(policyFile(symlinkUserData)).isSymbolicLink()).toBe(true)
    } finally {
      rmSync(permissionUserData, { recursive: true, force: true })
      rmSync(symlinkUserData, { recursive: true, force: true })
    }
  })

  it('repairs an existing directory permission drift before reading durable state', () => {
    const userData = temporaryUserData()
    try {
      writeRevisionFile(userData, persistedRevision(5))
      writePolicyFile(userData, persistedState(USER_POLICY, 5))
      chmodSync(policyDirectory(userData), 0o755)
      const store = new ExecutionPolicyStore(userData)

      expect(store.getEffectivePolicy()).toEqual({
        policy: USER_POLICY,
        revision: 5,
        state: 'user',
      })
      expect(lstatSync(policyDirectory(userData)).mode & 0o777).toBe(0o700)
      expect(store.setUserPolicy(USER_POLICY)).toEqual({
        policy: USER_POLICY,
        revision: 6,
        state: 'user',
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('does not rewrite an owner-only directory while reading durable state', () => {
    const userData = temporaryUserData()
    try {
      writeRevisionFile(userData, persistedRevision(5))
      writePolicyFile(userData, persistedState(USER_POLICY, 5))
      chmodCalls.count = 0

      expect(new ExecutionPolicyStore(userData).getEffectivePolicy()).toEqual({
        policy: USER_POLICY,
        revision: 5,
        state: 'user',
      })
      expect(chmodCalls.count).toBe(0)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('repairs corrupt state from the durable high-water on valid set or reset', () => {
    const setUserData = temporaryUserData()
    const resetUserData = temporaryUserData()
    try {
      writeRevisionFile(setUserData, persistedRevision(57))
      writePolicyFile(setUserData, '{not-json')
      expect(new ExecutionPolicyStore(setUserData).setUserPolicy(USER_POLICY)).toEqual({
        policy: USER_POLICY,
        revision: 58,
        state: 'user',
      })
      expect(readFileSync(revisionFile(setUserData), 'utf8')).toBe(persistedRevision(58))

      writeRevisionFile(resetUserData, persistedRevision(57))
      writePolicyFile(resetUserData, '{not-json')
      expect(new ExecutionPolicyStore(resetUserData).resetUserPolicy()).toEqual({
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 58,
        state: 'default',
      })
      expect(readFileSync(policyFile(resetUserData), 'utf8')).toBe(persistedState(null, 58))
      expect(readFileSync(revisionFile(resetUserData), 'utf8')).toBe(persistedRevision(58))
    } finally {
      rmSync(setUserData, { recursive: true, force: true })
      rmSync(resetUserData, { recursive: true, force: true })
    }
  })

  it('repairs a strict-valid rollback sidecar from the instance floor', () => {
    const userData = temporaryUserData()
    try {
      writeRevisionFile(userData, persistedRevision(57))
      writePolicyFile(userData, persistedState(null, 57))
      const store = new ExecutionPolicyStore(userData)
      expect(store.getEffectivePolicy()).toEqual({
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 57,
        state: 'default',
      })

      writeRevisionFile(userData, persistedRevision(1))
      writePolicyFile(userData, persistedState(null, 1))
      expectFailClosed(store.getEffectivePolicy(), 57)

      expect(store.resetUserPolicy()).toEqual({
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 58,
        state: 'default',
      })
      expect(readFileSync(revisionFile(userData), 'utf8')).toBe(persistedRevision(58))
      expect(readFileSync(policyFile(userData), 'utf8')).toBe(persistedState(null, 58))
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('writes the policy directory and file owner-only with no temporary residue', () => {
    const userData = temporaryUserData()
    try {
      new ExecutionPolicyStore(userData).setUserPolicy(USER_POLICY)

      expect(lstatSync(policyDirectory(userData)).mode & 0o777).toBe(0o700)
      expect(lstatSync(policyFile(userData)).mode & 0o777).toBe(0o600)
      expect(lstatSync(revisionFile(userData)).mode & 0o777).toBe(0o600)
      expect(readdirSync(policyDirectory(userData)).sort()).toEqual([
        EXECUTION_POLICY_FILE,
        EXECUTION_POLICY_REVISION_FILE,
      ].sort())
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('rejects an oversized persisted policy without loading it as valid state', () => {
    const userData = temporaryUserData()
    try {
      const raw = `{"schemaVersion":1,"revision":1,"userPolicy":null,"padding":"${'x'.repeat(256 * 1024)}"}`
      writePolicyFile(userData, raw)

      expectFailClosed(new ExecutionPolicyStore(userData).getEffectivePolicy())
      expect(readFileSync(policyFile(userData), 'utf8')).toBe(raw)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('rejects an oversized persisted revision without loading it as valid state', () => {
    const userData = temporaryUserData()
    try {
      const raw = `{"schemaVersion":1,"highWater":1,"padding":"${'x'.repeat(256 * 1024)}"}`
      writeRevisionFile(userData, raw)
      writePolicyFile(userData, persistedState(USER_POLICY, 1))

      expectFailClosed(new ExecutionPolicyStore(userData).getEffectivePolicy())
      expect(readFileSync(revisionFile(userData), 'utf8')).toBe(raw)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('fails closed when legacy bootstrap cannot atomically create its sidecar', () => {
    const userData = temporaryUserData()
    bootstrapFailure.enabled = true
    try {
      writePolicyFile(userData, persistedState(USER_POLICY, 57))

      expectFailClosed(new ExecutionPolicyStore(userData).getEffectivePolicy())
      expect(existsSync(revisionFile(userData))).toBe(false)
    } finally {
      bootstrapFailure.enabled = false
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('repairs a corrupt legacy policy from revision one when no sidecar exists', () => {
    const userData = temporaryUserData()
    try {
      writePolicyFile(userData, '{not-json')

      expect(new ExecutionPolicyStore(userData).setUserPolicy(USER_POLICY)).toEqual({
        policy: USER_POLICY,
        revision: 1,
        state: 'user',
      })
      expect(readFileSync(revisionFile(userData), 'utf8')).toBe(persistedRevision(1))
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('persists canonical lowercase shell names', () => {
    const userData = temporaryUserData()
    try {
      const store = new ExecutionPolicyStore(userData)
      expect(store.setUserPolicy({
        ...USER_POLICY,
        shell: ['GIT', 'Gh'],
      })).toEqual({
        policy: { ...USER_POLICY, shell: ['git', 'gh'] },
        revision: 1,
        state: 'user',
      })
      expect(readFileSync(policyFile(userData), 'utf8')).toBe(
        persistedState({ ...USER_POLICY, shell: ['git', 'gh'] }, 1)
      )
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('rejects a stale expected revision without changing durable policy state', () => {
    const userData = temporaryUserData()
    try {
      const store = new ExecutionPolicyStore(userData)
      expect(store.setUserPolicy(USER_POLICY, 0)).toMatchObject({ revision: 1 })
      const beforePolicy = readFileSync(policyFile(userData), 'utf8')
      const beforeRevision = readFileSync(revisionFile(userData), 'utf8')

      expect(() => store.setUserPolicy(FULL_POLICY, 0))
        .toThrow(ExecutionPolicyRevisionConflictError)
      expect(() => store.resetUserPolicy(0))
        .toThrow(ExecutionPolicyRevisionConflictError)
      expect(readFileSync(policyFile(userData), 'utf8')).toBe(beforePolicy)
      expect(readFileSync(revisionFile(userData), 'utf8')).toBe(beforeRevision)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('keeps policy persistence separate from Plugin Capability Grants', () => {
    const userData = temporaryUserData()
    try {
      const grants = new PluginCapabilityGrantStore(join(userData, 'plugins'))
      grants.set('acme.files', { packageVersion: '1.0.0', system: ['fs'], storage: true })
      const grantFile = join(userData, 'plugins', '.navide-capability-grants.json')
      const before = readFileSync(grantFile, 'utf8')

      const policy = new ExecutionPolicyStore(userData)
      policy.setUserPolicy(USER_POLICY)
      policy.resetUserPolicy()

      expect(readFileSync(grantFile, 'utf8')).toBe(before)
      expect(grants.get('acme.files', '1.0.0')).toEqual({
        packageVersion: '1.0.0',
        system: ['fs'],
        storage: true,
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('offers explicit rebuild only for durable corruption and recreates Host-default state', () => {
    const userData = temporaryUserData()
    try {
      writeRevisionFile(userData, persistedRevision(7))
      writePolicyFile(userData, '{not-json')
      const store = new ExecutionPolicyStore(userData)

      expect(store.getRecoveryStatus()).toEqual({ state: 'corrupt', canRebuild: true, unsafePaths: [] })
      expect(store.rebuild()).toEqual({
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 8,
        state: 'default',
      })
      expect(store.getRecoveryStatus()).toEqual({ state: 'healthy', canRebuild: false, unsafePaths: [] })
      expect(readFileSync(policyFile(userData), 'utf8')).toBe(persistedState(null, 8))
      expect(readFileSync(revisionFile(userData), 'utf8')).toBe(persistedRevision(8))
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('does not offer rebuild when the policy directory itself is unsafe', () => {
    const userData = temporaryUserData()
    const target = temporaryUserData()
    try {
      symlinkSync(target, policyDirectory(userData))
      const store = new ExecutionPolicyStore(userData)

      expect(store.getRecoveryStatus()).toEqual({
        state: 'directory-unsafe',
        canRebuild: false,
        unsafePaths: [policyDirectory(userData)],
      })
      expect(() => store.rebuild()).toThrow('execution policy directory is unsafe')
      expect(lstatSync(policyDirectory(userData)).isSymbolicLink()).toBe(true)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it.each(['directory', 'symlink'] as const)(
    'does not offer rebuild for an unsafe policy file that is a %s',
    (entryType) => {
      const userData = temporaryUserData()
      try {
        writeRevisionFile(userData, persistedRevision(3))
        if (entryType === 'directory') {
          mkdirSync(policyFile(userData))
        } else {
          const target = join(userData, 'unsafe-policy-target.json')
          writeFileSync(target, persistedState(USER_POLICY), { encoding: 'utf8', mode: 0o600 })
          symlinkSync(target, policyFile(userData))
        }

        const store = new ExecutionPolicyStore(userData)
        expect(store.getRecoveryStatus()).toEqual({
          state: 'unsafe-entry',
          canRebuild: false,
          unsafePaths: [policyFile(userData)],
        })
        expect(() => store.rebuild()).toThrow(ExecutionPolicyManualRepairError)
        expect(entryType === 'directory'
          ? lstatSync(policyFile(userData)).isDirectory()
          : lstatSync(policyFile(userData)).isSymbolicLink()).toBe(true)
      } finally {
        rmSync(userData, { recursive: true, force: true })
      }
    },
  )
})
