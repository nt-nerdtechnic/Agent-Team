import { describe, expect, it, vi } from 'vitest'
import { contributionIconDataUrl } from './pluginContributionIcon'

describe('contributionIconDataUrl', () => {
  it('decodes and bounds a Host-verified icon before exposing image bytes', () => {
    const resized = { toDataURL: vi.fn(() => 'data:image/png;base64,AAAA') }
    const image = {
      isEmpty: vi.fn(() => false),
      resize: vi.fn(() => resized),
    }
    const load = vi.fn(() => image)

    expect(contributionIconDataUrl('/plugins/acme/icon.png', load as never)).toBe(
      'data:image/png;base64,AAAA'
    )
    expect(load).toHaveBeenCalledWith('/plugins/acme/icon.png')
    expect(image.resize).toHaveBeenCalledWith({ width: 36, height: 36, quality: 'best' })
  })

  it('fails closed for empty or unreadable image files', () => {
    const empty = {
      isEmpty: () => true,
      resize: vi.fn(),
    }
    expect(contributionIconDataUrl('/plugins/acme/empty.png', (() => empty) as never)).toBeNull()
    expect(contributionIconDataUrl('/plugins/acme/broken.png', (() => {
      throw new Error('decode failed')
    }) as never)).toBeNull()
  })
})
