export type DashboardStatsDTO = {
  scope: {
    startTs: number
    endTs: number
  }

  windowSeconds: number
  trackedSeconds: number
  untrackedSeconds: number

  byCategorySeconds: Array<{ category: string; seconds: number }>
  byTitleSeconds: Array<{ title: string; seconds: number; category: string }>

  perDay: Array<{
    dayKey: string
    trackedSeconds: number
    byCategorySeconds: Record<string, number>
  }>

  review: {
    trackedNonSystemSeconds: number
    coveredSeconds: number
    coverageFraction: number
    focusSeconds: number
    neutralSeconds: number
    distractedSeconds: number
    unreviewedCardCount: number
  }

  blocks: {
    longestWorkBlockSeconds: number
  }
}
