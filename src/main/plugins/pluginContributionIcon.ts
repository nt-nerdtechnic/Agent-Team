import { nativeImage, type NativeImage } from 'electron'

type NativeImageLoader = (path: string) => Pick<NativeImage, 'isEmpty' | 'resize' | 'toBitmap'>

export interface ContributionIcon {
  /** Bounded PNG bytes, safe to hand to the renderer as an image source. */
  url: string
  /** Every fully opaque pixel is the same colour, so the artwork is a
   *  silhouette and its shade carries no meaning. The renderer paints those in
   *  the current text colour instead; without it a plugin shipping artwork
   *  drawn for a dark theme is nearly invisible on a light one, since a raster
   *  icon cannot follow `currentColor` the way the built-in SVG icons do. */
  monochrome: boolean
}

/** Below this, a stray opaque pixel in otherwise translucent artwork would be
 *  enough to call a full-colour icon a silhouette. */
const MIN_OPAQUE_PIXELS = 8

/** Bitmap data is BGRA. Only fully opaque pixels are compared: a partially
 *  transparent one may carry premultiplied colour, which reads as a different
 *  shade of the very ink we are trying to match. */
function isSingleColour(bitmap: Buffer): boolean {
  let first = -1
  let opaque = 0
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    if (bitmap[i + 3] !== 255) continue
    const colour = (bitmap[i] << 16) | (bitmap[i + 1] << 8) | bitmap[i + 2]
    if (first < 0) first = colour
    else if (colour !== first) return false
    opaque += 1
  }
  return opaque >= MIN_OPAQUE_PIXELS
}

/** Decode package artwork in the Host and expose bounded PNG bytes only. */
export function contributionIcon(
  iconFile: string,
  load: NativeImageLoader = nativeImage.createFromPath
): ContributionIcon | null {
  try {
    const image = load(iconFile)
    if (image.isEmpty()) return null
    return {
      url: image.resize({ width: 36, height: 36, quality: 'best' }).toDataURL(),
      // Measured before the resize: interpolation turns a hard-edged
      // silhouette into a fringe of half-transparent pixels, and the few
      // fully opaque ones left over are a thin basis for the decision.
      monochrome: isSingleColour(image.toBitmap()),
    }
  } catch {
    return null
  }
}
