import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildError,
  buildSuccess,
  isCapabilityAllowed,
  parseCapabilityCall,
  resolveCapabilityCall,
  planCapabilityCall,
  backendResponseToCapability,
  createTerminalOutputBatcher,
  terminalSessionIdOf,
  terminalSessionsFromResponse,
  isCallAllowed,
  isEventAllowed,
  planPublicCapabilityCall,
  isPublicCapabilityEventAllowed,
  HOST_EVENT_SOURCE_PLUGIN_ID,
  shellTopLevelExecutables,
  type HostCapabilityContext,
  type CapabilityCall,
} from './pluginCapabilityBroker'
import { HOST_SHELL_EXECUTABLE_ALLOWLIST } from './pluginCapabilityCatalog'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import type { WsResponse } from '../../shared/wsClient'

describe('isCapabilityAllowed', () => {
  it('always allows the built-in ping namespace regardless of requires', () => {
    expect(isCapabilityAllowed([], 'ping')).toBe(true)
  })

  it('allows a namespace explicitly declared in requires', () => {
    expect(isCapabilityAllowed(['fs'], 'fs')).toBe(true)
  })

  it('denies a namespace that is neither built-in nor declared', () => {
    expect(isCapabilityAllowed([], 'fs')).toBe(false)
    expect(isCapabilityAllowed(['git'], 'fs')).toBe(false)
  })
})

describe('buildSuccess / buildError', () => {
  it('builds a success envelope carrying the reqId and result', () => {
    expect(buildSuccess('r1', { pong: true })).toEqual({
      reqId: 'r1',
      ok: true,
      result: { pong: true },
    })
  })

  it('builds an error envelope with just a code when no message given', () => {
    expect(buildError('r2', 'UNKNOWN')).toEqual({
      reqId: 'r2',
      ok: false,
      error: { code: 'UNKNOWN' },
    })
  })

  it('includes the message when provided', () => {
    expect(buildError('r3', 'CAP_DENIED', 'nope')).toEqual({
      reqId: 'r3',
      ok: false,
      error: { code: 'CAP_DENIED', message: 'nope' },
    })
  })
})

describe('parseCapabilityCall', () => {
  it('accepts a well-formed payload and stamps the authoritative pluginId', () => {
    const raw = { ns: 'ping', method: 'ping', args: { hello: 1 }, reqId: 'abc', pluginId: 'spoofed' }
    expect(parseCapabilityCall(raw, 'navide.noop')).toEqual({
      pluginId: 'navide.noop',
      ns: 'ping',
      method: 'ping',
      args: { hello: 1 },
      reqId: 'abc',
    })
  })

  it('rejects non-object payloads', () => {
    expect(parseCapabilityCall(null, 'p')).toBeNull()
    expect(parseCapabilityCall('x', 'p')).toBeNull()
  })

  it('rejects payloads missing required string fields', () => {
    expect(parseCapabilityCall({ method: 'm', reqId: 'r' }, 'p')).toBeNull()
    expect(parseCapabilityCall({ ns: 'ping', reqId: 'r' }, 'p')).toBeNull()
    expect(parseCapabilityCall({ ns: 'ping', method: 'm' }, 'p')).toBeNull()
    expect(parseCapabilityCall({ ns: '', method: 'm', reqId: 'r' }, 'p')).toBeNull()
  })
})

describe('resolveCapabilityCall', () => {
  const call = (over: Partial<CapabilityCall> = {}): CapabilityCall => ({
    pluginId: 'navide.noop',
    ns: 'ping',
    method: 'ping',
    args: { hello: 1 },
    reqId: 'r1',
    ...over,
  })

  it('echoes args back for a ping call', () => {
    expect(resolveCapabilityCall(call(), [])).toEqual({
      reqId: 'r1',
      ok: true,
      result: { pong: true, echo: { hello: 1 } },
    })
  })

  it('denies a namespace the plugin did not declare', () => {
    const res = resolveCapabilityCall(call({ ns: 'fs' }), [])
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('CAP_DENIED')
  })

  it('returns UNKNOWN for a declared-but-unimplemented namespace', () => {
    const res = resolveCapabilityCall(call({ ns: 'fs', method: 'read' }), ['fs'])
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('UNKNOWN')
  })
})

