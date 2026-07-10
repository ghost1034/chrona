import { nativeImage } from 'electron'
import { fillRectBGRA, pixelRectFromNormalized } from '../../shared/blurRegions'
import type { BlurRegion } from '../../shared/blurRegions'

// Applies solid-fill redaction for the given regions to a captured frame.
// Privacy-critical: throws on ANY inconsistency so the caller drops the frame
// instead of ever saving it unredacted.
export function applyBlurRegions(
  img: Electron.NativeImage,
  regions: BlurRegion[]
): Electron.NativeImage {
  if (regions.length === 0) return img

  const { width, height } = img.getSize()
  if (width <= 0 || height <= 0) throw new Error('Cannot redact an empty image')

  const buf = img.toBitmap()
  if (!buf || buf.byteLength < width * height * 4) {
    throw new Error('Capture bitmap too small to redact safely')
  }

  for (const region of regions) {
    const rect = pixelRectFromNormalized(region.rect, width, height)
    if (rect) fillRectBGRA(buf, width, height, rect)
  }

  const out = nativeImage.createFromBitmap(buf, { width, height })
  if (out.isEmpty()) throw new Error('Redacted image is empty')
  return out
}
