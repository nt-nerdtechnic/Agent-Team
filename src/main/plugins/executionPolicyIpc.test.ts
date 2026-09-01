import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionPolicy } from '../../../packages/plugin-contracts/src/index'
import { EXECUTION_POLICY_DIRECTORY, EXECUTION_POLICY_FILE, EXECUTION_POLICY_REVISION_FILE } from './executionPolicyStore'
import {
  ExecutionPolicySourceCommitError,
  ExecutionPolicySourceStore,
} from './executionPolicySourceStore'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
}))

import { registerExecutionPolicyIpc } from './executionPolicyIpc'

const FULL_POLICY: ExecutionPolicy = {
  schemaVersion: 1,
  mode: 'full',
  system: [],
  shell: [],
}

function temporaryUserData(): string {
  return mkdtempSync(join(tmpdir(), 'navide-execution-policy-ipc-'))
}

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`missing handler ${channel}`)
  return Promise.resolve(handler({}, ...args) as T)
}

function registerPolicyIpc(
  store: ExecutionPolicySourceStore,
  workspacePath?: string,
  onChanged?: () => void,
): void {
  registerExecutionPolicyIpc(store, () => true, {
    resolveWorkspace: (_event, requestedWorkspace) => {
      if (!workspacePath) return undefined
      if (requestedWorkspace === undefined || requestedWorkspace === workspacePath) {
        return workspacePath
      }
      return undefined
    },
    onChanged,
  })
}

