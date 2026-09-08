import { describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const closeFailure = vi.hoisted(() => ({ enabled: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      if (closeFailure.enabled) {
        closeFailure.enabled = false
        actual.closeSync(...args)
        throw new Error('simulated descriptor close failure')
      }
      return actual.closeSync(...args)
    },
  }
})

import type { ExecutionPolicy } from '../../../packages/plugin-contracts/src/index'
import {
  ExecutionPolicySourceStore,
  ExecutionPolicySourceCommitError,
  EXECUTION_POLICY_SOURCES_FILE,
  EXECUTION_POLICY_SOURCES_REVISION_FILE,
  type SourceSelectionRequest,
  type SelectSourceResult,
} from './executionPolicySourceStore'
import {
  EXECUTION_POLICY_DIRECTORY,
  EXECUTION_POLICY_FILE,
  EXECUTION_POLICY_REVISION_FILE,
  FAIL_CLOSED_EXECUTION_POLICY,
  HOST_DEFAULT_EXECUTION_POLICY,
  ExecutionPolicyStore,
} from './executionPolicyStore'

const RECOMMENDED_POLICY: ExecutionPolicy = {
  schemaVersion: 1 as const,
  mode: 'allowlist' as const,
  system: ['fs'],
  shell: ['git'],
}

function temporaryRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeRecommendation(
  workspacePath: string,
  policy = RECOMMENDED_POLICY,
): string {
  const directory = join(workspacePath, '.navide')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'execution-policy.json'),
    `${JSON.stringify(policy)}\n`,
    { encoding: 'utf8', flag: 'w' },
  )
  return join(directory, 'execution-policy.json')
}

function writeRecommendationText(workspacePath: string, text: string): void {
  const directory = join(workspacePath, '.navide')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'execution-policy.json'), text, 'utf8')
}

function policyFile(userData: string, file: string): string {
  return join(userData, EXECUTION_POLICY_DIRECTORY, file)
}

function sourceFile(userData: string, file: string): string {
  return join(userData, EXECUTION_POLICY_DIRECTORY, file)
}

function selectionSnapshot(result: SelectSourceResult) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  return result.snapshot
}

function repositorySelectionRequest(
  store: ExecutionPolicySourceStore,
  workspacePath: string,
): SourceSelectionRequest {
  const recommendation = store.inspectRepository(workspacePath)
  if (recommendation.state !== 'valid' || recommendation.fingerprint === null) {
    throw new Error('expected a valid repository recommendation')
  }
  return { source: 'repository', expectedFingerprint: recommendation.fingerprint }
}

class SourceWriteFailurePolicyStore extends ExecutionPolicyStore {
  constructor(
    userData: string,
    private readonly sourceStatePath: string,
  ) {
    super(userData)
  }

  override advanceRevision(minimumRevision = 0) {
    const result = super.advanceRevision(minimumRevision)
    mkdirSync(dirname(this.sourceStatePath), { recursive: true, mode: 0o700 })
    mkdirSync(this.sourceStatePath)
    return result
  }
}

class HealthyPolicyStore extends ExecutionPolicyStore {
  override getEffectivePolicy() {
    return {
      policy: HOST_DEFAULT_EXECUTION_POLICY,
      revision: 1,
      state: 'default' as const,
    }
  }
}

