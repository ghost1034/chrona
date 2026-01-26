import { describe, expect, test } from 'vitest'
import { coverageSecondsForRange, coverageFractionForRange, mergedCoverageIntervals } from './review'

describe('mergedCoverageIntervals', () => {
  test('merges overlapping and adjacent segments', () => {
    const merged = mergedCoverageIntervals([
      { startTs: 0, endTs: 10, rating: 'focus' },
      { startTs: 10, endTs: 20, rating: 'neutral' },
      { startTs: 18, endTs: 30, rating: 'distracted' }
    ])
    expect(merged).toEqual([{ startTs: 0, endTs: 30 }])
  })
})

describe('coverageSecondsForRange', () => {
  test('computes union overlap', () => {
    const covered = coverageSecondsForRange({
      startTs: 100,
      endTs: 200,
      segments: [
        { startTs: 50, endTs: 120, rating: 'focus' },
        { startTs: 150, endTs: 250, rating: 'neutral' }
      ]
    })
    expect(covered).toBe(20 + 50)
  })
})

describe('coverageFractionForRange', () => {
  test('returns 0 when no segments', () => {
    expect(
      coverageFractionForRange({ startTs: 0, endTs: 100, segments: [] })
    ).toBe(0)
  })
})
