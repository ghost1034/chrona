import { describe, expect, test } from 'vitest'
import { createScreenshotBatches } from './batching'

describe('createScreenshotBatches', () => {
  test('creates a single batch when within maxGap and within targetDuration', () => {
    const cfg = { targetDurationSec: 1800, maxGapSec: 300 }
    const t0 = 1000
    const shots = [
      { id: 1, capturedAt: t0 },
      { id: 2, capturedAt: t0 + 300 },
      { id: 3, capturedAt: t0 + 600 },
      { id: 4, capturedAt: t0 + 900 },
      { id: 5, capturedAt: t0 + 1200 },
      { id: 6, capturedAt: t0 + 1500 },
      { id: 7, capturedAt: t0 + 1800 }
    ]

    const batches = createScreenshotBatches(shots, cfg)
    expect(batches).toHaveLength(1)
    expect(batches[0].startTs).toBe(t0)
    expect(batches[0].endTs).toBe(t0 + 1800)
    expect(batches[0].screenshotIds).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  test('splits batches on max gap', () => {
    const cfg = { targetDurationSec: 1800, maxGapSec: 300 }
    const t0 = 1000
    const shots = [
      { id: 1, capturedAt: t0 },
      { id: 2, capturedAt: t0 + 10 },
      { id: 3, capturedAt: t0 + 400 }, // gap 390 > 300 => split
      { id: 4, capturedAt: t0 + 410 }
    ]

    const batches = createScreenshotBatches(shots, cfg)
    // trailing batch is incomplete and should be dropped, leaving only the first batch
    expect(batches).toHaveLength(1)
    expect(batches[0].screenshotIds).toEqual([1, 2])
  })

  test('splits batches when targetDuration would be exceeded', () => {
    const cfg = { targetDurationSec: 1800, maxGapSec: 300 }
    const t0 = 1000
    const shots = [
      { id: 1, capturedAt: t0 },
      { id: 2, capturedAt: t0 + 300 },
      { id: 3, capturedAt: t0 + 600 },
      { id: 4, capturedAt: t0 + 900 },
      { id: 5, capturedAt: t0 + 1200 },
      { id: 6, capturedAt: t0 + 1500 },
      { id: 7, capturedAt: t0 + 1800 },
      { id: 8, capturedAt: t0 + 1801 } // durationIfAdded would exceed target => split
    ]

    const batches = createScreenshotBatches(shots, cfg)
    expect(batches).toHaveLength(1)
    expect(batches[0].screenshotIds).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  test('drops trailing incomplete batch', () => {
    const cfg = { targetDurationSec: 1800, maxGapSec: 300 }
    const t0 = 1000
    const shots = [
      { id: 1, capturedAt: t0 },
      { id: 2, capturedAt: t0 + 300 },
      { id: 3, capturedAt: t0 + 600 },
      { id: 4, capturedAt: t0 + 900 }
    ]

    const batches = createScreenshotBatches(shots, cfg)
    expect(batches).toHaveLength(0)
  })
})
