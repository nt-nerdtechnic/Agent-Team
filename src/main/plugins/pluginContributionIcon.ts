import { nativeImage, type NativeImage } from 'electron'

type NativeImageLoader = (path: string) => Pick<NativeImage, 'isEmpty' | 'resize'>

/** Decode package artwork in the Host and expose bounded PNG bytes only. */
export function contributionIconDataUrl(
  iconFile: string,
  load: NativeImageLoader = nativeImage.createFromPath
): string | null {
  try {
    const image = load(iconFile)
    if (image.isEmpty()) return null
    return image.resize({ width: 36, height: 36, quality: 'best' }).toDataURL()
  } catch {
    return null
  }
}
