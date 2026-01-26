import type { TimelineCardDTO } from './timeline'

export type ReviewRating = 'focus' | 'neutral' | 'distracted'

export type ReviewSegment = {
  startTs: number
  endTs: number
  rating: ReviewRating
}

export function mergedCoverageIntervals(segments: ReviewSegment[]): Array<{ startTs: number; endTs: number }> {
  const sorted = [...segments]
    .filter((s) => Number.isFinite(s.startTs) && Number.isFinite(s.endTs) && s.endTs > s.startTs)
    .sort((a, b) => a.startTs - b.startTs)

  const out: Array<{ startTs: number; endTs: number }> = []
  for (const s of sorted) {
    if (out.length === 0) {
      out.push({ startTs: s.startTs, endTs: s.endTs })
      continue
    }

    const last = out[out.length - 1]
    if (s.startTs <= last.endTs) {
      last.endTs = Math.max(last.endTs, s.endTs)
      continue
    }
    out.push({ startTs: s.startTs, endTs: s.endTs })
  }
  return out
}

export function coverageSecondsForRange(opts: {
  segments: ReviewSegment[]
  startTs: number
  endTs: number
}): number {
  if (opts.endTs <= opts.startTs) return 0
  const intervals = mergedCoverageIntervals(opts.segments)
  let covered = 0
  for (const i of intervals) {
    const s = Math.max(opts.startTs, i.startTs)
    const e = Math.min(opts.endTs, i.endTs)
    if (e > s) covered += e - s
  }
  return covered
}

export function coverageFractionForRange(opts: {
  segments: ReviewSegment[]
  startTs: number
  endTs: number
}): number {
  const dur = opts.endTs - opts.startTs
  if (dur <= 0) return 0
  return coverageSecondsForRange(opts) / dur
}

export function coverageByCardId(opts: {
  cards: TimelineCardDTO[]
  segments: ReviewSegment[]
  ignoreSystem?: boolean
}): Record<number, number> {
  const out: Record<number, number> = {}
  const ignoreSystem = opts.ignoreSystem ?? true

  for (const c of opts.cards) {
    if (ignoreSystem && c.category === 'System') continue
    out[c.id] = coverageFractionForRange({
      segments: opts.segments,
      startTs: c.startTs,
      endTs: c.endTs
    })
  }
  return out
}

export function filterUnreviewedCards(opts: {
  cards: TimelineCardDTO[]
  segments: ReviewSegment[]
  coverageThreshold: number
}): Array<{ card: TimelineCardDTO; coverage: number }> {
  const out: Array<{ card: TimelineCardDTO; coverage: number }> = []
  for (const c of opts.cards) {
    if (c.category === 'System') continue
    const cov = coverageFractionForRange({ segments: opts.segments, startTs: c.startTs, endTs: c.endTs })
    if (cov < opts.coverageThreshold) out.push({ card: c, coverage: cov })
  }
  out.sort((a, b) => a.card.startTs - b.card.startTs)
  return out
}
