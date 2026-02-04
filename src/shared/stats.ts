import type { ReviewRating, ReviewSegment } from './review'
import { mergedCoverageIntervals } from './review'
import { dayKeyFromUnixSeconds, dayWindowForDayKey } from './time'
import type { DashboardStatsDTO } from './dashboard'

export type CardForStats = {
  id: number
  startTs: number
  endTs: number
  category: string
  title: string
}

export type CardForStatsWithSub = CardForStats & {
  subcategory?: string | null
}

type Interval = { startTs: number; endTs: number }

type AttributedSegment = {
  startTs: number
  endTs: number
  category: string
  title: string
  cardId: number
}

export function computeDashboardStats(opts: {
  scopeStartTs: number
  scopeEndTs: number
  cards: CardForStatsWithSub[]
  reviewSegments: ReviewSegment[]
  includeSystem?: boolean
}): DashboardStatsDTO {
  const scopeStartTs = Math.floor(opts.scopeStartTs)
  const scopeEndTs = Math.floor(opts.scopeEndTs)
  if (!Number.isFinite(scopeStartTs) || !Number.isFinite(scopeEndTs) || scopeEndTs <= scopeStartTs) {
    throw new Error('Invalid scope')
  }

  const includeSystem = opts.includeSystem ?? false
  const windowSeconds = Math.max(0, scopeEndTs - scopeStartTs)

  const normalized = opts.cards
    .map((c) => ({
      id: Number(c.id),
      startTs: Math.floor(Number(c.startTs)),
      endTs: Math.floor(Number(c.endTs)),
      category: String(c.category ?? '').trim(),
      title: String(c.title ?? '').trim()
    }))
    .filter((c) =>
      Number.isFinite(c.id) &&
      Number.isFinite(c.startTs) &&
      Number.isFinite(c.endTs) &&
      c.endTs > c.startTs &&
      c.category &&
      c.title
    )
    .map((c) => ({
      ...c,
      startTs: Math.max(scopeStartTs, c.startTs),
      endTs: Math.min(scopeEndTs, c.endTs)
    }))
    .filter((c) => c.endTs > c.startTs)
    .sort((a, b) => (a.startTs - b.startTs !== 0 ? a.startTs - b.startTs : a.id - b.id))

  const nonSystemCards = normalized.filter((c) => c.category !== 'System')
  const systemCards = normalized.filter((c) => c.category === 'System')

  const { segments: nonSystemSegments, union: nonSystemUnion } = attributeSegmentsByEarliestStart(
    nonSystemCards
  )

  let segments: AttributedSegment[] = nonSystemSegments
  let union: Interval[] = nonSystemUnion

  if (includeSystem && systemCards.length > 0) {
    const added = attributeSegmentsIntoUnion(systemCards, union)
    segments = [...segments, ...added.segments]
    union = added.union
    segments.sort((a, b) => (a.startTs - b.startTs !== 0 ? a.startTs - b.startTs : a.cardId - b.cardId))
  }

  const trackedSeconds = sumIntervals(union)
  const untrackedSeconds = Math.max(0, windowSeconds - trackedSeconds)

  const byCategorySeconds = topByKey(sumBy(segments, (s) => s.category), 50).map((x) => ({
    category: x.key,
    seconds: x.seconds
  }))

  const byTitleSeconds = topByKey(
    sumBy(segments, (s) => `${s.category}\t${s.title}`),
    30
  ).map((x) => {
    const [category, title] = x.key.split('\t')
    return { category, title, seconds: x.seconds }
  })

  const perDay = splitSegmentsByDay(scopeStartTs, scopeEndTs, segments)

  const longestWorkBlockSeconds = longestContiguousBlockSeconds(
    segments.filter((s) => s.category === 'Work')
  )

  const review = computeReviewStats({
    scopeStartTs,
    scopeEndTs,
    cards: nonSystemCards,
    attributedSegments: nonSystemSegments,
    reviewSegments: opts.reviewSegments
  })

  return {
    scope: { startTs: scopeStartTs, endTs: scopeEndTs },
    windowSeconds,
    trackedSeconds,
    untrackedSeconds,
    byCategorySeconds,
    byTitleSeconds,
    perDay,
    review,
    blocks: { longestWorkBlockSeconds }
  }
}

function attributeSegmentsByEarliestStart(cards: CardForStats[]): {
  segments: AttributedSegment[]
  union: Interval[]
} {
  let union: Interval[] = []
  const segments: AttributedSegment[] = []

  for (const c of cards) {
    const interval: Interval = { startTs: c.startTs, endTs: c.endTs }
    const pieces = subtractUnion(interval, union)
    if (pieces.length === 0) continue

    for (const p of pieces) {
      segments.push({
        startTs: p.startTs,
        endTs: p.endTs,
        category: c.category,
        title: c.title,
        cardId: c.id
      })
    }

    union = mergeUnion([...union, ...pieces])
  }

  segments.sort((a, b) => (a.startTs - b.startTs !== 0 ? a.startTs - b.startTs : a.cardId - b.cardId))
  return { segments, union }
}

