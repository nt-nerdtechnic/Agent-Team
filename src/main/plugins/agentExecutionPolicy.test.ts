import { describe, expect, it } from 'vitest'
import {
  executionPolicyAllows,
  planPublicCapabilityCall,
  type AuthenticatedInitiator,
  type CapabilityCall,
  type HostCapabilityContext,
} from './pluginCapabilityBroker'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import type { ExecutionPolicySnapshot } from './executionPolicy'
import type { StorageSnapshotTier } from './pluginCapabilityBroker'

const binding = {
  pluginId: 'acme.policy',
  packageVersion: '1.0.0',
  workspaceId: 'workspace-1',
  instanceId: 'instance-1',
  audience: 'panel',
} as const

const agent: AuthenticatedInitiator = {
  kind: 'agent',
  source: 'mcp',
  id: 'agent-request-1',
}

const user: AuthenticatedInitiator = {
  kind: 'user',
  id: 'user-1',
}

function snapshot(policy: ExecutionPolicySnapshot['policy'], revision = 1): ExecutionPolicySnapshot {
  return { policy, revision, state: 'user' }
}

function call(overrides: Partial<CapabilityCall> = {}): CapabilityCall {
  return {
    pluginId: binding.pluginId,
    ns: 'fs',
    method: 'readFile',
    args: { path: 'README.md' },
    reqId: 'req-1',
    ...overrides,
  }
}

function context(overrides: Partial<HostCapabilityContext> = {}): HostCapabilityContext {
  return {
    publisherEligible: true,
    userGrant: { packageVersion: binding.packageVersion, system: ['fs'], shell: 'allowlist' },
    runtimeBinding: binding,
    initiator: agent,
    executionPolicy: snapshot({
      schemaVersion: 1,
      mode: 'allowlist',
      system: ['fs'],
      shell: ['git'],
    }),
    ...overrides,
  }
}

describe('agent execution policy enforcement', () => {
  it('allows an allowlisted namespace and denies another before dispatch', () => {
    expect(executionPolicyAllows(agent, context().executionPolicy, 'fs')).toBe(true)
    expect(executionPolicyAllows(agent, context().executionPolicy, 'ui')).toBe(false)
    expect(
      planPublicCapabilityCall(
        call(),
        manifestV2CapabilityPolicy({ system: ['fs'] }),
        context()
      )
    ).toMatchObject({ kind: 'allow' })
  })

  it('checks every top-level executable in an agent shell chain', () => {
    const policy = snapshot({
      schemaVersion: 1,
      mode: 'allowlist',
      system: [],
      shell: ['git', 'gh'],
    })
    expect(executionPolicyAllows(agent, policy, 'shell', 'git status && gh pr list')).toBe(true)
    expect(executionPolicyAllows(agent, policy, 'shell', 'git status |& gh pr list')).toBe(true)
    expect(executionPolicyAllows(agent, policy, 'shell', 'git status && rm -rf .')).toBe(false)
  })

  it('matches allowlist executable names case-insensitively', () => {
    const policy = snapshot({
      schemaVersion: 1,
      mode: 'allowlist',
      system: [],
      shell: ['git'],
    })
    expect(executionPolicyAllows(agent, policy, 'shell', 'GIT status')).toBe(true)
  })

  it('matches denylist executable names case-insensitively', () => {
    const policy = snapshot({
      schemaVersion: 1,
      mode: 'denylist',
      system: [],
      shell: ['git'],
    })
    expect(executionPolicyAllows(agent, policy, 'shell', 'GIT status')).toBe(false)
  })

  it('treats denylist entries as denied namespaces and executables', () => {
    const policy = snapshot({
      schemaVersion: 1,
      mode: 'denylist',
      system: ['ui'],
      shell: ['rm'],
    })
    expect(executionPolicyAllows(agent, policy, 'fs')).toBe(true)
    expect(executionPolicyAllows(agent, policy, 'ui')).toBe(false)
    expect(executionPolicyAllows(agent, policy, 'shell', 'git status')).toBe(true)
    expect(executionPolicyAllows(agent, policy, 'shell', 'git status; rm -rf .')).toBe(false)
  })

  it('does not filter direct user operations', () => {
    const failClosed = snapshot({
      schemaVersion: 1,
      mode: 'allowlist',
      system: [],
      shell: [],
    })
    expect(executionPolicyAllows(user, failClosed, 'fs')).toBe(true)
    expect(
      planPublicCapabilityCall(
        call(),
        manifestV2CapabilityPolicy({ system: ['fs'] }),
        context({ initiator: user, executionPolicy: failClosed })
      )
    ).toMatchObject({ kind: 'allow' })
  })

  it('lets full mode bypass only the agent filters', () => {
    const full = snapshot({ schemaVersion: 1, mode: 'full', system: [], shell: [] })
    expect(executionPolicyAllows(agent, full, 'ui')).toBe(true)
    expect(
      planPublicCapabilityCall(
        call({ ns: 'ui', method: 'openExternal', args: { url: 'https://example.com' } }),
        manifestV2CapabilityPolicy({ system: ['fs'] }),
        context({ executionPolicy: full })
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('retains the agent initiator on a Host-managed storage plan', () => {
    const result = planPublicCapabilityCall(
      call({ ns: 'storage', method: 'get', args: { scope: 'plugin', key: 'state' } }),
      manifestV2CapabilityPolicy({ system: [] }),
      context({
        userGrant: { packageVersion: binding.packageVersion, system: [], storage: true },
        storageSnapshots: new Map<StorageSnapshotTier, string>([['active', binding.packageVersion]]),
        storageSnapshotTier: 'active',
      })
    )

    expect(result).toMatchObject({ kind: 'allow', plan: { initiator: agent } })
  })
})