describe('planCapabilityCall', () => {
  const call = (over: Partial<CapabilityCall> = {}): CapabilityCall => ({
    pluginId: 'navide.fs_probe',
    ns: 'fs',
    method: 'read_file',
    args: { rel_path: 'a.txt' },
    reqId: 'r1',
    ...over,
  })

  it('DENIES an un-granted namespace before it can reach the backend', () => {
    const plan = planCapabilityCall(call({ ns: 'git', method: 'status' }), ['fs'])
    expect(plan.kind).toBe('respond')
    if (plan.kind === 'respond') expect(plan.response.error?.code).toBe('CAP_DENIED')
  })

  it('resolves the built-in ping in-process (never routed to the backend)', () => {
    const plan = planCapabilityCall(call({ ns: 'ping', method: 'ping', args: { a: 1 } }), [])
    expect(plan.kind).toBe('respond')
    if (plan.kind === 'respond') {
      expect(plan.response.ok).toBe(true)
      expect(plan.response.result).toEqual({ pong: true, echo: { a: 1 } })
    }
  })

  it('routes a granted, mapped call to the backend WS type', () => {
    const plan = planCapabilityCall(call(), ['fs'])
    expect(plan).toEqual({ kind: 'backend', wsType: 'fs.read_file' })
  })

  it('returns UNKNOWN for a granted namespace with no mapped method', () => {
    const plan = planCapabilityCall(call({ method: 'chmod' }), ['fs'])
    expect(plan.kind).toBe('respond')
    if (plan.kind === 'respond') expect(plan.response.error?.code).toBe('UNKNOWN')
  })

  it('routes a granted issues call to its backend WS type', () => {
    const plan = planCapabilityCall(call({ ns: 'issues', method: 'list' }), ['issues'])
    expect(plan).toEqual({ kind: 'backend', wsType: 'issues.list' })
  })

  it('DENIES an issues call when the plugin did not declare issues', () => {
    const plan = planCapabilityCall(call({ ns: 'issues', method: 'list' }), ['fs', 'git'])
    expect(plan.kind).toBe('respond')
    if (plan.kind === 'respond') expect(plan.response.error?.code).toBe('CAP_DENIED')
  })

  it('routes ui.open_in_editor to the host (never to the backend WS)', () => {
    const plan = planCapabilityCall(call({ ns: 'ui', method: 'open_in_editor' }), ['ui'])
    expect(plan).toEqual({ kind: 'host', action: 'open_in_editor' })
  })

  it('routes the shell-level ui host capabilities to their host actions', () => {
    expect(planCapabilityCall(call({ ns: 'ui', method: 'open_external' }), ['ui'])).toEqual({
      kind: 'host',
      action: 'open_external',
    })
    expect(planCapabilityCall(call({ ns: 'ui', method: 'reveal_path' }), ['ui'])).toEqual({
      kind: 'host',
      action: 'reveal_path',
    })
    expect(planCapabilityCall(call({ ns: 'ui', method: 'open_workspace' }), ['ui'])).toEqual({
      kind: 'host',
      action: 'open_workspace',
    })
    expect(planCapabilityCall(call({ ns: 'ui', method: 'pick_folder' }), ['ui'])).toEqual({
      kind: 'host',
      action: 'pick_folder',
    })
  })

  it('DENIES ui.open_in_editor when the plugin did not declare ui', () => {
    const plan = planCapabilityCall(call({ ns: 'ui', method: 'open_in_editor' }), ['fs', 'git'])
    expect(plan.kind).toBe('respond')
    if (plan.kind === 'respond') expect(plan.response.error?.code).toBe('CAP_DENIED')
  })
})

