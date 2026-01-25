export type TimelineCardDTO = {
  id: number
  batchId: number | null
  startTs: number
  endTs: number
  dayKey: string
  title: string
  summary: string | null
  detailedSummary: string | null
  category: string
  subcategory: string | null
  metadata: string | null
  videoSummaryUrl: string | null
}
