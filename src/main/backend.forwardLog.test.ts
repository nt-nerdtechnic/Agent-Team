import { describe, expect, it, vi } from 'vitest'

import { forwardBackendLog, guardStdioStreams } from './backend'

function fakeStream(write: (text: string, cb: (err?: Error) => void) => boolean) {
  return { write } as unknown as NodeJS.WriteStream
}

describe('forwardBackendLog', () => {
  it('prefixes the line and writes it to the stream', () => {
    const write = vi.fn((_text: string, cb: (err?: Error) => void) => {
      cb()
      return true
    })

    forwardBackendLog(fakeStream(write), Buffer.from('listening on 8000\n'))

    expect(write.mock.calls[0][0]).toBe('[backend] listening on 8000\n')
  })

  it('survives an async write failure — a dead pipe must not crash the app', () => {
    // The terminal that launched a dev run went away: the write fails with
    // EIO through the callback rather than by throwing.
    const write = vi.fn((_text: string, cb: (err?: Error) => void) => {
      cb(Object.assign(new Error('write EIO'), { code: 'EIO' }))
      return false
    })

    expect(() => forwardBackendLog(fakeStream(write), Buffer.from('x'))).not.toThrow()
  })

  it('survives a stream that throws synchronously', () => {
    const write = vi.fn(() => {
      throw new Error('write after end')
    })

    expect(() => forwardBackendLog(fakeStream(write), Buffer.from('x'))).not.toThrow()
  })
})

describe('guardStdioStreams', () => {
  it("registers an 'error' listener on both stdio streams", () => {
    // The write callback does not cover a stream-level 'error' event: Node
    // turns an unlistened one into an uncaught exception. This is the path
    // that produced the EIO crash dialog.
    const before = {
      out: process.stdout.listenerCount('error'),
      err: process.stderr.listenerCount('error'),
    }

    guardStdioStreams()

    expect(process.stdout.listenerCount('error')).toBeGreaterThan(before.out - 1)
    expect(process.stderr.listenerCount('error')).toBeGreaterThan(before.err - 1)
    expect(process.stdout.listenerCount('error')).toBeGreaterThan(0)
    expect(process.stderr.listenerCount('error')).toBeGreaterThan(0)
  })

  it('emitting an error on stdout no longer throws once guarded', () => {
    guardStdioStreams()

    expect(() => process.stdout.emit('error', new Error('write EIO'))).not.toThrow()
  })

  it('is idempotent — repeated calls do not stack listeners', () => {
    guardStdioStreams()
    const after1 = process.stdout.listenerCount('error')
    guardStdioStreams()
    guardStdioStreams()

    expect(process.stdout.listenerCount('error')).toBe(after1)
  })
})