describe('Manifest v2 access-aware policy', () => {
  const policy = manifestV2CapabilityPolicy({
    system: ['fs', 'ui'],
  })

  it('projects only declared first-level namespaces', () => {
    expect(isCallAllowed(policy, 'ping', 'ping')).toBe(true)
    expect(isCallAllowed(policy, 'fs', 'read_file')).toBe(true)
    expect(isCallAllowed(policy, 'ui', 'open_external')).toBe(true)
    expect(isCallAllowed(policy, 'aiCli', 'startSession')).toBe(false)
  })

  it('does not turn a deferred storage declaration into a runtime surface', () => {
    expect(isCallAllowed(policy, 'storage', 'get')).toBe(false)
    expect(isCallAllowed(policy, 'storage', 'delete')).toBe(false)
  })

  it('does not route v2 events without authenticated Host context', () => {
    expect(isEventAllowed(policy, 'git.changed')).toBe(false)
    expect(isEventAllowed(policy, 'ui.settings_changed')).toBe(false)
    expect(isEventAllowed(policy, 'workspace.filesChanged')).toBe(false)
  })
})

describe('Issue 03/04 public Host planner', () => {
  const policy = manifestV2CapabilityPolicy({ system: ['aiCli'], shell: 'allowlist' })
  const binding = {
    pluginId: 'acme.ai-cli',
    packageVersion: '1.0.0',
    workspaceId: 'workspace-1',
    instanceId: 'instance-1',
    audience: 'audience-1',
  } as const
  const context = (overrides: Partial<HostCapabilityContext> = {}): HostCapabilityContext => ({
    publisherEligible: true,
    userGrant: { packageVersion: '1.0.0', system: ['aiCli'], shell: 'allowlist' },
    runtimeBinding: binding,
    aiCliProfiles: ['codex'],
    sessionBindings: new Map(),
    ...overrides,
  })
  const call = (overrides: Partial<CapabilityCall> = {}): CapabilityCall => ({
    pluginId: 'acme.ai-cli',
    ns: 'aiCli',
    method: 'startSession',
    args: { profileId: 'codex', cols: 100, rows: 30 },
    reqId: 'req-1',
    ...overrides,
  })

  it('returns a Host-owned plan only after grant, eligibility, binding, and schema checks', () => {
    expect(planPublicCapabilityCall(call(), policy, context())).toMatchObject({
      kind: 'allow',
      plan: { kind: 'public', address: 'aiCli.startSession', scope: 'workspace', runtime: binding },
    })
  })

  it('fails closed without a workspace or package-version grant', () => {
    expect(planPublicCapabilityCall(call(), policy, context({ runtimeBinding: { ...binding, workspaceId: null } }))).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'WORKSPACE_SCOPE_VIOLATION' } },
    })
    expect(planPublicCapabilityCall(call(), policy, context({ userGrant: null }))).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'CAPABILITY_DENIED' } },
    })
  })

  it('does not treat first-party eligibility as an automatic grant', () => {
    expect(planPublicCapabilityCall(call(), policy, context({ publisherEligible: false }))).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'CAPABILITY_DENIED' } },
    })
  })

  it('requires a Host-allowlisted AI CLI profile', () => {
    expect(
      planPublicCapabilityCall(
        call({ args: { profileId: 'unregistered', cols: 100, rows: 30 } }),
        policy,
        context()
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('denies shell.run when the shell declaration is omitted', () => {
    const noShellPolicy = manifestV2CapabilityPolicy({ system: ['fs'] })
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command: 'git status' } }),
        noShellPolicy,
        context({ userGrant: { packageVersion: '1.0.0', system: ['fs'] } })
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('records Git as the only Host-maintained shell executable', () => {
    expect(HOST_SHELL_EXECUTABLE_ALLOWLIST).toEqual(['git'])
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command: 'git status' } }),
        policy,
        context()
      )
    ).toMatchObject({ kind: 'allow', plan: { address: 'shell.run', shellMode: 'allowlist' } })
  })

  it('gives an official Git package no identity-based shell bypass', () => {
    const officialBinding = { ...binding, pluginId: 'navide.git' }
    const officialCall = call({
      pluginId: 'navide.git',
      ns: 'shell',
      method: 'run',
      args: { command: 'git status' },
    })
    expect(
      planPublicCapabilityCall(
        officialCall,
        manifestV2CapabilityPolicy({}),
        context({ runtimeBinding: officialBinding })
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
    expect(
      planPublicCapabilityCall(
        officialCall,
        policy,
        context({ runtimeBinding: officialBinding, userGrant: null })
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it.each([
    ['unknown executable', 'curl https://example.com'],
    ['wrapper', 'env git status'],
    ['absolute path substitution', '/usr/bin/git status'],
    ['relative path substitution', './git status'],
    ['command substitution', 'git $(echo status)'],
    ['redirection', 'git status > output.txt'],
    ['alias', 'g status'],
    ['unallowlisted pipeline segment', 'git status | cat'],
    ['unallowlisted command-chain segment', 'git status && echo done'],
  ])('fails closed for %s', (_case, command) => {
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command } }),
        policy,
        context()
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('rejects Plugin-supplied identity and raw execution fields', () => {
    const result = planPublicCapabilityCall(
      call({ args: { profileId: 'codex', cols: 100, rows: 30, workspaceId: 'spoofed', executable: '/bin/sh' } }),
      policy,
      context()
    )
    expect(result).toMatchObject({ kind: 'deny', response: { error: { code: 'INVALID_ARGUMENT' } } })
  })

  it('checks every top-level executable in a shell pipeline or chain', () => {
    expect(shellTopLevelExecutables('git status && echo ok | git diff')).toEqual(['git', 'echo', 'git'])
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command: 'git status && rm -rf .' } }),
        policy,
        context()
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('rejects shell expansion and redirection before allowlist evaluation', () => {
    expect(shellTopLevelExecutables('git $(echo unsafe)')).toBeNull()
    expect(shellTopLevelExecutables('git > output.txt')).toBeNull()
    expect(shellTopLevelExecutables('./git status')).toBeNull()
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command: 'git $(/bin/sh -c unsafe)' } }),
        policy,
        context()
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('requires a separate high-risk confirmation for full shell mode', () => {
    const fullPolicy = manifestV2CapabilityPolicy({ shell: 'full' })
    const fullContext = context({
      publisherEligible: false,
      userGrant: { packageVersion: '1.0.0', system: [], shell: 'full' },
    })
    const denied = planPublicCapabilityCall(
      call({ ns: 'shell', method: 'run', args: { command: 'arbitrary --command' } }),
      fullPolicy,
      fullContext
    )
    expect(denied).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command: 'arbitrary --command' } }),
        fullPolicy,
        context({
          publisherEligible: false,
          userGrant: { packageVersion: '1.0.0', system: [], shell: 'full', highRiskShellConfirmed: true },
        })
      )
    ).toMatchObject({ kind: 'allow', plan: { address: 'shell.run', shellMode: 'full' } })
  })

  it('routes AI CLI events only to the authenticated session audience', () => {
    const session = { ...binding, instanceId: 'instance-1', audience: 'audience-1' }
    const allowed = context({ sessionBindings: new Map([['session-1', session]]) })
    expect(
      isPublicCapabilityEventAllowed(
        policy,
        'aiCli.output',
        { sessionId: 'session-1', data: 'ok' },
        allowed,
        'acme.ai-cli',
        session
      )
    ).toBe(true)
    expect(
      isPublicCapabilityEventAllowed(
        policy,
        'aiCli.output',
        { sessionId: 'session-1', data: 'ok', exitCode: 0 },
        allowed,
        'acme.ai-cli'
      )
    ).toBe(false)
    expect(
      isPublicCapabilityEventAllowed(
        policy,
        'aiCli.output',
        { sessionId: 'session-1', data: 'ok' },
        context({ runtimeBinding: { ...binding, audience: 'other-audience' }, sessionBindings: new Map([['session-1', session]]) }),
        'acme.ai-cli'
      )
    ).toBe(false)
  })

  it('requires the package-version grant before routing public events', () => {
    expect(
      isPublicCapabilityEventAllowed(
        policy,
        'aiCli.output',
        { sessionId: 'session-1', data: 'ok' },
        context({
          userGrant: null,
          sessionBindings: new Map([['session-1', binding]]),
        }),
        'acme.ai-cli'
      )
    ).toBe(false)
  })

  it('requires a Host-bound workspace source for workspace events', () => {
    const filesPolicy = manifestV2CapabilityPolicy({ system: ['fs'] })
    const filesContext = context({
      userGrant: { packageVersion: '1.0.0', system: ['fs'] },
    })
    const payload = { changes: [{ path: 'README.md', kind: 'changed' }] }
    expect(
      isPublicCapabilityEventAllowed(
        filesPolicy,
        'workspace.filesChanged',
        payload,
        filesContext,
        'acme.ai-cli'
      )
    ).toBe(false)
    expect(
      isPublicCapabilityEventAllowed(
        filesPolicy,
        'workspace.filesChanged',
        payload,
        filesContext,
        'acme.ai-cli',
        { ...binding, pluginId: HOST_EVENT_SOURCE_PLUGIN_ID, instanceId: null, audience: null }
      )
    ).toBe(true)
    expect(
      isPublicCapabilityEventAllowed(
        filesPolicy,
        'workspace.filesChanged',
        payload,
        filesContext,
        'acme.ai-cli',
        {
          ...binding,
          pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
          workspaceId: 'other-workspace',
          instanceId: null,
          audience: null,
        }
      )
    ).toBe(false)
    expect(
      isPublicCapabilityEventAllowed(
        filesPolicy,
        'workspace.filesChanged',
        payload,
        filesContext,
        'acme.ai-cli',
        { ...binding, pluginId: 'acme.other', instanceId: null, audience: null }
      )
    ).toBe(false)
    expect(
      isPublicCapabilityEventAllowed(
        filesPolicy,
        'workspace.filesChanged',
        payload,
        filesContext,
        'acme.ai-cli',
        { ...binding, pluginId: HOST_EVENT_SOURCE_PLUGIN_ID, instanceId: 'view-1', audience: null }
      )
    ).toBe(false)
    expect(
      isPublicCapabilityEventAllowed(
        filesPolicy,
        'workspace.filesChanged',
        payload,
        filesContext,
        'acme.other',
        { ...binding, pluginId: HOST_EVENT_SOURCE_PLUGIN_ID, instanceId: null, audience: null }
      )
    ).toBe(false)
  })

  it('requires the exact instance binding for AI CLI events, not the package context binding', () => {
    const session = { ...binding, instanceId: 'instance-1', audience: 'audience-1' }
    const allowed = context({ sessionBindings: new Map([['session-1', session]]) })
    expect(
      isPublicCapabilityEventAllowed(
        policy,
        'aiCli.output',
        { sessionId: 'session-1', data: 'ok' },
        allowed,
        'acme.ai-cli',
        { ...binding, instanceId: null, audience: null }
      )
    ).toBe(false)
  })
})

