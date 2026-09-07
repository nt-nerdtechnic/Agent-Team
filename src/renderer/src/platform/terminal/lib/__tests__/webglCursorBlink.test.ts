import { describe, it, expect, vi } from 'vitest'
import { stopWebglCursorBlink } from '../webglCursorBlink'

describe('stopWebglCursorBlink', () => {
  it('blurs the addon renderer, which is what clears the blink interval', () => {
    const handleBlur = vi.fn()
    stopWebglCursorBlink({ _renderer: { handleBlur } })
    expect(handleBlur).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the addon never got a renderer', () => {
    // activate() throwing leaves the addon without one.
    expect(() => stopWebglCursorBlink({})).not.toThrow()
  })

  it('does nothing for a null or undefined addon', () => {
    expect(() => stopWebglCursorBlink(null)).not.toThrow()
    expect(() => stopWebglCursorBlink(undefined)).not.toThrow()
  })

  it('survives a future xterm that no longer exposes handleBlur', () => {
    // The leak comes back, silently — but a dispose path must not throw.
    expect(() => stopWebglCursorBlink({ _renderer: {} })).not.toThrow()
  })

  it('swallows a throw from a renderer whose context is already lost', () => {
    const addon = {
      _renderer: {
        handleBlur(): void {
          throw new Error('context lost')
        },
      },
    }
    expect(() => stopWebglCursorBlink(addon)).not.toThrow()
  })
})
