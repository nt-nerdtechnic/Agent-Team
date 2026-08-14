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
  type CapabilityCall,
} from './pluginCapabilityBroker'
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
    fs: ['read'],
    ui: ['openExternal'],
    storage: ['write'],
  })

  it('allows only the public filesystem read methods', () => {
    expect(isCallAllowed(policy, 'fs', 'read_file')).toBe(true)
    expect(isCallAllowed(policy, 'fs', 'list_dir')).toBe(true)
    expect(isCallAllowed(policy, 'fs', 'glob_files')).toBe(true)
    expect(isCallAllowed(policy, 'fs', 'stat_path')).toBe(true)
    expect(isCallAllowed(policy, 'fs', 'write_file')).toBe(false)
    expect(isCallAllowed(policy, 'fs', 'list_files_flat')).toBe(false)
  })

  it('does not turn a storage grant into an unimplemented runtime surface', () => {
    expect(isCallAllowed(policy, 'storage', 'get')).toBe(false)
    expect(isCallAllowed(policy, 'storage', 'delete')).toBe(false)
  })

  it('does not expose legacy first-party events to v2 plugins', () => {
    expect(isEventAllowed(policy, 'git.changed')).toBe(false)
    expect(isEventAllowed(policy, 'ui.settings_changed')).toBe(false)
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
