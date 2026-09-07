import { describe, expect, it, vi } from 'vitest'
import { broadcastQuitStage, QUIT_PROGRESS_CHANNEL, type QuitProgressWindow } from './quit-progress'

function fakeWindow(destroyed = false, send = vi.fn()): QuitProgressWindow {
  return { isDestroyed: () => destroyed, webContents: { send } }
}

describe('broadcastQuitStage', () => {
  it('announces the stage to every open window', () => {
    const a = vi.fn()
    const b = vi.fn()
    broadcastQuitStage('stopping', () => [fakeWindow(false, a), fakeWindow(false, b)])

    expect(a).toHaveBeenCalledWith(QUIT_PROGRESS_CHANNEL, 'stopping')
    expect(b).toHaveBeenCalledWith(QUIT_PROGRESS_CHANNEL, 'stopping')
  })

  it('skips a window that is already destroyed', () => {
    const gone = vi.fn()
    const live = vi.fn()
    broadcastQuitStage('saving', () => [fakeWindow(true, gone), fakeWindow(false, live)])

    expect(gone).not.toHaveBeenCalled()
    expect(live).toHaveBeenCalledWith(QUIT_PROGRESS_CHANNEL, 'saving')
  })

  it('keeps going when one window throws on the way out', () => {
    // Windows are torn down while this runs; nothing about a progress message
    // may stand between the user and the app exiting.
    const throwing = vi.fn(() => {
      throw new Error('window destroyed')
    })
    const live = vi.fn()
    expect(() =>
      broadcastQuitStage('closing', () => [fakeWindow(false, throwing), fakeWindow(false, live)])
    ).not.toThrow()
    expect(live).toHaveBeenCalledWith(QUIT_PROGRESS_CHANNEL, 'closing')
  })

  it('survives the window list itself being unavailable', () => {
    expect(() =>
      broadcastQuitStage('closing', () => {
        throw new Error('app is gone')
      })
    ).not.toThrow()
  })
})