function attributeSegmentsIntoUnion(
  cards: CardForStats[],
  existingUnion: Interval[]
): { segments: AttributedSegment[]; union: Interval[] } {
  let union = [...existingUnion]
  const segments: AttributedSegment[] = []

  for (const c of cards) {
    const interval: Interval = { startTs: c.startTs, endTs: c.endTs }
    const pieces = subtractUnion(interval, union)
    if (pieces.length === 0) continue

    for (const p of pieces) {
      segments.push({
        startTs: p.startTs,
        endTs: p.endTs,
        category: c.category,
        title: c.title,
        cardId: c.id
      })
    }

    union = mergeUnion([...union, ...pieces])
  }

  segments.sort((a, b) => (a.startTs - b.startTs !== 0 ? a.startTs - b.startTs : a.cardId - b.cardId))
  return { segments, union }
}

function subtractUnion(interval: Interval, union: Interval[]): Interval[] {
  const start = interval.startTs
  const end = interval.endTs
  if (end <= start) return []
  if (union.length === 0) return [{ startTs: start, endTs: end }]

  const out: Interval[] = []
  let cur = start

  for (const u of union) {
    if (u.endTs <= cur) continue
    if (u.startTs >= end) break

    if (u.startTs > cur) {
      out.push({ startTs: cur, endTs: Math.min(u.startTs, end) })
    }

    cur = Math.max(cur, u.endTs)
    if (cur >= end) break
  }

  if (cur < end) out.push({ startTs: cur, endTs: end })
  return out.filter((i) => i.endTs > i.startTs)
}

function mergeUnion(intervals: Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => Number.isFinite(i.startTs) && Number.isFinite(i.endTs) && i.endTs > i.startTs)
    .sort((a, b) => a.startTs - b.startTs)

  const out: Interval[] = []
  for (const i of sorted) {
    if (out.length === 0) {
      out.push({ startTs: i.startTs, endTs: i.endTs })
      continue
    }
    const last = out[out.length - 1]
    if (i.startTs <= last.endTs) {
      last.endTs = Math.max(last.endTs, i.endTs)
      continue
    }
    out.push({ startTs: i.startTs, endTs: i.endTs })
  }
  return out
}

function sumIntervals(intervals: Interval[]): number {
  let total = 0
  for (const i of intervals) total += Math.max(0, i.endTs - i.startTs)
  return total
}

function sumBy<T>(items: T[], keyFn: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const it of items) {
    const k = keyFn(it)
    out[k] = (out[k] ?? 0) + Math.max(0, (it as any).endTs - (it as any).startTs)
  }
  return out
}

function topByKey(obj: Record<string, number>, max: number): Array<{ key: string; seconds: number }> {
  return Object.entries(obj)
    .filter(([, v]) => Number.isFinite(v) && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k, v]) => ({ key: k, seconds: Math.floor(v) }))
}

function splitSegmentsByDay(
  scopeStartTs: number,
  scopeEndTs: number,
  segments: AttributedSegment[]
): DashboardStatsDTO['perDay'] {
  const dayKeys = enumerateDayKeys(scopeStartTs, scopeEndTs)
  const byDay: Record<string, { trackedSeconds: number; byCategorySeconds: Record<string, number> }> = {}
  for (const dayKey of dayKeys) {
    byDay[dayKey] = { trackedSeconds: 0, byCategorySeconds: {} }
  }

  for (const s of segments) {
    splitAcrossDays(scopeStartTs, scopeEndTs, s.startTs, s.endTs, (partStart, partEnd, dayKey) => {
      const dur = Math.max(0, partEnd - partStart)
      if (dur <= 0) return
      const bucket = byDay[dayKey] ?? (byDay[dayKey] = { trackedSeconds: 0, byCategorySeconds: {} })
      bucket.trackedSeconds += dur
      bucket.byCategorySeconds[s.category] = (bucket.byCategorySeconds[s.category] ?? 0) + dur
    })
  }

  return dayKeys.map((dayKey) => ({
    dayKey,
    trackedSeconds: Math.floor(byDay[dayKey]?.trackedSeconds ?? 0),
    byCategorySeconds: Object.fromEntries(
      Object.entries(byDay[dayKey]?.byCategorySeconds ?? {}).map(([k, v]) => [k, Math.floor(v)])
    )
  }))
}

function enumerateDayKeys(scopeStartTs: number, scopeEndTs: number): string[] {
  const startKey = dayKeyFromUnixSeconds(scopeStartTs)
  const endKey = dayKeyFromUnixSeconds(Math.max(scopeStartTs, scopeEndTs - 1))

  const startDate = new Date(startKey + 'T00:00:00')
  const endDate = new Date(endKey + 'T00:00:00')
  const out: string[] = []
  const d = new Date(startDate)
  while (d.getTime() <= endDate.getTime()) {
    const key = dayKeyFromUnixSeconds(Math.floor(d.getTime() / 1000) + 4 * 60 * 60)
    out.push(key)
    d.setDate(d.getDate() + 1)
  }
  return out
}

