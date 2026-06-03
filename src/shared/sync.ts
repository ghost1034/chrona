export type SyncStatusDTO = {
  paired: boolean
  enabled: boolean
  endpoint: string
  deviceId: string | null
  displayName: string | null
  syncing: boolean
  lastSyncTs: number | null
  pendingCount: number
  lastError: string | null
}
