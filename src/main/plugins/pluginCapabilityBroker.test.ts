import { describe, expect, it } from 'vitest'
import {
  buildError,
  buildSuccess,
  isCapabilityAllowed,
  parseCapabilityCall,
  resolveCapabilityCall,
  planCapabilityCall,
  backendResponseToCapability,
  type CapabilityCall,
} from './pluginCapabilityBroker'
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