describe('backendResponseToCapability', () => {
  const resp = (over: Partial<WsResponse> = {}): WsResponse => ({
    id: 'x',
    type: 'fs.read_file.result',
    ok: true,
    payload: { content: 'hi' },
    error: null,
    timestamp: '',
    ...over,
  })

  it('wraps a successful backend response as a capability success', () => {
    expect(backendResponseToCapability('r1', resp())).toEqual({
      reqId: 'r1',
      ok: true,
      result: { content: 'hi' },
    })
  })

  it('maps a backend error to BACKEND_ERROR carrying the message', () => {
    const cap = backendResponseToCapability('r1', resp({
      ok: false,
      payload: null,
      error: { code: 'ENOENT', message: 'no such file' },
    }))
    expect(cap.ok).toBe(false)
    expect(cap.error).toEqual({ code: 'BACKEND_ERROR', message: 'no such file' })
  })
})

describe('terminalSessionsFromResponse', () => {
  it('yields the new session id from a terminal.create response', () => {
    expect(
      terminalSessionsFromResponse('terminal.create', { terminal_session_id: 't-1', pid: 42 })
    ).toEqual(['t-1'])
  })

  it('yields every alive id from a terminal.reattach response', () => {
    expect(
      terminalSessionsFromResponse('terminal.reattach', { alive: ['t-1', 't-2'], dead: ['t-3'] })
    ).toEqual(['t-1', 't-2'])
  })

  it('yields nothing for other WS types or malformed payloads', () => {
    expect(terminalSessionsFromResponse('terminal.input', { terminal_session_id: 't-1' })).toEqual([])
    expect(terminalSessionsFromResponse('terminal.create', null)).toEqual([])
    expect(terminalSessionsFromResponse('terminal.create', { terminal_session_id: 7 })).toEqual([])
    expect(terminalSessionsFromResponse('terminal.reattach', { alive: 'nope' })).toEqual([])
    expect(terminalSessionsFromResponse('terminal.reattach', { alive: ['ok', 7, ''] })).toEqual(['ok'])
  })
})

