export type JournalEntryStatus = 'draft' | 'complete'

export type JournalEntryDTO = {
  dayKey: string
  intentions: string | null
  notes: string | null
  reflections: string | null
  summary: string | null
  status: JournalEntryStatus
  createdAt: string
  updatedAt: string
}

export type JournalEntryPatch = Partial<{
  intentions: string | null
  notes: string | null
  reflections: string | null
  summary: string | null
  status: JournalEntryStatus
}>

export type JournalDraftDTO = {
  intentions: string
  notes: string
  reflections: string
  summary: string
}
