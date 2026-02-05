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

export type TimelineSearchScopeDTO = {
  startTs: number
  endTs: number
}

export type TimelineSearchFiltersDTO = {
  categories?: string[]
  includeSystem?: boolean
  onlyErrors?: boolean
  hasVideo?: boolean
  hasDetails?: boolean
}

export type TimelineSearchRequestDTO = {
  query: string
  scope: TimelineSearchScopeDTO
  filters?: TimelineSearchFiltersDTO
  limit?: number
  offset?: number
}

export type TimelineSearchHitDTO = {
  card: TimelineCardDTO
  rank?: number | null
  snippet?: string | null
}

export type TimelineSearchResponseDTO = {
  hits: TimelineSearchHitDTO[]
  limit: number
  offset: number
  hasMore: boolean
}
