import { describe, expect, it, vi } from 'vitest'
import { lockPageZoom } from './web-contents-zoom'

function webContentsStub() {
  const listeners = new Map<string, () => void>()
  return {
    listeners,
    contents: {
      setZoomFactor: vi.fn(),
      setVisualZoomLevelLimits: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener)
      })
    }
  }
}

describe('lockPageZoom', () => {
  it('resets page zoom immediately and disables visual zoom', () => {
    const { contents } = webContentsStub()

    lockPageZoom(contents as never)

    expect(contents.setZoomFactor).toHaveBeenCalledWith(1)
    expect(contents.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1)
  })

  it('resets a retained Chromium zoom factor after each load', () => {
    const { contents, listeners } = webContentsStub()
    lockPageZoom(contents as never)
    contents.setZoomFactor.mockClear()

    listeners.get('did-finish-load')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledOnce()
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1)
  })

  it('resets page zoom and notifies the renderer when zoom is requested', () => {
    const { contents, listeners } = webContentsStub()
    const onZoomChanged = vi.fn()
    lockPageZoom(contents as never, onZoomChanged)
    contents.setZoomFactor.mockClear()

    listeners.get('zoom-changed')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledOnce()
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1)
    expect(onZoomChanged).toHaveBeenCalledOnce()
  })
})
