import { describe, expect, it, vi } from 'vitest'
import { contributionIcon } from './pluginContributionIcon'

/** Bitmap bytes are BGRA. Each entry is [b, g, r, a]. */
function bitmap(pixels: Array<[number, number, number, number]>): Buffer {
  return Buffer.from(pixels.flat())
}

function opaqueRun(count: number, colour: [number, number, number]): Array<[number, number, number, number]> {
  return Array.from({ length: count }, () => [colour[0], colour[1], colour[2], 255] as [number, number, number, number])
}

function loaderFor(bytes: Buffer, url = 'data:image/png;base64,AAAA') {
  const resized = { toDataURL: vi.fn(() => url) }
  const image = {
    isEmpty: vi.fn(() => false),
    resize: vi.fn(() => resized),
    toBitmap: vi.fn(() => bytes),
  }
  return { load: vi.fn(() => image), image }
}

describe('contributionIcon', () => {
  it('decodes and bounds a Host-verified icon before exposing image bytes', () => {
    const { load, image } = loaderFor(bitmap(opaqueRun(16, [217, 209, 201])))

    expect(contributionIcon('/plugins/acme/icon.png', load as never)?.url).toBe(
      'data:image/png;base64,AAAA'
    )
    expect(load).toHaveBeenCalledWith('/plugins/acme/icon.png')
    expect(image.resize).toHaveBeenCalledWith({ width: 36, height: 36, quality: 'best' })
  })

  it('calls artwork monochrome when every opaque pixel is the same colour', () => {
    // The shipped navide.git icon: one flat shade (#c9d1d9) plus transparency.
    const { load } = loaderFor(
      bitmap([...opaqueRun(12, [217, 209, 201]), [0, 0, 0, 0], [0, 0, 0, 0]])
    )
    expect(contributionIcon('/plugins/acme/git.png', load as never)?.monochrome).toBe(true)
  })

  it('leaves multi-colour artwork alone', () => {
    const { load } = loaderFor(
      bitmap([...opaqueRun(12, [217, 209, 201]), ...opaqueRun(4, [10, 200, 30])])
    )
    expect(contributionIcon('/plugins/acme/logo.png', load as never)?.monochrome).toBe(false)
  })

  it('ignores partially transparent pixels, whose colour may be premultiplied', () => {
    // A resized silhouette fringes into half-transparent pixels; comparing them
    // would read the same ink as a different shade.
    const { load } = loaderFor(
      bitmap([...opaqueRun(12, [217, 209, 201]), [108, 104, 100, 128]])
    )
    expect(contributionIcon('/plugins/acme/git.png', load as never)?.monochrome).toBe(true)
  })

  it('does not call near-empty artwork monochrome on a handful of pixels', () => {
    const { load } = loaderFor(
      bitmap([...opaqueRun(4, [217, 209, 201]), [0, 0, 0, 0]])
    )
    expect(contributionIcon('/plugins/acme/sparse.png', load as never)?.monochrome).toBe(false)
  })

  it('fails closed for empty or unreadable image files', () => {
    const empty = {
      isEmpty: () => true,
      resize: vi.fn(),
      toBitmap: vi.fn(),
    }
    expect(contributionIcon('/plugins/acme/empty.png', (() => empty) as never)).toBeNull()
    expect(contributionIcon('/plugins/acme/broken.png', (() => {
      throw new Error('decode failed')
    }) as never)).toBeNull()
  })
})
