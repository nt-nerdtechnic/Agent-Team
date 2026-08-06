import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerCommand, executeCommand, hasCommand, listCommands, invokeCommand, _resetRegistry } from '../commandRegistry'

beforeEach(() => {
  _resetRegistry()
})

describe('registerCommand / executeCommand (existing behavior)', () => {
  it('executeCommand calls the registered handler with args and returns true', () => {
    const spy = vi.fn()
    registerCommand('test.cmd', spy)
    const handled = executeCommand('test.cmd', { foo: 'bar' })
    expect(handled).toBe(true)
    expect(spy).toHaveBeenCalledWith({ foo: 'bar' })
  })

  it('executeCommand returns false for an unregistered command', () => {
    expect(executeCommand('nope.cmd')).toBe(false)
  })

  it('hasCommand reflects registration state', () => {
    expect(hasCommand('test.cmd')).toBe(false)
    registerCommand('test.cmd', () => {})
    expect(hasCommand('test.cmd')).toBe(true)
  })
})

describe('listCommands', () => {
  it('lists every registered command id', () => {
    registerCommand('a.one', () => {})
    registerCommand('a.two', () => {})
    expect(listCommands().sort()).toEqual(['a.one', 'a.two'])
  })

  it('returns an empty array when nothing is registered', () => {
    expect(listCommands()).toEqual([])
  })
})

describe('invokeCommand', () => {
  it('resolves ok:true with the handler return value (sync handler)', async () => {
    registerCommand('sync.echo', (args) => ({ echoed: args }))
    const outcome = await invokeCommand('sync.echo', { a: 1 })
    expect(outcome).toEqual({ ok: true, result: { echoed: { a: 1 } } })
  })

  it('resolves ok:true with the awaited return value (async handler)', async () => {
    registerCommand('async.echo', async (args) => {
      await Promise.resolve()
      return `got:${JSON.stringify(args)}`
    })
    const outcome = await invokeCommand('async.echo', { x: 2 })
    expect(outcome).toEqual({ ok: true, result: 'got:{"x":2}' })
  })

  it('resolves ok:false with a string error when the handler throws synchronously', async () => {
    registerCommand('sync.throw', () => {
      throw new Error('boom')
    })
    const outcome = await invokeCommand('sync.throw')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('boom')
    expect(outcome.result).toBeUndefined()
  })

  it('resolves ok:false with a string error when the handler rejects', async () => {
    registerCommand('async.reject', async () => {
      throw new Error('async boom')
    })
    const outcome = await invokeCommand('async.reject')
    expect(outcome).toEqual({ ok: false, error: 'async boom' })
  })

  it('resolves ok:false for a thrown non-Error value', async () => {
    registerCommand('sync.throwString', () => {
      throw 'just a string'
    })
    const outcome = await invokeCommand('sync.throwString')
    expect(outcome).toEqual({ ok: false, error: 'just a string' })
  })

  it('resolves ok:false for an unknown command without throwing', async () => {
    const outcome = await invokeCommand('does.not.exist')
    expect(outcome).toEqual({ ok: false, error: 'unknown command: does.not.exist' })
  })
})