function splitAcrossDays(
  scopeStartTs: number,
  scopeEndTs: number,
  startTs: number,
  endTs: number,
  emit: (partStartTs: number, partEndTs: number, dayKey: string) => void
) {
  let curStart = Math.max(scopeStartTs, startTs)
  const end = Math.min(scopeEndTs, endTs)
  while (curStart < end) {
    const dayKey = dayKeyFromUnixSeconds(curStart)
    const win = dayWindowForDayKey(dayKey)
    const partEnd = Math.min(end, win.endTs)
    emit(curStart, partEnd, dayKey)
    curStart = partEnd
  }
}

function longestContiguousBlockSeconds(segments: AttributedSegment[]): number {
  const sorted = [...segments]
    .filter((s) => s.endTs > s.startTs)
    .sort((a, b) => a.startTs - b.startTs)

  let best = 0
  let curStart: number | null = null
  let curEnd: number | null = null

  for (const s of sorted) {
    if (curStart === null || curEnd === null) {
      curStart = s.startTs
      curEnd = s.endTs
      best = Math.max(best, curEnd - curStart)
      continue
    }

    if (s.startTs <= curEnd) {
      curEnd = Math.max(curEnd, s.endTs)
      best = Math.max(best, curEnd - curStart)
      continue
    }

    curStart = s.startTs
    curEnd = s.endTs
    best = Math.max(best, curEnd - curStart)
  }

  return Math.floor(best)
}

function computeReviewStats(opts: {
  scopeStartTs: number
  scopeEndTs: number
  cards: CardForStats[]
  attributedSegments: AttributedSegment[]
  reviewSegments: ReviewSegment[]
}): DashboardStatsDTO['review'] {
  const scopeStartTs = opts.scopeStartTs
  const scopeEndTs = opts.scopeEndTs

  // Review ignores System cards.
  const trackedNonSystemUnion = mergeUnion(
    opts.attributedSegments
      .filter((s) => s.category !== 'System')
      .map((s) => ({ startTs: s.startTs, endTs: s.endTs }))
  )
  const trackedNonSystemSeconds = sumIntervals(trackedNonSystemUnion)

  const reviewSegments = opts.reviewSegments
    .map((s) => ({
      startTs: Math.floor(Number(s.startTs)),
      endTs: Math.floor(Number(s.endTs)),
      rating: (s as any).rating as ReviewRating
    }))
    .filter((s) =>
      Number.isFinite(s.startTs) &&
      Number.isFinite(s.endTs) &&
      s.endTs > s.startTs &&
      (s.rating === 'focus' || s.rating === 'neutral' || s.rating === 'distracted')
    )

  const totals: Record<'focus' | 'neutral' | 'distracted', number> = {
    focus: 0,
    neutral: 0,
    distracted: 0
  }

  for (const s of reviewSegments) {
    const clamped: Interval = {
      startTs: Math.max(scopeStartTs, s.startTs),
      endTs: Math.min(scopeEndTs, s.endTs)
    }
    if (clamped.endTs <= clamped.startTs) continue
    totals[s.rating] += overlapSecondsWithUnion(clamped, trackedNonSystemUnion)
  }

  const coveredSeconds = Math.floor(totals.focus + totals.neutral + totals.distracted)
  const coverageFraction = trackedNonSystemSeconds > 0 ? coveredSeconds / trackedNonSystemSeconds : 0

  const coverageByCard = computeCoverageByCardId({
    cards: opts.cards,
    reviewSegments
  })
  const unreviewedCardCount = Object.values(coverageByCard).filter((v) => v < 0.8).length

  return {
    trackedNonSystemSeconds: Math.floor(trackedNonSystemSeconds),
    coveredSeconds,
    coverageFraction,
    focusSeconds: Math.floor(totals.focus),
    neutralSeconds: Math.floor(totals.neutral),
    distractedSeconds: Math.floor(totals.distracted),
    unreviewedCardCount
  }
}

function overlapSecondsWithUnion(interval: Interval, union: Interval[]): number {
  let total = 0
  for (const u of union) {
    const s = Math.max(interval.startTs, u.startTs)
    const e = Math.min(interval.endTs, u.endTs)
    if (e > s) total += e - s
  }
  return total
}

function computeCoverageByCardId(opts: {
  cards: CardForStats[]
  reviewSegments: ReviewSegment[]
}): Record<number, number> {
  const out: Record<number, number> = {}
  const coverageIntervals = mergedCoverageIntervals(opts.reviewSegments)

  for (const c of opts.cards) {
    if (c.category === 'System') continue
    const s = c.startTs
    const e = c.endTs
    const dur = e - s
    if (dur <= 0) continue
    let covered = 0
    for (const i of coverageIntervals) {
      const a = Math.max(s, i.startTs)
      const b = Math.min(e, i.endTs)
      if (b > a) covered += b - a
    }
    out[c.id] = covered / dur
  }
  return out
}