describe('terminalSessionIdOf', () => {
  it('extracts the terminal_session_id, tolerating junk', () => {
    expect(terminalSessionIdOf({ terminal_session_id: 't-1', data: 'x' })).toBe('t-1')
    expect(terminalSessionIdOf({ terminal_session_id: 5 })).toBe('')
    expect(terminalSessionIdOf(null)).toBe('')
    expect(terminalSessionIdOf('t-1')).toBe('')
  })
})

describe('createTerminalOutputBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function payload(id: string, data: string, sequence: number): Record<string, unknown> {
    return { terminal_session_id: id, pane_id: 'p', sequence, data, stream: 'stdout' }
  }

  it('coalesces a burst into ONE delivery, concatenating data in order', () => {
    const delivered: Array<{ id: string; payload: Record<string, unknown> }> = []
    const batcher = createTerminalOutputBatcher((id, p) => delivered.push({ id, payload: p }), 12)
    batcher.push('t-1', payload('t-1', 'he', 1))
    batcher.push('t-1', payload('t-1', 'll', 2))
    batcher.push('t-1', payload('t-1', 'o', 3))
    expect(delivered).toEqual([])
    vi.advanceTimersByTime(12)
    expect(delivered).toHaveLength(1)
    // data is the concatenation; the other fields (incl. sequence) come from
    // the LAST queued payload — the batch covers exactly the events up to it.
    expect(delivered[0]).toEqual({
      id: 't-1',
      payload: { terminal_session_id: 't-1', pane_id: 'p', sequence: 3, data: 'hello', stream: 'stdout' },
    })
  })

  it('keeps sessions independent (per-session batches and timers)', () => {
    const delivered: string[] = []
    const batcher = createTerminalOutputBatcher((id, p) => delivered.push(`${id}:${p.data}`), 12)
    batcher.push('t-1', payload('t-1', 'a', 1))
    vi.advanceTimersByTime(6)
    batcher.push('t-2', payload('t-2', 'b', 1))
    vi.advanceTimersByTime(6)
    expect(delivered).toEqual(['t-1:a'])
    vi.advanceTimersByTime(6)
    expect(delivered).toEqual(['t-1:a', 't-2:b'])
  })

  it('flushSession delivers pending output immediately (ordering barrier before exit)', () => {
    const delivered: string[] = []
    const batcher = createTerminalOutputBatcher((id, p) => delivered.push(String(p.data)), 12)
    batcher.push('t-1', payload('t-1', 'bye', 9))
    batcher.flushSession('t-1')
    expect(delivered).toEqual(['bye'])
    // The timer was cleared — no double delivery.
    vi.advanceTimersByTime(20)
    expect(delivered).toEqual(['bye'])
  })

  it('a new push after a flush starts a fresh batch', () => {
    const delivered: string[] = []
    const batcher = createTerminalOutputBatcher((id, p) => delivered.push(String(p.data)), 12)
    batcher.push('t-1', payload('t-1', 'one', 1))
    vi.advanceTimersByTime(12)
    batcher.push('t-1', payload('t-1', 'two', 2))
    vi.advanceTimersByTime(12)
    expect(delivered).toEqual(['one', 'two'])
  })

  it('dropSession discards pending output without delivering', () => {
    const delivered: string[] = []
    const batcher = createTerminalOutputBatcher((id, p) => delivered.push(String(p.data)), 12)
    batcher.push('t-1', payload('t-1', 'gone', 1))
    batcher.dropSession('t-1')
    vi.advanceTimersByTime(20)
    expect(delivered).toEqual([])
  })

  it('flushAll drains every pending session', () => {
    const delivered: string[] = []
    const batcher = createTerminalOutputBatcher((id) => delivered.push(id), 12)
    batcher.push('t-1', payload('t-1', 'a', 1))
    batcher.push('t-2', payload('t-2', 'b', 1))
    batcher.flushAll()
    expect(delivered.sort()).toEqual(['t-1', 't-2'])
  })
})
