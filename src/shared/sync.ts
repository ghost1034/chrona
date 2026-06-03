/**
 * CPAAutomation's production API. Used whenever settings.syncEndpoint is
 * empty (the normal case) — users never enter a server URL. The setting
 * remains as a hand-editable override for development (e.g. localhost:8000).
 */
export const DEFAULT_SYNC_ENDPOINT = 'https://api.cpaautomation.ai'

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
