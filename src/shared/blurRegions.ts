export type NormalizedRect = {
  x: number
  y: number
  w: number
  h: number
}

export type BlurRegion = {
  id: string
  displayId: string
  // Fractions (0-1) of the display bounds, so regions survive resolution changes.
  rect: NormalizedRect
  label?: string
  createdAtMs: number
}

// Half-open pixel rect: x in [x0, x1), y in [y0, y1).
export type PixelRect = {
  x0: number
  y0: number
  x1: number
  y1: number
}

export const DEFAULT_BLUR_HOTKEY = 'CommandOrControl+Shift+B'

export const BLUR_FILL_BGRA = { b: 26, g: 26, r: 26 } as const

// Drags smaller than this (in overlay DIP px) are treated as accidental clicks.
const MIN_DRAG_PX = 4

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function isValidNormalizedRect(rect: unknown): rect is NormalizedRect {
  if (!rect || typeof rect !== 'object') return false
  const r = rect as Record<string, unknown>
  if (!isFiniteNumber(r.x) || !isFiniteNumber(r.y) || !isFiniteNumber(r.w) || !isFiniteNumber(r.h)) {
    return false
  }
  if (r.w <= 0 || r.h <= 0) return false
  if (r.x < 0 || r.y < 0 || r.x + r.w > 1 || r.y + r.h > 1) return false
  return true
}

// Converts a drag gesture (any direction) in overlay-window coordinates into a
// normalized rect. Returns null for degenerate drags.
export function normalizedRectFromDrag(
  start: { x: number; y: number },
  end: { x: number; y: number },
  windowSize: { width: number; height: number }
): NormalizedRect | null {
  const { width, height } = windowSize
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return null
  if (
    !isFiniteNumber(start.x) ||
    !isFiniteNumber(start.y) ||
    !isFiniteNumber(end.x) ||
    !isFiniteNumber(end.y)
  ) {
    return null
  }

  const clampX = (v: number) => Math.min(Math.max(v, 0), width)
  const clampY = (v: number) => Math.min(Math.max(v, 0), height)

  const left = clampX(Math.min(start.x, end.x))
  const right = clampX(Math.max(start.x, end.x))
  const top = clampY(Math.min(start.y, end.y))
  const bottom = clampY(Math.max(start.y, end.y))

  if (right - left < MIN_DRAG_PX || bottom - top < MIN_DRAG_PX) return null

  return {
    x: left / width,
    y: top / height,
    w: (right - left) / width,
    h: (bottom - top) / height
  }
}

// Maps a normalized rect onto an image of the given pixel size, rounding
// OUTWARD (floor mins, ceil maxes) so rounding never exposes a sensitive pixel.
// Returns null if the rect is invalid or empty after clamping.
export function pixelRectFromNormalized(
  rect: NormalizedRect,
  imgW: number,
  imgH: number
): PixelRect | null {
  if (!isValidNormalizedRect(rect)) return null
  if (!isFiniteNumber(imgW) || !isFiniteNumber(imgH) || imgW <= 0 || imgH <= 0) return null

  const x0 = Math.max(0, Math.floor(rect.x * imgW))
  const y0 = Math.max(0, Math.floor(rect.y * imgH))
  const x1 = Math.min(imgW, Math.ceil((rect.x + rect.w) * imgW))
  const y1 = Math.min(imgH, Math.ceil((rect.y + rect.h) * imgH))

  if (x1 <= x0 || y1 <= y0) return null
  return { x0, y0, x1, y1 }
}

// Fills a rect in a tightly-packed BGRA buffer with an opaque solid color.
// Mutates in place. Throws if the buffer is too small for the stated size.
export function fillRectBGRA(
  buf: Buffer | Uint8Array,
  imgW: number,
  imgH: number,
  rect: PixelRect,
  color: { b: number; g: number; r: number } = BLUR_FILL_BGRA
): void {
  if (buf.byteLength < imgW * imgH * 4) {
    throw new Error(
      `BGRA buffer too small: ${buf.byteLength} bytes for ${imgW}x${imgH} image`
    )
  }
  const x0 = Math.max(0, rect.x0)
  const y0 = Math.max(0, rect.y0)
  const x1 = Math.min(imgW, rect.x1)
  const y1 = Math.min(imgH, rect.y1)

  for (let y = y0; y < y1; y++) {
    let idx = (y * imgW + x0) * 4
    for (let x = x0; x < x1; x++) {
      buf[idx] = color.b
      buf[idx + 1] = color.g
      buf[idx + 2] = color.r
      buf[idx + 3] = 255
      idx += 4
    }
  }
}
