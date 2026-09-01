import { describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionPolicy } from '../../../packages/plugin-contracts/src/index'
import {
  ExecutionPolicySourceStore,
  EXECUTION_POLICY_SOURCES_FILE,
  EXECUTION_POLICY_SOURCES_REVISION_FILE,
  REPOSITORY_EXECUTION_POLICY_PATH,
  type ExecutionPolicySourceSnapshot,
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

const USER_POLICY: ExecutionPolicy = {
  schemaVersion: 1 as const,
  mode: 'denylist' as const,
  system: ['aiCli'],
  shell: ['sudo'],
}

const CHANGED_POLICY: ExecutionPolicy = {
  schemaVersion: 1 as const,
  mode: 'allowlist' as const,
  system: ['ui'],
  shell: ['git'],
}

function temporaryRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeRecommendation(workspacePath: string, policy = RECOMMENDED_POLICY): string {
  const directory = join(workspacePath, '.navide')
  const policyPath = join(directory, 'execution-policy.json')
  mkdirSync(directory, { recursive: true })
  writeFileSync(policyPath, `${JSON.stringify(policy)}\n`, 'utf8')
  return policyPath
}

function writeRecommendationText(workspacePath: string, text: string): string {
  const directory = join(workspacePath, '.navide')
  const policyPath = join(directory, 'execution-policy.json')
  mkdirSync(directory, { recursive: true })
  writeFileSync(policyPath, text, 'utf8')
  return policyPath
}

function sourceStateFile(userData: string): string {
  return join(userData, EXECUTION_POLICY_DIRECTORY, EXECUTION_POLICY_SOURCES_FILE)
}

function sourceRevisionFile(userData: string): string {
  return join(userData, EXECUTION_POLICY_DIRECTORY, EXECUTION_POLICY_SOURCES_REVISION_FILE)
}

function policyFile(userData: string, file: string): string {
  return join(userData, EXECUTION_POLICY_DIRECTORY, file)
}

function selectionSnapshot(result: SelectSourceResult): ExecutionPolicySourceSnapshot {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  expect(result.changed).toBe(true)
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

function expectSourceSnapshot(
  snapshot: ExecutionPolicySourceSnapshot,
  expected: Partial<ExecutionPolicySourceSnapshot>,
): void {
  expect(snapshot).toMatchObject(expected)
  expect(snapshot.effectivePolicyKey).toMatch(/^epk1:[0-9a-f]{64}$/u)
  expect(snapshot.effectivePolicyHash).toMatch(/^eph1:[0-9a-f]{64}$/u)
}

describe('ExecutionPolicySourceStore', () => {
  it('inspects a repository recommendation without activating or mutating it', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    try {
      const policyPath = writeRecommendation(workspacePath)
      const before = readFileSync(policyPath, 'utf8')
      const store = new ExecutionPolicySourceStore(userData)

      const recommendation = store.inspectRepository(workspacePath)
      const effective = store.getEffectivePolicy(workspacePath)

      expect(recommendation.state).toBe('valid')
      expect(recommendation.policy).toEqual(RECOMMENDED_POLICY)
      expect(recommendation.fingerprint).toMatch(/^[0-9a-f]{64}$/)
      expectSourceSnapshot(effective, {
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 0,
        selectedSource: null,
        activeSource: 'default',
        status: 'active',
        recommendation,
      })
      expect(readFileSync(policyPath, 'utf8')).toBe(before)
      expect(existsSync(join(userData, 'execution-policy'))).toBe(false)
      expect(REPOSITORY_EXECUTION_POLICY_PATH).toBe('.navide/execution-policy.json')
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('exposes the global policy for plugin-scoped operations without a workspace', () => {
    const userData = temporaryRoot('navide-policy-source-global-')
    try {
      const store = new ExecutionPolicySourceStore(userData)

      expect(store.getGlobalEffectivePolicy()).toEqual({
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 0,
        state: 'default',
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('activates a repository recommendation only after explicit selection and persists it', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    try {
      const policyPath = writeRecommendation(workspacePath)
      const before = readFileSync(policyPath, 'utf8')
      const store = new ExecutionPolicySourceStore(userData)

      const recommendation = store.inspectRepository(workspacePath)
      const selected = selectionSnapshot(
        store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath)),
      )

      expectSourceSnapshot(selected, {
        policy: RECOMMENDED_POLICY,
        revision: 1,
        selectedSource: 'repository',
        activeSource: 'repository',
        status: 'active',
        recommendation,
      })
      expectSourceSnapshot(
        new ExecutionPolicySourceStore(userData).getEffectivePolicy(workspacePath),
        selected,
      )
      expect(readFileSync(policyPath, 'utf8')).toBe(before)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('requires the inspected repository fingerprint when accepting a recommendation', () => {
    const userData = temporaryRoot('navide-policy-source-fingerprint-user-')
    const workspacePath = temporaryRoot('navide-policy-source-fingerprint-workspace-')
    try {
      writeRecommendation(workspacePath)
      const store = new ExecutionPolicySourceStore(userData)
      const inspectedA = store.inspectRepository(workspacePath)
      expect(inspectedA.fingerprint).toMatch(/^[0-9a-f]{64}$/u)

      writeRecommendation(workspacePath, CHANGED_POLICY)
      const stale = store.selectSource(workspacePath, {
        source: 'repository',
        expectedFingerprint: inspectedA.fingerprint as string,
      })

      expect(stale.ok).toBe(false)
      if (!stale.ok) {
        expect(stale.error.code).toBe('recommendation-stale')
        expect(stale.snapshot.recommendation).toEqual({
          state: 'valid',
          policy: CHANGED_POLICY,
          fingerprint: expect.not.stringMatching(inspectedA.fingerprint as string),
        })
      }
      expect(stale.snapshot.revision).toBe(0)
      expect(stale.snapshot.selectedSource).toBeNull()
      expect(stale.snapshot.activeSource).toBe('default')
      expect(existsSync(join(userData, EXECUTION_POLICY_DIRECTORY))).toBe(false)

      const inspectedB = store.inspectRepository(workspacePath)
      expect(inspectedB.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
      const selected = selectionSnapshot(store.selectSource(workspacePath, {
        source: 'repository',
        expectedFingerprint: inspectedB.fingerprint as string,
      }))

      expect(selected.activeSource).toBe('repository')
      expect(selected.revision).toBe(1)
      expect(selected.policy).toEqual(CHANGED_POLICY)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('fails closed when Host source state contains duplicate JSON keys', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    try {
      const policyPath = writeRecommendation(workspacePath)
      const store = new ExecutionPolicySourceStore(userData)
      selectionSnapshot(
        store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath)),
      )

      writeFileSync(
        sourceStateFile(userData),
        '{"schemaVersion":1,"revision":1,"revision":1,"selections":{}}',
        'utf8'
      )

      expectSourceSnapshot(store.getEffectivePolicy(workspacePath), {
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        revision: 1,
        selectedSource: null,
        activeSource: null,
        status: 'corrupt',
        recommendation: {
          state: 'valid',
          policy: RECOMMENDED_POLICY,
          fingerprint: expect.any(String),
        },
      })
      expect(policyPath).toBe(join(workspacePath, '.navide', 'execution-policy.json'))
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('replaces sources without merging and preserves the existing global user setting', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    try {
      writeRecommendation(workspacePath)
      const sourceStore = new ExecutionPolicySourceStore(userData)
      const globalStore = new ExecutionPolicyStore(userData)
      globalStore.setUserPolicy(USER_POLICY)

      expectSourceSnapshot(sourceStore.getEffectivePolicy(workspacePath), {
        policy: USER_POLICY,
        selectedSource: null,
        activeSource: 'user',
        status: 'active',
        revision: 1,
      })
      expectSourceSnapshot(selectionSnapshot(
        sourceStore.selectSource(workspacePath, repositorySelectionRequest(sourceStore, workspacePath)),
      ), {
        policy: RECOMMENDED_POLICY,
        selectedSource: 'repository',
        activeSource: 'repository',
        status: 'active',
        revision: 2,
      })
      expectSourceSnapshot(selectionSnapshot(sourceStore.selectSource(workspacePath, {
        source: 'user',
      })), {
        policy: USER_POLICY,
        selectedSource: 'user',
        activeSource: 'user',
        status: 'active',
        revision: 3,
      })
      expectSourceSnapshot(selectionSnapshot(sourceStore.selectSource(workspacePath, {
        source: 'default',
      })), {
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        selectedSource: 'default',
        activeSource: 'default',
        status: 'active',
        revision: 4,
      })
      expect(sourceStore.getEffectivePolicy(workspacePath).policy).toEqual(HOST_DEFAULT_EXECUTION_POLICY)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('keeps an accepted source for formatting-only changes and requires re-acceptance for policy changes', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    try {
      writeRecommendation(workspacePath)
      const store = new ExecutionPolicySourceStore(userData)
      const selected = selectionSnapshot(
        store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath)),
      )

      writeRecommendationText(
        workspacePath,
        '{"shell":["GIT"],"system":["fs"],"mode":"allowlist","schemaVersion":1}\n'
      )
      expectSourceSnapshot(store.getEffectivePolicy(workspacePath), {
        policy: RECOMMENDED_POLICY,
        revision: 1,
        selectedSource: 'repository',
        activeSource: 'repository',
        status: 'active',
        recommendation: {
          state: 'valid',
          policy: RECOMMENDED_POLICY,
          fingerprint: selected.recommendation.fingerprint,
        },
      })

      writeRecommendation(workspacePath, CHANGED_POLICY)
      const stale = store.getEffectivePolicy(workspacePath)
      expect(stale.recommendation.fingerprint)
        .not.toBe(selected.recommendation.fingerprint)
      expectSourceSnapshot(stale, {
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        revision: 1,
        selectedSource: 'repository',
        activeSource: null,
        status: 'stale',
        recommendation: {
          state: 'stale',
          policy: CHANGED_POLICY,
          fingerprint: stale.recommendation.fingerprint,
        },
      })

      expectSourceSnapshot(selectionSnapshot(
        store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath)),
      ), {
        policy: CHANGED_POLICY,
        revision: 2,
        selectedSource: 'repository',
        activeSource: 'repository',
        status: 'active',
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it.each([
    ['malformed JSON', '{not-json'],
    ['unsupported schema', '{"schemaVersion":2,"mode":"allowlist","system":[],"shell":[]}'],
    ['duplicate key', '{"schemaVersion":1,"mode":"allowlist","system":[],"shell":[],"shell":[]}'],
  ])('keeps a %s recommendation visibly unselected and fails closed on selection', (_label, raw) => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    try {
      writeRecommendationText(workspacePath, raw)
      const store = new ExecutionPolicySourceStore(userData)

      expect(store.inspectRepository(workspacePath)).toEqual({
        state: 'invalid',
        policy: null,
        fingerprint: null,
      })
      expectSourceSnapshot(store.getEffectivePolicy(workspacePath), {
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 0,
        selectedSource: null,
        activeSource: 'default',
        status: 'active',
        recommendation: {
          state: 'invalid',
          policy: null,
          fingerprint: null,
        },
      })
      const result = store.selectSource(workspacePath, {
        source: 'repository',
        expectedFingerprint: '0'.repeat(64),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('recommendation-invalid')
      expect(existsSync(join(userData, EXECUTION_POLICY_DIRECTORY))).toBe(false)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('fails closed for an accepted recommendation that becomes invalid and recovers by switching sources', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    try {
      const policyPath = writeRecommendation(workspacePath)
      const globalStore = new ExecutionPolicyStore(userData)
      globalStore.setUserPolicy(USER_POLICY)
      const store = new ExecutionPolicySourceStore(userData)
      selectionSnapshot(
        store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath)),
      )

      writeRecommendationText(workspacePath, '{not-json')
      const beforeSwitch = readFileSync(policyPath, 'utf8')
      expectSourceSnapshot(store.getEffectivePolicy(workspacePath), {
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        revision: 2,
        selectedSource: 'repository',
        activeSource: null,
        status: 'corrupt',
        recommendation: {
          state: 'invalid',
          policy: null,
          fingerprint: null,
        },
      })

      expectSourceSnapshot(selectionSnapshot(store.selectSource(workspacePath, {
        source: 'user',
      })), {
        policy: USER_POLICY,
        revision: 3,
        selectedSource: 'user',
        activeSource: 'user',
        status: 'active',
      })
      expectSourceSnapshot(selectionSnapshot(store.selectSource(workspacePath, {
        source: 'default',
      })), {
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 4,
        selectedSource: 'default',
        activeSource: 'default',
        status: 'active',
      })
      expect(readFileSync(policyPath, 'utf8')).toBe(beforeSwitch)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('fails closed when an accepted repository recommendation disappears', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    try {
      const policyPath = writeRecommendation(workspacePath)
      const store = new ExecutionPolicySourceStore(userData)
      const selected = selectionSnapshot(
        store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath)),
      )
      unlinkSync(policyPath)

      expectSourceSnapshot(store.getEffectivePolicy(workspacePath), {
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        revision: selected.revision,
        selectedSource: 'repository',
        activeSource: null,
        status: 'unavailable',
        recommendation: {
          state: 'missing',
          policy: null,
          fingerprint: null,
        },
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('persists one canonical per-workspace selection with owner-only atomic state', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    try {
      writeRecommendation(workspacePath)
      const store = new ExecutionPolicySourceStore(userData)
      const selected = selectionSnapshot(
        store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath)),
      )
      const canonicalWorkspacePath = realpathSync(workspacePath)

      expect(readFileSync(sourceStateFile(userData), 'utf8')).toBe(
        `${JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          selections: {
            [canonicalWorkspacePath]: {
              source: 'repository',
              fingerprint: selected.recommendation.fingerprint,
            },
          },
        })}\n`
      )
      expect(readFileSync(sourceRevisionFile(userData), 'utf8'))
        .toBe('{"schemaVersion":1,"highWater":1}\n')
      expect(lstatSync(join(userData, EXECUTION_POLICY_DIRECTORY)).mode & 0o777).toBe(0o700)
      expect(lstatSync(sourceStateFile(userData)).mode & 0o777).toBe(0o600)
      expect(lstatSync(sourceRevisionFile(userData)).mode & 0o777).toBe(0o600)
      expect(readdirSync(join(userData, EXECUTION_POLICY_DIRECTORY)).sort()).toEqual([
        'policy.json',
        'revision.json',
        EXECUTION_POLICY_SOURCES_FILE,
        EXECUTION_POLICY_SOURCES_REVISION_FILE,
      ].sort())
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('uses one source selection for canonical workspace aliases', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    const aliasParent = temporaryRoot('navide-policy-source-alias-')
    const aliasPath = join(aliasParent, 'workspace-alias')
    try {
      writeRecommendation(workspacePath)
      symlinkSync(workspacePath, aliasPath, 'dir')
      const store = new ExecutionPolicySourceStore(userData)

      const selected = selectionSnapshot(
        store.selectSource(aliasPath, repositorySelectionRequest(store, aliasPath)),
      )
      expectSourceSnapshot(store.getEffectivePolicy(workspacePath), selected)
      const repeated = store.selectSource(workspacePath, {
        source: 'repository',
        expectedFingerprint: selected.recommendation.fingerprint as string,
      })
      expect(repeated).toMatchObject({ ok: true, changed: false, snapshot: selected })
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(aliasParent, { recursive: true, force: true })
    }
  })

  it('reports missing and unsafe repository documents without following them', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const missingWorkspacePath = temporaryRoot('navide-policy-source-missing-')
    const parentLinkWorkspacePath = temporaryRoot('navide-policy-source-parent-link-')
    const fileLinkWorkspacePath = temporaryRoot('navide-policy-source-file-link-')
    const outsidePath = temporaryRoot('navide-policy-source-outside-')
    const outsidePolicyPath = writeRecommendation(outsidePath)
    try {
      const store = new ExecutionPolicySourceStore(userData)
      expect(store.inspectRepository(missingWorkspacePath)).toEqual({
        state: 'missing',
        policy: null,
        fingerprint: null,
      })

      const parentLink = join(parentLinkWorkspacePath, '.navide')
      symlinkSync(join(outsidePath, '.navide'), parentLink, 'dir')
      expect(store.inspectRepository(parentLinkWorkspacePath)).toEqual({
        state: 'invalid',
        policy: null,
        fingerprint: null,
      })
      unlinkSync(parentLink)

      const fileLinkDirectory = join(fileLinkWorkspacePath, '.navide')
      mkdirSync(fileLinkDirectory)
      const fileLink = join(fileLinkDirectory, 'execution-policy.json')
      symlinkSync(outsidePolicyPath, fileLink)
      expect(store.inspectRepository(fileLinkWorkspacePath)).toEqual({
        state: 'invalid',
        policy: null,
        fingerprint: null,
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(missingWorkspacePath, { recursive: true, force: true })
      rmSync(parentLinkWorkspacePath, { recursive: true, force: true })
      rmSync(fileLinkWorkspacePath, { recursive: true, force: true })
      rmSync(outsidePath, { recursive: true, force: true })
    }
  })

  it('rejects an oversized repository recommendation before parsing it', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    try {
      writeRecommendationText(
        workspacePath,
        `{"schemaVersion":1,"mode":"allowlist","system":[],"shell":[],"padding":"${'x'.repeat(256 * 1024)}"}`
      )
      expect(new ExecutionPolicySourceStore(userData).inspectRepository(workspacePath)).toEqual({
        state: 'invalid',
        policy: null,
        fingerprint: null,
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('fails closed and refuses source changes when the Host source revision is corrupt', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    try {
      writeRecommendation(workspacePath)
      const store = new ExecutionPolicySourceStore(userData)
      const selected = selectionSnapshot(
        store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath)),
      )
      writeFileSync(sourceRevisionFile(userData), '{not-json', 'utf8')

      expectSourceSnapshot(store.getEffectivePolicy(workspacePath), {
        policy: FAIL_CLOSED_EXECUTION_POLICY,
        revision: selected.revision,
        selectedSource: null,
        activeSource: null,
        status: 'corrupt',
        recommendation: selected.recommendation,
      })
      const result = store.selectSource(workspacePath, { source: 'default' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('source-state-corrupt')
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('allows explicit default recovery with a trusted global revision and preserves corrupt policy data', () => {
    const userData = temporaryRoot('navide-policy-source-recovery-user-')
    const workspacePath = temporaryRoot('navide-policy-source-recovery-workspace-')
    try {
      const directory = join(userData, EXECUTION_POLICY_DIRECTORY)
      const globalPolicyPath = policyFile(userData, EXECUTION_POLICY_FILE)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(globalPolicyPath, '{not-json\n', 'utf8')
      chmodSync(globalPolicyPath, 0o600)
      writeFileSync(
        policyFile(userData, EXECUTION_POLICY_REVISION_FILE),
        '{"schemaVersion":1,"highWater":4}\n',
        'utf8',
      )
      chmodSync(policyFile(userData, EXECUTION_POLICY_REVISION_FILE), 0o600)
      writeRecommendation(workspacePath)
      const beforePolicy = readFileSync(globalPolicyPath, 'utf8')
      const store = new ExecutionPolicySourceStore(userData)

      const selected = selectionSnapshot(store.selectSource(workspacePath, { source: 'default' }))

      expectSourceSnapshot(selected, {
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 5,
        selectedSource: 'default',
        activeSource: 'default',
        status: 'active',
      })
      expect(readFileSync(globalPolicyPath, 'utf8')).toBe(beforePolicy)
      expect(readFileSync(
        policyFile(userData, EXECUTION_POLICY_REVISION_FILE),
        'utf8',
      )).toBe('{"schemaVersion":1,"highWater":5}\n')
      expect(store.getSettingsSnapshot(workspacePath)).toMatchObject({
        global: {
          revision: 5,
          state: 'corrupt',
        },
        recovery: { state: 'corrupt', canRebuild: true, unsafePaths: [] },
        workspace: {
          selectedSource: 'default',
          activeSource: 'default',
          status: 'active',
          policy: HOST_DEFAULT_EXECUTION_POLICY,
        },
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('requires manual repair when default recovery cannot trust the global revision entry', () => {
    const userData = temporaryRoot('navide-policy-source-unsafe-recovery-user-')
    const workspacePath = temporaryRoot('navide-policy-source-unsafe-recovery-workspace-')
    try {
      const directory = join(userData, EXECUTION_POLICY_DIRECTORY)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(policyFile(userData, EXECUTION_POLICY_FILE), '{not-json\n', 'utf8')
      mkdirSync(policyFile(userData, EXECUTION_POLICY_REVISION_FILE))
      writeRecommendation(workspacePath)
      const store = new ExecutionPolicySourceStore(userData)

      const result = store.selectSource(workspacePath, { source: 'default' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('manual-repair-required')
      expect(existsSync(sourceStateFile(userData))).toBe(false)
      expect(lstatSync(policyFile(userData, EXECUTION_POLICY_REVISION_FILE)).isDirectory()).toBe(true)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('persists an explicit user source and follows the global user setting', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const workspacePath = temporaryRoot('navide-policy-source-workspace-')
    try {
      const globalStore = new ExecutionPolicyStore(userData)
      const store = new ExecutionPolicySourceStore(userData)
      const unavailable = store.selectSource(workspacePath, { source: 'user' })
      expect(unavailable.ok).toBe(false)
      if (!unavailable.ok) expect(unavailable.error.code).toBe('user-policy-unavailable')
      expect(existsSync(join(userData, EXECUTION_POLICY_DIRECTORY))).toBe(false)

      globalStore.setUserPolicy(USER_POLICY)
      const selected = selectionSnapshot(store.selectSource(workspacePath, { source: 'user' }))
      expectSourceSnapshot(selected, {
        policy: USER_POLICY,
        revision: 2,
        selectedSource: 'user',
        activeSource: 'user',
        status: 'active',
      })
      expectSourceSnapshot(
        new ExecutionPolicySourceStore(userData).getEffectivePolicy(workspacePath),
        selected,
      )

      globalStore.setUserPolicy(USER_POLICY)
      expectSourceSnapshot(store.getEffectivePolicy(workspacePath), {
        policy: USER_POLICY,
        revision: 3,
        selectedSource: 'user',
        activeSource: 'user',
        status: 'active',
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('keeps independent selections for different repositories', () => {
    const userData = temporaryRoot('navide-policy-source-user-')
    const firstWorkspacePath = temporaryRoot('navide-policy-source-first-')
    const secondWorkspacePath = temporaryRoot('navide-policy-source-second-')
    try {
      const firstPolicyPath = writeRecommendation(firstWorkspacePath)
      writeRecommendation(secondWorkspacePath, CHANGED_POLICY)
      const firstBefore = readFileSync(firstPolicyPath, 'utf8')
      const store = new ExecutionPolicySourceStore(userData)

      const first = selectionSnapshot(
        store.selectSource(firstWorkspacePath, repositorySelectionRequest(store, firstWorkspacePath)),
      )
      const second = selectionSnapshot(
        store.selectSource(secondWorkspacePath, { source: 'default' }),
      )

      expect(first.policy).toEqual(RECOMMENDED_POLICY)
      expect(first.activeSource).toBe('repository')
      expectSourceSnapshot(second, {
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: 2,
        selectedSource: 'default',
        activeSource: 'default',
        status: 'active',
      })
      expectSourceSnapshot(store.getEffectivePolicy(firstWorkspacePath), {
        policy: RECOMMENDED_POLICY,
        revision: 2,
        selectedSource: 'repository',
        activeSource: 'repository',
        status: 'active',
        recommendation: first.recommendation,
      })
      expect(readFileSync(firstPolicyPath, 'utf8')).toBe(firstBefore)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(firstWorkspacePath, { recursive: true, force: true })
      rmSync(secondWorkspacePath, { recursive: true, force: true })
    }
  })

  it('resets all source pins without modifying repository policy files', () => {
    const userData = temporaryRoot('navide-policy-source-reset-user-')
    const firstWorkspacePath = temporaryRoot('navide-policy-source-reset-first-')
    const secondWorkspacePath = temporaryRoot('navide-policy-source-reset-second-')
    try {
      const firstPolicyPath = writeRecommendation(firstWorkspacePath)
      writeRecommendation(secondWorkspacePath, CHANGED_POLICY)
      const beforeRepositoryPolicy = readFileSync(firstPolicyPath, 'utf8')
      new ExecutionPolicyStore(userData).setUserPolicy(USER_POLICY)
      const store = new ExecutionPolicySourceStore(userData)

      selectionSnapshot(
        store.selectSource(firstWorkspacePath, repositorySelectionRequest(store, firstWorkspacePath)),
      )
      selectionSnapshot(store.selectSource(secondWorkspacePath, { source: 'default' }))

      const reset = store.resetSourceState()
      expect(reset).toEqual({ ok: true, changed: true, snapshot: null })
      expect(JSON.parse(readFileSync(sourceStateFile(userData), 'utf8'))).toMatchObject({
        selections: {},
      })
      expect(readFileSync(firstPolicyPath, 'utf8')).toBe(beforeRepositoryPolicy)
      expectSourceSnapshot(store.getEffectivePolicy(firstWorkspacePath), {
        policy: USER_POLICY,
        selectedSource: null,
        activeSource: 'user',
        status: 'active',
      })
      expectSourceSnapshot(store.getEffectivePolicy(secondWorkspacePath), {
        policy: USER_POLICY,
        selectedSource: null,
        activeSource: 'user',
        status: 'active',
      })
      expect(store.getSettingsSnapshot(firstWorkspacePath).sourceRecovery).toEqual({
        state: 'healthy',
        canReset: false,
        unsafePaths: [],
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(firstWorkspacePath, { recursive: true, force: true })
      rmSync(secondWorkspacePath, { recursive: true, force: true })
    }
  })

  it('rebuilds corrupt global state while preserving and revalidating source selection', () => {
    const userData = temporaryRoot('navide-policy-source-rebuild-user-')
    const workspacePath = temporaryRoot('navide-policy-source-rebuild-workspace-')
    try {
      writeRecommendation(workspacePath)
      const store = new ExecutionPolicySourceStore(userData)
      const selected = selectionSnapshot(
        store.selectSource(workspacePath, repositorySelectionRequest(store, workspacePath)),
      )
      const beforeSources = readFileSync(sourceStateFile(userData), 'utf8')
      const beforeSourceRevision = readFileSync(sourceRevisionFile(userData), 'utf8')
      writeFileSync(policyFile(userData, EXECUTION_POLICY_FILE), '{not-json', 'utf8')

      expect(store.getSettingsSnapshot(workspacePath).recovery).toEqual({
        state: 'corrupt',
        canRebuild: true,
        unsafePaths: [],
      })

      const rebuilt = store.rebuildGlobalPolicy(workspacePath)
      expect(rebuilt.global).toEqual({
        policy: HOST_DEFAULT_EXECUTION_POLICY,
        revision: selected.revision + 1,
        state: 'default',
      })
      expect(rebuilt.workspace).toMatchObject({
        policy: RECOMMENDED_POLICY,
        selectedSource: 'repository',
        activeSource: 'repository',
        status: 'active',
      })
      expect(readFileSync(sourceStateFile(userData), 'utf8')).toBe(beforeSources)
      expect(readFileSync(sourceRevisionFile(userData), 'utf8')).toBe(beforeSourceRevision)
      expect(readFileSync(policyFile(userData, EXECUTION_POLICY_REVISION_FILE), 'utf8'))
        .not.toBe(beforeSourceRevision)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})