describe('ExecutionPolicySourceStore hardening', () => {
  it('fails closed when global state closes unsuccessfully after a successful read', () => {
    const userData = temporaryRoot('navide-policy-source-global-close-user-')
    try {
      const directory = join(userData, EXECUTION_POLICY_DIRECTORY)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const revisionPath = policyFile(userData, EXECUTION_POLICY_REVISION_FILE)
      const statePath = policyFile(userData, EXECUTION_POLICY_FILE)
      writeFileSync(revisionPath, '{"schemaVersion":1,"highWater":1}\n', {
        encoding: 'utf8',
        mode: 0o600,
      })
      writeFileSync(statePath, '{"schemaVersion":1,"revision":1,"userPolicy":null}\n', {
        encoding: 'utf8',
        mode: 0o600,
      })
      chmodSync(directory, 0o700)
      chmodSync(revisionPath, 0o600)
      chmodSync(statePath, 0o600)
      const beforeRevision = readFileSync(revisionPath, 'utf8')
      const beforeState = readFileSync(statePath, 'utf8')

      closeFailure.enabled = true
      expect(new ExecutionPolicyStore(userData).getEffectivePolicy()).toEqual({
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        revision: 0,
        state: 'corrupt',
      })
      expect(readFileSync(revisionPath, 'utf8')).toBe(beforeRevision)
      expect(readFileSync(statePath, 'utf8')).toBe(beforeState)
    } finally {
      closeFailure.enabled = false
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('rejects source state when its descriptor closes unsuccessfully after a successful read', () => {
    const userData = temporaryRoot('navide-policy-source-close-user-')
    const workspacePath = temporaryRoot('navide-policy-source-close-workspace-')
    try {
      const directory = join(userData, EXECUTION_POLICY_DIRECTORY)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const revisionPath = sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE)
      const statePath = sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE)
      writeFileSync(revisionPath, '{"schemaVersion":1,"highWater":1}\n', {
        encoding: 'utf8',
        mode: 0o600,
      })
      writeFileSync(statePath, `${JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        selections: { [workspacePath]: { source: 'default' } },
      })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      chmodSync(directory, 0o700)
      chmodSync(revisionPath, 0o600)
      chmodSync(statePath, 0o600)
      const beforeRevision = readFileSync(revisionPath, 'utf8')
      const beforeState = readFileSync(statePath, 'utf8')
      const store = new ExecutionPolicySourceStore(
        userData,
        new HealthyPolicyStore(userData),
      )

      closeFailure.enabled = true
      const result = store.selectSource(workspacePath, { source: 'default' })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('source-state-unavailable')
        expect(result.snapshot).toMatchObject({
          policy: FAIL_CLOSED_EXECUTION_POLICY,
          revision: 1,
          selectedSource: null,
          activeSource: null,
          status: 'unavailable',
        })
      }
      expect(readFileSync(revisionPath, 'utf8')).toBe(beforeRevision)
      expect(readFileSync(statePath, 'utf8')).toBe(beforeState)
    } finally {
      closeFailure.enabled = false
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('keeps the source revision above its durable floor after global state loss', () => {
    const userData = temporaryRoot('navide-policy-source-floor-user-')
    const workspacePath = temporaryRoot('navide-policy-source-floor-workspace-')
    try {
      writeRecommendation(workspacePath)
      const store = new ExecutionPolicySourceStore(userData)
      store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath))
      store.selectSource(workspacePath, { source: 'default' })
      store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath))

      unlinkSync(policyFile(userData, EXECUTION_POLICY_FILE))
      unlinkSync(policyFile(userData, EXECUTION_POLICY_REVISION_FILE))

      const restarted = new ExecutionPolicySourceStore(userData)
      expect(restarted.getEffectivePolicy(workspacePath).revision).toBe(3)
      const selected = restarted.selectSource(workspacePath, { source: 'default' })

      expect(selected.ok).toBe(true)
      if (selected.ok) expect(selected.snapshot.revision).toBe(4)
      expect(JSON.parse(readFileSync(
        sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE),
        'utf8',
      ))).toEqual({ schemaVersion: 1, highWater: 4 })
      expect(new ExecutionPolicySourceStore(userData).getEffectivePolicy(workspacePath).revision)
        .toBe(4)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('does not silently return a corrupt no-op when global policy state is unhealthy', () => {
    const userData = temporaryRoot('navide-policy-source-noop-user-')
    const workspacePath = temporaryRoot('navide-policy-source-noop-workspace-')
    try {
      writeRecommendation(workspacePath)
      const store = new ExecutionPolicySourceStore(userData)
      store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath))
      const before = readFileSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE), 'utf8')
      unlinkSync(policyFile(userData, EXECUTION_POLICY_FILE))

      const result = store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath))

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('global-policy-corrupt')
      expect(readFileSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE), 'utf8'))
        .toBe(before)
      expect(existsSync(policyFile(userData, EXECUTION_POLICY_REVISION_FILE))).toBe(true)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('uses the revision floor supplied by source state when advancing global policy', () => {
    const userData = temporaryRoot('navide-policy-source-advance-user-')
    try {
      const store = new ExecutionPolicyStore(userData)
      expect(store.advanceRevision(7).revision).toBe(8)
      expect(store.advanceRevision(3).revision).toBe(9)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('returns typed unavailable results for a workspace that cannot be resolved', () => {
    const userData = temporaryRoot('navide-policy-source-unavailable-user-')
    const workspacePath = join(userData, 'missing-workspace')
    try {
      const store = new ExecutionPolicySourceStore(userData)

      expect(store.inspectRepository(workspacePath)).toEqual({
        state: 'unavailable',
        policy: null,
        fingerprint: null,
      })
      expect(store.getEffectivePolicy(workspacePath)).toMatchObject({
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        selectedSource: null,
        activeSource: null,
        status: 'unavailable',
      })

      const result = store.selectSource(workspacePath, { source: 'default' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('workspace-unavailable')
        expect(result.snapshot.status).toBe('unavailable')
      }
      expect(existsSync(join(userData, EXECUTION_POLICY_DIRECTORY))).toBe(false)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('reports a temporarily inaccessible repository document as unavailable', () => {
    const userData = temporaryRoot('navide-policy-source-recommendation-unavailable-user-')
    const workspacePath = temporaryRoot('navide-policy-source-recommendation-unavailable-workspace-')
    const repositoryDirectory = join(workspacePath, '.navide')
    try {
      writeRecommendation(workspacePath)
      chmodSync(repositoryDirectory, 0o000)
      const store = new ExecutionPolicySourceStore(userData)

      expect(store.inspectRepository(workspacePath)).toEqual({
        state: 'unavailable',
        policy: null,
        fingerprint: null,
      })
      const result = store.selectSource(workspacePath, {
        source: 'repository',
        expectedFingerprint: '0'.repeat(64),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('recommendation-unavailable')
    } finally {
      chmodSync(repositoryDirectory, 0o700)
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('rejects oversized source state before revision advance and repairs it only by full reset', () => {
    const userData = temporaryRoot('navide-policy-source-oversize-user-')
    const workspacePath = temporaryRoot('navide-policy-source-oversize-workspace-')
    try {
      const directory = join(userData, EXECUTION_POLICY_DIRECTORY)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      const selections: Record<string, { source: 'default' }> = {}
      for (let index = 0; index < 4000; index += 1) {
        selections[`/tmp/navide-source-${index.toString().padStart(5, '0')}-${'x'.repeat(50)}`] = {
          source: 'default',
        }
      }
      writeFileSync(
        sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE),
        `${JSON.stringify({ schemaVersion: 1, revision: 1, selections })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      writeFileSync(
        sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE),
        '{"schemaVersion":1,"highWater":1}\n',
        { encoding: 'utf8', mode: 0o600 },
      )
      chmodSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE), 0o600)
      chmodSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE), 0o600)

      const store = new ExecutionPolicySourceStore(userData)
      const beforeRevision = readFileSync(
        sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE),
        'utf8',
      )
      const denied = store.selectSource(workspacePath, { source: 'default' })

      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.error.code).toBe('source-state-too-large')
      expect(readFileSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE), 'utf8'))
        .toBe(beforeRevision)
      expect(existsSync(policyFile(userData, EXECUTION_POLICY_FILE))).toBe(false)

      const reset = store.resetSourceState()
      expect(reset).toEqual({ ok: true, changed: true, snapshot: null })
      expect(JSON.parse(readFileSync(
        sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE),
        'utf8',
      ))).toEqual({ schemaVersion: 1, highWater: 2 })
      expect(JSON.parse(readFileSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE), 'utf8')))
        .toEqual({ schemaVersion: 1, revision: 2, selections: {} })
      expect(store.getEffectivePolicy(workspacePath)).toMatchObject({
        policy: expect.any(Object),
        revision: 2,
        selectedSource: null,
        activeSource: 'default',
        status: 'active',
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('exposes a dedicated error when source commit outcome is uncertain', () => {
    const userData = temporaryRoot('navide-policy-source-commit-user-')
    const workspacePath = temporaryRoot('navide-policy-source-commit-workspace-')
    try {
      const sourceStatePath = sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE)
      const policyStore = new SourceWriteFailurePolicyStore(userData, sourceStatePath)
      const store = new ExecutionPolicySourceStore(userData, policyStore)

      expect(() => store.selectSource(workspacePath, { source: 'default' }))
        .toThrow(ExecutionPolicySourceCommitError)
      expect(new ExecutionPolicyStore(userData).getEffectivePolicy().revision).toBe(1)
      expect(lstatSync(sourceStatePath).isDirectory()).toBe(true)
      expect(store.getEffectivePolicy(workspacePath).status).toBe('corrupt')
      expect(store.getEffectivePolicy(workspacePath).selectedSource).toBeNull()
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('leaves a fresh missing source state untouched when reset has nothing to recover', () => {
    const userData = temporaryRoot('navide-policy-source-fresh-reset-user-')
    try {
      const result = new ExecutionPolicySourceStore(userData).resetSourceState()

      expect(result).toEqual({ ok: true, changed: false, snapshot: null })
      expect(existsSync(join(userData, EXECUTION_POLICY_DIRECTORY))).toBe(false)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('rejects source reset when its durable high-water mark is not trustworthy', () => {
    const userData = temporaryRoot('navide-policy-source-reset-floor-user-')
    try {
      const directory = join(userData, EXECUTION_POLICY_DIRECTORY)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const statePath = sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE)
      const revisionPath = sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE)
      writeFileSync(statePath, '{"schemaVersion":1,"revision":1,"selections":{}}\n', {
        encoding: 'utf8',
        mode: 0o600,
      })
      writeFileSync(revisionPath, '{not-json', { encoding: 'utf8', mode: 0o600 })
      chmodSync(statePath, 0o600)
      chmodSync(revisionPath, 0o600)
      const beforeState = readFileSync(statePath, 'utf8')
      const beforeRevision = readFileSync(revisionPath, 'utf8')

      const result = new ExecutionPolicySourceStore(userData).resetSourceState()

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'source-state-corrupt',
          message: 'execution policy source state is corrupt or unsafe',
        },
        snapshot: null,
      })
      expect(readFileSync(statePath, 'utf8')).toBe(beforeState)
      expect(readFileSync(revisionPath, 'utf8')).toBe(beforeRevision)
      expect(existsSync(policyFile(userData, EXECUTION_POLICY_FILE))).toBe(false)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('rejects reset before revision advance when the source state entry is unsafe', () => {
    const userData = temporaryRoot('navide-policy-source-reset-unsafe-user-')
    try {
      const directory = join(userData, EXECUTION_POLICY_DIRECTORY)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const statePath = sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE)
      const revisionPath = sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE)
      mkdirSync(statePath)
      writeFileSync(revisionPath, '{"schemaVersion":1,"highWater":1}\n', {
        encoding: 'utf8',
        mode: 0o600,
      })
      chmodSync(revisionPath, 0o600)

      const result = new ExecutionPolicySourceStore(userData).resetSourceState()

      expect(result).toMatchObject({ ok: false, error: { code: 'source-state-corrupt' } })
      expect(existsSync(policyFile(userData, EXECUTION_POLICY_FILE))).toBe(false)
      expect(readFileSync(revisionPath, 'utf8')).toBe('{"schemaVersion":1,"highWater":1}\n')
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('does not use source reset to repair a corrupt global policy store', () => {
    const userData = temporaryRoot('navide-policy-source-reset-global-user-')
    const workspacePath = temporaryRoot('navide-policy-source-reset-global-workspace-')
    try {
      const store = new ExecutionPolicySourceStore(userData)
      const selected = store.selectSource(workspacePath, { source: 'default' })
      expect(selected.ok).toBe(true)
      const beforeState = readFileSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE), 'utf8')
      writeFileSync(policyFile(userData, EXECUTION_POLICY_FILE), '{not-json', 'utf8')

      const result = store.resetSourceState()

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'recovery-blocked-by-global-policy',
          message: 'source recovery is blocked by global policy state',
        },
        snapshot: null,
      })
      expect(readFileSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE), 'utf8'))
        .toBe(beforeState)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('does not write or advance revision for a healthy source no-op', () => {
    const userData = temporaryRoot('navide-policy-source-noop-healthy-user-')
    const workspacePath = temporaryRoot('navide-policy-source-noop-healthy-workspace-')
    try {
      writeRecommendation(workspacePath)
      const store = new ExecutionPolicySourceStore(userData)
      const first = store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath))
      expect(first.ok).toBe(true)
      const beforeState = readFileSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE), 'utf8')
      const beforeRevision = readFileSync(
        sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE),
        'utf8',
      )

      const repeated = store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath))

      expect(repeated).toMatchObject({ ok: true, changed: false })
      if (repeated.ok && first.ok) expect(repeated.snapshot).toEqual(first.snapshot)
      expect(readFileSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE), 'utf8'))
        .toBe(beforeState)
      expect(readFileSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE), 'utf8'))
        .toBe(beforeRevision)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('changes the snapshot key while preserving one hash for fail-closed policies', () => {
    const userData = temporaryRoot('navide-policy-source-key-user-')
    const workspacePath = temporaryRoot('navide-policy-source-key-workspace-')
    try {
      const policyPath = writeRecommendation(workspacePath)
      const store = new ExecutionPolicySourceStore(userData)
      const active = selectionSnapshot(
        store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath)),
      )

      writeRecommendation(workspacePath, {
        schemaVersion: 1,
        mode: 'allowlist',
        system: ['ui'],
        shell: ['git'],
      })
      const stale = store.getEffectivePolicy(workspacePath)
      unlinkSync(policyPath)
      const unavailable = store.getEffectivePolicy(workspacePath)
      writeRecommendationText(workspacePath, '{not-json')
      const corrupt = store.getEffectivePolicy(workspacePath)

      expect(stale.status).toBe('stale')
      expect(unavailable.status).toBe('unavailable')
      expect(corrupt.status).toBe('corrupt')
      expect(new Set([active.effectivePolicyKey, stale.effectivePolicyKey,
        unavailable.effectivePolicyKey, corrupt.effectivePolicyKey]).size).toBe(4)
      expect(stale.effectivePolicyHash).toBe(unavailable.effectivePolicyHash)
      expect(unavailable.effectivePolicyHash).toBe(corrupt.effectivePolicyHash)
      expect(active.effectivePolicyHash).not.toBe(stale.effectivePolicyHash)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('keeps an explicit user selection while reporting the missing policy as unavailable', () => {
    const userData = temporaryRoot('navide-policy-source-user-status-user-')
    const workspacePath = temporaryRoot('navide-policy-source-user-status-workspace-')
    try {
      const globalStore = new ExecutionPolicyStore(userData)
      globalStore.setUserPolicy(RECOMMENDED_POLICY)
      const store = new ExecutionPolicySourceStore(userData)
      selectionSnapshot(store.selectSource(workspacePath, { source: 'user' }))

      globalStore.resetUserPolicy()
      const snapshot = store.getEffectivePolicy(workspacePath)

      expect(snapshot).toMatchObject({
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        selectedSource: 'user',
        activeSource: null,
        status: 'unavailable',
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it.each([
    ['malformed global policy', (userData: string) => {
      writeFileSync(policyFile(userData, EXECUTION_POLICY_FILE), '{not-json', 'utf8')
    }],
    ['owner-unsafe global policy', (userData: string) => {
      chmodSync(policyFile(userData, EXECUTION_POLICY_FILE), 0o644)
    }],
    ['corrupt global revision metadata', (userData: string) => {
      writeFileSync(policyFile(userData, EXECUTION_POLICY_REVISION_FILE), '{not-json', 'utf8')
    }],
  ] as const)('keeps an explicit user pin fail-closed for %s', (_label, corruptGlobal) => {
    const userData = temporaryRoot('navide-policy-source-user-corrupt-global-')
    const workspacePath = temporaryRoot('navide-policy-source-user-corrupt-global-workspace-')
    try {
      const globalStore = new ExecutionPolicyStore(userData)
      globalStore.setUserPolicy(RECOMMENDED_POLICY)
      const store = new ExecutionPolicySourceStore(userData)
      selectionSnapshot(store.selectSource(workspacePath, { source: 'user' }))
      const beforeState = readFileSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE), 'utf8')
      const beforeRevision = readFileSync(
        sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE),
        'utf8',
      )

      corruptGlobal(userData)

      expect(store.getEffectivePolicy(workspacePath)).toMatchObject({
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        selectedSource: 'user',
        activeSource: null,
        status: 'corrupt',
      })
      const result = store.selectSource(workspacePath, { source: 'user' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('global-policy-corrupt')
      expect(readFileSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE), 'utf8'))
        .toBe(beforeState)
      expect(readFileSync(sourceFile(userData, EXECUTION_POLICY_SOURCES_REVISION_FILE), 'utf8'))
        .toBe(beforeRevision)
    } finally {
      chmodSync(policyFile(userData, EXECUTION_POLICY_FILE), 0o600)
      chmodSync(policyFile(userData, EXECUTION_POLICY_REVISION_FILE), 0o600)
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('keeps an invalid unselected recommendation separate from the active default source', () => {
    const userData = temporaryRoot('navide-policy-source-unselected-user-')
    const workspacePath = temporaryRoot('navide-policy-source-unselected-workspace-')
    try {
      writeRecommendationText(workspacePath, '{not-json')
      const store = new ExecutionPolicySourceStore(userData)
      const snapshot = store.getEffectivePolicy(workspacePath)

      expect(snapshot).toMatchObject({
        policy: expect.any(Object),
        selectedSource: null,
        activeSource: 'default',
        status: 'active',
        recommendation: { state: 'invalid' },
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('writes source selections in deterministic code-unit order', () => {
    const userData = temporaryRoot('navide-policy-source-order-user-')
    const workspaceRoot = temporaryRoot('navide-policy-source-order-workspaces-')
    const upperWorkspace = join(workspaceRoot, 'Z')
    const lowerWorkspace = join(workspaceRoot, 'a')
    try {
      mkdirSync(upperWorkspace)
      mkdirSync(lowerWorkspace)
      const store = new ExecutionPolicySourceStore(userData)
      selectionSnapshot(store.selectSource(lowerWorkspace, { source: 'default' }))
      selectionSnapshot(store.selectSource(upperWorkspace, { source: 'default' }))

      const keys = Object.keys(JSON.parse(readFileSync(
        sourceFile(userData, EXECUTION_POLICY_SOURCES_FILE),
        'utf8',
      )).selections)
      expect(keys).toEqual([...keys].sort())
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })
})
