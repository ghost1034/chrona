import { describe, expect, it } from 'vitest'
import { applyDemoCardVisibility, effectiveNowTs } from './demo'
import { computeDashboardStats } from './stats'

describe('demo controls', () => {
  it('applies a moving clock offset without changing real time semantics', () => {
    expect(effectiveNowTs(1_000, 3_600)).toBe(4_600)
    expect(effectiveNowTs(1_030, 3_600)).toBe(4_630)
    expect(effectiveNowTs(1_000, null)).toBe(1_000)
  })

  it('makes hidden cards produce the same statistics as an empty timeline', () => {
    const cards = [{ id: 1, startTs: 1_000, endTs: 1_600, category: 'Billable', title: 'Client work' }]
    const hiddenCards = applyDemoCardVisibility(cards, true)
    const stats = computeDashboardStats({
      scopeStartTs: 0,
      scopeEndTs: 3_600,
      cards: hiddenCards,
      reviewSegments: [],
      includeSystem: false
    })

    expect(hiddenCards).toEqual([])
    expect(stats.trackedSeconds).toBe(0)
    expect(stats.untrackedSeconds).toBe(3_600)
    expect(stats.byCategorySeconds).toEqual([])
    expect(stats.review.coverageFraction).toBe(0)
    expect(stats.review.unreviewedCardCount).toBe(0)
  })

  it('returns cards unchanged when the demo visibility switch is off', () => {
    const cards = [{ id: 1 }, { id: 2 }]
    expect(applyDemoCardVisibility(cards, false)).toEqual(cards)
  })
})
