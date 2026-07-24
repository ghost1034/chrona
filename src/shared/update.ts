export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export type UpdateState = {
  supported: boolean
  status: UpdateStatus
  currentVersion: string
  availableVersion: string | null
  downloadPercent: number | null
  message: string | null
  checkedAt: string | null
}
