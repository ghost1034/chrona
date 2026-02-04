export type AskScope = {
  startTs: number
  endTs: number
}

export type AskSourceRef = {
  type: 'card'
  cardId: number
  dayKey: string
  startTs: number
  endTs: number
  title: string
  category: string
  subcategory: string | null
}

export type AskRunRequest = {
  question: string
  scope: AskScope
  options?: {
    useObservations?: boolean
    includeReview?: boolean
  }
}

export type AskRunResponse = {
  answerMarkdown: string
  sources: AskSourceRef[]
  followUps: string[]
}
