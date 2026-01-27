export type AppPingResponse = {
  ok: true
  nowTs: number
}

export type Settings = {
  version: 2
  captureIntervalSeconds: number
  storageLimitRecordingsBytes: number
  storageLimitTimelapsesBytes: number
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

  'gemini:setApiKey': {
    req: { apiKey: string }
    res: { ok: true }
  }
  'gemini:hasApiKey': {
    req: void
    res: { hasApiKey: boolean }
  }

  'timeline:getDay': {
    req: { dayKey: string }
    res: { dayKey: string; cards: import('./timeline').TimelineCardDTO[] }
  }
  'timeline:updateCardCategory': {
    req: { cardId: number; category: string; subcategory?: string | null }
    res: { ok: true }
  }
  'timeline:copyDayToClipboard': {
    req: { dayKey: string }
    res: { ok: true }
  }
  'timeline:saveMarkdownRange': {
    req: { startDayKey: string; endDayKey: string }
    res: { ok: true; filePath: string | null }
  }

  'review:getDay': {
    req: { dayKey: string }
    res: {
      dayKey: string
      segments: import('./review').ReviewSegment[]
      coverageByCardId: Record<number, number>
    }
  }
  'review:applyRating': {
    req: { startTs: number; endTs: number; rating: import('./review').ReviewRating }
    res: { ok: true }
  }

  'storage:getUsage': {
    req: void
    res: {
      recordingsBytes: number
      timelapsesBytes: number
      recordingsLimitBytes: number
      timelapsesLimitBytes: number
    }
  }
  'storage:purgeNow': {
    req: void
    res: {
      ok: true
      deletedScreenshotCount: number
      deletedTimelapseCount: number
      freedRecordingsBytes: number
      freedTimelapsesBytes: number
      recordingsBytes: number
      timelapsesBytes: number
    }
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
  analysisGetRecentBatches: 'analysis:getRecentBatches',
  geminiSetApiKey: 'gemini:setApiKey',
  geminiHasApiKey: 'gemini:hasApiKey',
  timelineGetDay: 'timeline:getDay',
  timelineUpdateCardCategory: 'timeline:updateCardCategory',
  timelineCopyDayToClipboard: 'timeline:copyDayToClipboard',
  timelineSaveMarkdownRange: 'timeline:saveMarkdownRange',
  reviewGetDay: 'review:getDay',
  reviewApplyRating: 'review:applyRating',
  storageGetUsage: 'storage:getUsage',
  storagePurgeNow: 'storage:purgeNow'
} as const

export const IPC_EVENTS = {
  recordingStateChanged: 'event:recordingStateChanged',
  captureError: 'event:captureError',
  analysisBatchUpdated: 'event:analysisBatchUpdated',
  timelineUpdated: 'event:timelineUpdated',
  storageUsageUpdated: 'event:storageUsageUpdated'
} as const

export type IpcChannel = IpcContractKey
type IpcContractKey = keyof IpcContract
