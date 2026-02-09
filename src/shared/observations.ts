export type ObservationDTO = {
  startTs: number
  endTs: number
  observation: string
  metadata: string | null
  llmModel: string | null
}
