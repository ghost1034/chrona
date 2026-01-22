export type AppPingResponse = {
  ok: true
  nowTs: number
}

export type Settings = {
  version: 1
  captureIntervalSeconds: number
}

export type CaptureState = {
  desiredRecordingEnabled: boolean
  isSystemPaused: boolean
  intervalSeconds: number
  selectedDisplayId: string | null
  resolvedDisplayId: string | null
  lastCaptureTs: number | null
  consecutiveFailures: number
  lastError: string | null
}

export type DisplayInfo = {
  id: string
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}

export type IpcContract = {
  'app:ping': {
    req: void
    res: AppPingResponse
  }
  'settings:getAll': {
    req: void
    res: Settings
  }
  'settings:update': {
    req: Partial<Omit<Settings, 'version'>>
    res: Settings
  }
  'capture:getState': {
    req: void
    res: CaptureState
  }
  'capture:setEnabled': {
    req: { enabled: boolean }
    res: CaptureState
  }
  'capture:setInterval': {
    req: { intervalSeconds: number }
    res: CaptureState
  }
  'capture:setSelectedDisplay': {
    req: { displayId: string | null }
    res: CaptureState
  }
  'capture:listDisplays': {
    req: void
    res: DisplayInfo[]
  }
  'debug:openRecordingsFolder': {
    req: void
    res: { ok: true }
  }

  // Phase 5 debug helpers
  'analysis:runTick': {
    req: void
    res: { createdBatchIds: number[]; unprocessedCount: number }
  }
  'analysis:getRecentBatches': {
    req: { limit: number }
    res: Array<{
      id: number
      batchStartTs: number
      batchEndTs: number
      status: string
      reason: string | null
      createdAt: string
    }>
  }
}

export const IPC_CHANNELS = {
  appPing: 'app:ping',
  settingsGetAll: 'settings:getAll',
  settingsUpdate: 'settings:update',
  captureGetState: 'capture:getState',
  captureSetEnabled: 'capture:setEnabled',
  captureSetInterval: 'capture:setInterval',
  captureSetSelectedDisplay: 'capture:setSelectedDisplay',
  captureListDisplays: 'capture:listDisplays',
  debugOpenRecordingsFolder: 'debug:openRecordingsFolder',
  analysisRunTick: 'analysis:runTick',
  analysisGetRecentBatches: 'analysis:getRecentBatches'
} as const

export const IPC_EVENTS = {
  recordingStateChanged: 'event:recordingStateChanged',
  captureError: 'event:captureError',
  analysisBatchUpdated: 'event:analysisBatchUpdated'
} as const

export type IpcChannel = IpcContractKey
type IpcContractKey = keyof IpcContract
