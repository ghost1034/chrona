import { describe, expect, test } from 'vitest'
import {
  fillRectBGRA,
  isValidNormalizedRect,
  normalizedRectFromDrag,
  pixelRectFromNormalized
} from './blurRegions'

describe('normalizedRectFromDrag', () => {
  const win = { width: 1000, height: 800 }

  test('produces the same rect regardless of drag direction', () => {
    const a = normalizedRectFromDrag({ x: 100, y: 200 }, { x: 300, y: 400 }, win)
    const b = normalizedRectFromDrag({ x: 300, y: 400 }, { x: 100, y: 200 }, win)
    const c = normalizedRectFromDrag({ x: 300, y: 200 }, { x: 100, y: 400 }, win)
    expect(a).toEqual({ x: 0.1, y: 0.25, w: 0.2, h: 0.25 })
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  test('clamps drags that leave the window', () => {
    const r = normalizedRectFromDrag({ x: -50, y: -50 }, { x: 1200, y: 900 }, win)
    expect(r).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  test('returns null for degenerate drags', () => {
    expect(normalizedRectFromDrag({ x: 100, y: 100 }, { x: 102, y: 300 }, win)).toBeNull()
    expect(normalizedRectFromDrag({ x: 100, y: 100 }, { x: 300, y: 102 }, win)).toBeNull()
    expect(normalizedRectFromDrag({ x: 100, y: 100 }, { x: 100, y: 100 }, win)).toBeNull()
  })

  test('returns null for invalid inputs', () => {
    expect(normalizedRectFromDrag({ x: NaN, y: 0 }, { x: 100, y: 100 }, win)).toBeNull()
    expect(
      normalizedRectFromDrag({ x: 0, y: 0 }, { x: 100, y: 100 }, { width: 0, height: 800 })
    ).toBeNull()
  })
})

describe('isValidNormalizedRect', () => {
  test('accepts in-bounds rects', () => {
    expect(isValidNormalizedRect({ x: 0, y: 0, w: 1, h: 1 })).toBe(true)
    expect(isValidNormalizedRect({ x: 0.5, y: 0.5, w: 0.25, h: 0.1 })).toBe(true)
  })

  test('rejects malformed values', () => {
    expect(isValidNormalizedRect(null)).toBe(false)
    expect(isValidNormalizedRect({})).toBe(false)
    expect(isValidNormalizedRect({ x: 0, y: 0, w: 0, h: 0.5 })).toBe(false)
    expect(isValidNormalizedRect({ x: 0.9, y: 0, w: 0.2, h: 0.5 })).toBe(false)
    expect(isValidNormalizedRect({ x: -0.1, y: 0, w: 0.2, h: 0.5 })).toBe(false)
    expect(isValidNormalizedRect({ x: NaN, y: 0, w: 0.2, h: 0.5 })).toBe(false)
    expect(isValidNormalizedRect({ x: '0', y: 0, w: 0.2, h: 0.5 })).toBe(false)
  })
})

describe('pixelRectFromNormalized', () => {
  test('rounds outward so no sensitive pixel leaks', () => {
    // x: 0.1004 * 1000 = 100.4 -> floor 100; x+w: 0.4996 * 1000 = 499.6 -> ceil 500
    const r = pixelRectFromNormalized({ x: 0.1004, y: 0.1004, w: 0.3992, h: 0.3992 }, 1000, 1000)
    expect(r).toEqual({ x0: 100, y0: 100, x1: 500, y1: 500 })
  })

  test('maps the full-image rect exactly', () => {
    expect(pixelRectFromNormalized({ x: 0, y: 0, w: 1, h: 1 }, 1920, 1080)).toEqual({
      x0: 0,
      y0: 0,
      x1: 1920,
      y1: 1080
    })
  })

  test('returns null for invalid rects or image sizes', () => {
    expect(pixelRectFromNormalized({ x: 0, y: 0, w: 0, h: 1 }, 100, 100)).toBeNull()
    expect(pixelRectFromNormalized({ x: NaN, y: 0, w: 1, h: 1 }, 100, 100)).toBeNull()
    expect(pixelRectFromNormalized({ x: 0, y: 0, w: 1, h: 1 }, 0, 100)).toBeNull()
  })

  test('round-trips a region defined on a larger display onto a smaller capture', () => {
    // Region drawn on a 2560x1440 display, capture is 1920x1080.
    const drag = normalizedRectFromDrag({ x: 640, y: 360 }, { x: 1280, y: 720 }, {
      width: 2560,
      height: 1440
    })
    expect(drag).toEqual({ x: 0.25, y: 0.25, w: 0.25, h: 0.25 })
    expect(pixelRectFromNormalized(drag!, 1920, 1080)).toEqual({
      x0: 480,
      y0: 270,
      x1: 960,
      y1: 540
    })
  })
})

describe('fillRectBGRA', () => {
  function makeImage(w: number, h: number, fill: number): Buffer {
    return Buffer.alloc(w * h * 4, fill)
  }

  function pixelAt(buf: Buffer, w: number, x: number, y: number): number[] {
    const idx = (y * w + x) * 4
    return [buf[idx], buf[idx + 1], buf[idx + 2], buf[idx + 3]]
  }

  test('fills exactly the rect and nothing outside it', () => {
    const w = 10
    const h = 8
    const buf = makeImage(w, h, 0x77)
    fillRectBGRA(buf, w, h, { x0: 2, y0: 3, x1: 6, y1: 6 })

    const filled = [26, 26, 26, 255]
    const untouched = [0x77, 0x77, 0x77, 0x77]

    // Corners of the filled rect (inclusive mins, exclusive maxes).
    expect(pixelAt(buf, w, 2, 3)).toEqual(filled)
    expect(pixelAt(buf, w, 5, 3)).toEqual(filled)
    expect(pixelAt(buf, w, 2, 5)).toEqual(filled)
    expect(pixelAt(buf, w, 5, 5)).toEqual(filled)

    // One-past pixels in every direction.
    expect(pixelAt(buf, w, 1, 3)).toEqual(untouched)
    expect(pixelAt(buf, w, 6, 3)).toEqual(untouched)
    expect(pixelAt(buf, w, 2, 2)).toEqual(untouched)
    expect(pixelAt(buf, w, 2, 6)).toEqual(untouched)
  })

  test('clamps rects that extend past the image', () => {
    const w = 4
    const h = 4
    const buf = makeImage(w, h, 0)
    fillRectBGRA(buf, w, h, { x0: 2, y0: 2, x1: 10, y1: 10 }, { b: 1, g: 2, r: 3 })
    expect(pixelAt(buf, w, 3, 3)).toEqual([1, 2, 3, 255])
    expect(pixelAt(buf, w, 1, 1)).toEqual([0, 0, 0, 0])
  })

  test('forces alpha to 255', () => {
    const w = 2
    const h = 2
    const buf = makeImage(w, h, 0)
    fillRectBGRA(buf, w, h, { x0: 0, y0: 0, x1: 2, y1: 2 })
    expect(pixelAt(buf, w, 0, 0)[3]).toBe(255)
  })

  test('throws on a buffer too small for the stated size', () => {
    const buf = Buffer.alloc(10)
    expect(() => fillRectBGRA(buf, 10, 10, { x0: 0, y0: 0, x1: 1, y1: 1 })).toThrow(
      /too small/
    )
  })
})