describe('execution policy IPC', () => {
  it('requires explicit high-risk confirmation before persisting full mode', async () => {
    const userData = temporaryUserData()
    try {
      handlers.clear()
      const store = new ExecutionPolicySourceStore(userData)
      registerPolicyIpc(store)

      const denied = await call<{
        ok: boolean
        error?: { code: string }
      }>('execution-policy:set-user', { policy: FULL_POLICY })
      expect(denied).toMatchObject({
        ok: false,
        error: { code: 'high-risk-confirmation-required' },
      })
      expect(store.getGlobalEffectivePolicy().state).toBe('default')

      const accepted = await call<{ ok: boolean; snapshot: { global: { state: string } } }>(
        'execution-policy:set-user',
        { policy: FULL_POLICY, highRiskConfirmed: true, expectedRevision: 0 },
      )
      expect(accepted).toMatchObject({ ok: true, snapshot: { global: { state: 'user' } } })
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('returns safe typed errors and broadcasts successful policy changes', async () => {
    const userData = temporaryUserData()
    try {
      handlers.clear()
      const changed = vi.fn()
      const store = new ExecutionPolicySourceStore(userData)
      registerPolicyIpc(store, undefined, changed)

      const invalid = await call<{ ok: boolean; error?: { code: string; message: string } }>(
        'execution-policy:set-user',
        {
          policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: ['git status'] },
        },
      )
      expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid-policy' } })
      expect(invalid.error?.message).not.toContain('policy.json')
      expect(changed).not.toHaveBeenCalled()

      const saved = await call<{ ok: boolean }>('execution-policy:set-user', {
        policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] },
        expectedRevision: 0,
      })
      expect(saved.ok).toBe(true)
      expect(changed).toHaveBeenCalledTimes(1)

      const reset = await call<{ ok: boolean }>('execution-policy:reset-user', { expectedRevision: 1 })
      expect(reset.ok).toBe(true)
      expect(changed).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('rejects stale policy revisions without broadcasting or overwriting state', async () => {
    const userData = temporaryUserData()
    try {
      handlers.clear()
      const changed = vi.fn()
      const store = new ExecutionPolicySourceStore(userData)
      registerPolicyIpc(store, undefined, changed)

      const saved = await call<{ ok: boolean }>('execution-policy:set-user', {
        policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] },
        expectedRevision: 0,
      })
      expect(saved.ok).toBe(true)

      const stale = await call<{
        ok: boolean
        error?: { code: string }
        snapshot: { global: { revision: number } }
      }>('execution-policy:set-user', {
        policy: FULL_POLICY,
        highRiskConfirmed: true,
        expectedRevision: 0,
      })
      expect(stale).toMatchObject({
        ok: false,
        error: { code: 'policy-conflict' },
        snapshot: { global: { revision: 1 } },
      })
      expect(changed).toHaveBeenCalledTimes(1)
      expect(store.getGlobalEffectivePolicy().policy).toEqual({
        schemaVersion: 1,
        mode: 'allowlist',
        system: ['fs'],
        shell: [],
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('requires the rebuild confirmation and does not touch source state', async () => {
    const userData = temporaryUserData()
    try {
      const directory = join(userData, EXECUTION_POLICY_DIRECTORY)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(join(directory, EXECUTION_POLICY_FILE), '{not-json\n', { encoding: 'utf8', mode: 0o600 })
      writeFileSync(join(directory, EXECUTION_POLICY_REVISION_FILE), '{"schemaVersion":1,"highWater":4}\n', { encoding: 'utf8', mode: 0o600 })
      handlers.clear()
      const changed = vi.fn()
      registerPolicyIpc(new ExecutionPolicySourceStore(userData), undefined, changed)

      const denied = await call<{ ok: boolean; error?: { code: string } }>(
        'execution-policy:rebuild',
        { confirmed: false },
      )
      expect(denied).toMatchObject({ ok: false, error: { code: 'recovery-confirmation-required' } })
      expect(changed).not.toHaveBeenCalled()

      const accepted = await call<{ ok: boolean; snapshot: { recovery: { state: string } } }>(
        'execution-policy:rebuild',
        { confirmed: true },
      )
      expect(accepted).toMatchObject({ ok: true, snapshot: { recovery: { state: 'healthy' } } })
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('reports an uncertain source commit without exposing storage details', async () => {
    const userData = temporaryUserData()
    try {
      handlers.clear()
      const store = new ExecutionPolicySourceStore(userData)
      vi.spyOn(store, 'selectSource').mockImplementation(() => {
        throw new ExecutionPolicySourceCommitError()
      })
      registerPolicyIpc(store, userData)

      const result = await call<{ ok: boolean; error?: { code: string; message: string } }>(
        'execution-policy:select-source',
        { workspacePath: userData, request: { source: 'default' } },
      )

      expect(result).toMatchObject({ ok: false, error: { code: 'commit-uncertain' } })
      expect(result.error?.message).not.toContain('sources.json')
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('contains inspect failures in a safe typed fallback snapshot', async () => {
    const userData = temporaryUserData()
    try {
      handlers.clear()
      const store = new ExecutionPolicySourceStore(userData)
      vi.spyOn(store, 'getSettingsSnapshot').mockImplementation(() => {
        throw new Error('simulated inspect failure')
      })
      registerPolicyIpc(store)

      const result = await call<{
        global: { state: string }
        recovery: { state: string; unsafePaths: string[] }
        sourceRecovery: { state: string }
      }>('execution-policy:inspect', userData)

      expect(result).toEqual({
        defaultPolicy: {
          schemaVersion: 1,
          mode: 'allowlist',
          system: ['fs', 'ui', 'aiCli'],
          shell: ['git', 'gh', 'glab'],
        },
        userPolicy: null,
        global: {
          policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: [] },
          revision: 0,
          state: 'corrupt',
        },
        workspace: null,
        recovery: { state: 'directory-unavailable', canRebuild: false, unsafePaths: [] },
        sourceRecovery: { state: 'unavailable', canReset: false, unsafePaths: [] },
      })
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('uses only the sender-bound workspace and rejects cross-workspace requests', async () => {
    const userData = temporaryUserData()
    const workspaceA = temporaryUserData()
    const workspaceB = temporaryUserData()
    try {
      handlers.clear()
      const store = new ExecutionPolicySourceStore(userData)
      const getSnapshot = vi.spyOn(store, 'getSettingsSnapshot')
      const selectSource = vi.spyOn(store, 'selectSource')
      registerExecutionPolicyIpc(store, () => true, {
        resolveWorkspace: (_event, requestedWorkspace) => {
          if (requestedWorkspace === undefined || requestedWorkspace === workspaceA) return workspaceA
          return undefined
        },
      })

      await call('execution-policy:inspect', workspaceB)
      expect(getSnapshot).toHaveBeenCalledWith(workspaceA)
      expect(getSnapshot.mock.calls.some(([path]) => path === workspaceB)).toBe(false)

      const deniedSelect = await call<{ ok: boolean; error?: { code: string } }>(
        'execution-policy:select-source',
        { workspacePath: workspaceB, request: { source: 'default' } },
      )
      expect(deniedSelect).toMatchObject({
        ok: false,
        error: { code: 'workspace-unavailable' },
      })
      expect(selectSource).not.toHaveBeenCalled()

      const deniedGlobalMutation = await call<{ ok: boolean; error?: { code: string } }>(
        'execution-policy:set-user',
        {
          workspacePath: workspaceB,
          policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] },
          expectedRevision: 0,
        },
      )
      expect(deniedGlobalMutation).toMatchObject({
        ok: false,
        error: { code: 'workspace-unavailable' },
      })

      const deniedGlobalReset = await call<{ ok: boolean; error?: { code: string } }>(
        'execution-policy:reset-user',
        { workspacePath: workspaceB, expectedRevision: 0 },
      )
      expect(deniedGlobalReset).toMatchObject({
        ok: false,
        error: { code: 'workspace-unavailable' },
      })
      expect(store.getGlobalEffectivePolicy().state).toBe('default')
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(workspaceA, { recursive: true, force: true })
      rmSync(workspaceB, { recursive: true, force: true })
    }
  })

  it('requires confirmation before resetting all source selections', async () => {
    const userData = temporaryUserData()
    try {
      handlers.clear()
      const changed = vi.fn()
      const store = new ExecutionPolicySourceStore(userData)
      registerPolicyIpc(store, userData, changed)

      const selected = await call<{ ok: boolean }>('execution-policy:select-source', {
        workspacePath: userData,
        request: { source: 'default' },
      })
      expect(selected.ok).toBe(true)

      const denied = await call<{ ok: boolean; error?: { code: string } }>(
        'execution-policy:reset-source-selections',
        { confirmed: false, workspacePath: userData },
      )
      expect(denied).toMatchObject({
        ok: false,
        error: { code: 'source-reset-confirmation-required' },
      })
      expect(changed).toHaveBeenCalledTimes(1)

      const reset = await call<{
        ok: boolean
        changed: boolean
        snapshot: { workspace: { selectedSource: string | null } | null }
      }>('execution-policy:reset-source-selections', {
        confirmed: true,
        workspacePath: userData,
      })
      expect(reset).toMatchObject({
        ok: true,
        changed: true,
        snapshot: { workspace: { selectedSource: null } },
      })
      expect(changed).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
