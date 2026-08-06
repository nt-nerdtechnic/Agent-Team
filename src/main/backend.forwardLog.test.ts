import { describe, expect, it, vi } from 'vitest'

import { forwardBackendLog } from './backend'

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
