export type AppPingResponse = {
  ok: true
  nowTs: number
}

export type Settings = {
  version: 8
  captureIntervalSeconds: number
  captureSelectedDisplayId: string | null
  captureIncludeCursor: boolean

  // Timeline taxonomy
  categories: import('./categories').CategoryDefinition[]
  subcategories: import('./categories').SubcategoryDefinition[]

  // Analysis scheduling + batching
  analysisCheckIntervalSeconds: number
  analysisLookbackSeconds: number
  analysisBatchTargetDurationSec: number
  analysisBatchMaxGapSec: number
  analysisMinBatchDurationSec: number
  analysisCardWindowLookbackSec: number

  storageLimitRecordingsBytes: number
  storageLimitTimelapsesBytes: number
  timelapsesEnabled: boolean
  timelapseFps: number
  autoStartEnabled: boolean
  timelinePxPerHour: number

  geminiModel: string
  geminiRequestTimeoutMs: number
  geminiMaxAttempts: number
  geminiLogBodies: boolean

  promptPreambleTranscribe: string
  promptPreambleCards: string
  promptPreambleAsk: string
  promptPreambleJournalDraft: string

  onboardingVersion: number
  onboardingCompleted: boolean
}

export type CaptureAccessStatus = 'granted' | 'denied' | 'unknown' | 'not_applicable'

export type CaptureAccessInfo = {
  status: CaptureAccessStatus
  message: string | null
}

export type SetupStatus = {
  platform: NodeJS.Platform
  hasGeminiKey: boolean
  captureAccess: CaptureAccessInfo
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
  'app:getAutoStart': {
    req: void
    res: { enabled: boolean }
  }
  'app:setAutoStart': {
    req: { enabled: boolean }
    res: { enabled: boolean }
  }

  'app:openGeminiKeyPage': {
    req: void
    res: { ok: true }
  }

  'app:openMacScreenRecordingSettings': {
    req: void
    res: { ok: true }
  }

  'app:relaunch': {
    req: void
    res: { ok: true }
  }

  'setup:getStatus': {
    req: void
    res: SetupStatus
  }
  'settings:getAll': {
    req: void
    res: Settings
  }
  'settings:update': {
    req: Partial<Omit<Settings, 'version'>>
    res: Settings
  }

  'categories:getAll': {
    req: void
    res: {
      categories: import('./categories').CategoryDefinition[]
      subcategories: import('./categories').SubcategoryDefinition[]
    }
  }
  'categories:create': {
    req: { name: string; color: string; description: string }
    res: { category: import('./categories').CategoryDefinition }
  }
  'categories:update': {
    req: {
      id: string
      patch: Partial<Pick<import('./categories').CategoryDefinition, 'name' | 'color' | 'description'>>
    }
    res: { category: import('./categories').CategoryDefinition }
  }
  'categories:delete': {
    req: { id: string; reassignToCategoryId: string }
    res: { ok: true }
  }

  'subcategories:create': {
    req: { categoryId: string; name: string; color: string; description: string }
    res: { subcategory: import('./categories').SubcategoryDefinition }
  }
  'subcategories:update': {
    req: {
      id: string
      patch: Partial<Pick<import('./categories').SubcategoryDefinition, 'name' | 'color' | 'description'>>
    }
    res: { subcategory: import('./categories').SubcategoryDefinition }
  }
  'subcategories:delete': {
    req:
      | { id: string; mode: 'clear' }
      | { id: string; mode: 'reassign'; reassignToSubcategoryId: string }
    res: { ok: true }
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

  'capture:probeAccess': {
    req: void
    res: CaptureAccessInfo
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

  'gemini:testApiKey': {
    req: { apiKey?: string | null }
    res: { ok: boolean; message: string }
  }

  'timeline:getDay': {
    req: { dayKey: string }
    res: { dayKey: string; cards: import('./timeline').TimelineCardDTO[] }
  }

  'timeline:search': {
    req: import('./timeline').TimelineSearchRequestDTO
    res: import('./timeline').TimelineSearchResponseDTO
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

  'timeline:saveCsvRange': {
    req: {
      startDayKey: string
      endDayKey: string
      options?: import('./timelineExport').TimelineExportOptions
    }
    res: { ok: true; filePath: string | null }
  }

  'timeline:saveXlsxRange': {
    req: {
      startDayKey: string
      endDayKey: string
      options?: import('./timelineExport').TimelineExportOptions
    }
    res: { ok: true; filePath: string | null }
  }

  'journal:getDay': {
    req: { dayKey: string }
    res: { dayKey: string; entry: import('./journal').JournalEntryDTO | null }
  }
  'journal:upsert': {
    req: { dayKey: string; patch: import('./journal').JournalEntryPatch }
    res: { entry: import('./journal').JournalEntryDTO }
  }
  'journal:delete': {
    req: { dayKey: string }
    res: { ok: true }
  }
  'journal:draftWithGemini': {
    req: {
      dayKey: string
      options?: {
        includeObservations?: boolean
        includeReview?: boolean
      }
    }
    res: { draft: import('./journal').JournalDraftDTO }
  }
  'journal:copyDayToClipboard': {
    req: { dayKey: string }
    res: { ok: true }
  }
  'journal:saveMarkdownRange': {
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

  'storage:resolveFileUrl': {
    req: { relPath: string }
    res: { fileUrl: string }
  }

  'ask:run': {
    req: import('./ask').AskRunRequest
    res: import('./ask').AskRunResponse
  }

  'dashboard:get': {
    req: {
      scope: { startTs: number; endTs: number }
      options?: { includeSystem?: boolean }
    }
    res: import('./dashboard').DashboardStatsDTO
  }
}

export const IPC_CHANNELS = {
  appPing: 'app:ping',
  appGetAutoStart: 'app:getAutoStart',
  appSetAutoStart: 'app:setAutoStart',
  appOpenGeminiKeyPage: 'app:openGeminiKeyPage',
  appOpenMacScreenRecordingSettings: 'app:openMacScreenRecordingSettings',
  appRelaunch: 'app:relaunch',
  setupGetStatus: 'setup:getStatus',
  settingsGetAll: 'settings:getAll',
  settingsUpdate: 'settings:update',

  categoriesGetAll: 'categories:getAll',
  categoriesCreate: 'categories:create',
  categoriesUpdate: 'categories:update',
  categoriesDelete: 'categories:delete',
  subcategoriesCreate: 'subcategories:create',
  subcategoriesUpdate: 'subcategories:update',
  subcategoriesDelete: 'subcategories:delete',
  captureGetState: 'capture:getState',
  captureSetEnabled: 'capture:setEnabled',
  captureSetInterval: 'capture:setInterval',
  captureSetSelectedDisplay: 'capture:setSelectedDisplay',
  captureListDisplays: 'capture:listDisplays',
  captureProbeAccess: 'capture:probeAccess',
  debugOpenRecordingsFolder: 'debug:openRecordingsFolder',
  analysisRunTick: 'analysis:runTick',
  analysisGetRecentBatches: 'analysis:getRecentBatches',
  geminiSetApiKey: 'gemini:setApiKey',
  geminiHasApiKey: 'gemini:hasApiKey',
  geminiTestApiKey: 'gemini:testApiKey',
  timelineGetDay: 'timeline:getDay',
  timelineSearch: 'timeline:search',
  timelineUpdateCardCategory: 'timeline:updateCardCategory',
  timelineCopyDayToClipboard: 'timeline:copyDayToClipboard',
  timelineSaveMarkdownRange: 'timeline:saveMarkdownRange',
  timelineSaveCsvRange: 'timeline:saveCsvRange',
  timelineSaveXlsxRange: 'timeline:saveXlsxRange',
  journalGetDay: 'journal:getDay',
  journalUpsert: 'journal:upsert',
  journalDelete: 'journal:delete',
  journalDraftWithGemini: 'journal:draftWithGemini',
  journalCopyDayToClipboard: 'journal:copyDayToClipboard',
  journalSaveMarkdownRange: 'journal:saveMarkdownRange',
  reviewGetDay: 'review:getDay',
  reviewApplyRating: 'review:applyRating',
  storageGetUsage: 'storage:getUsage',
  storagePurgeNow: 'storage:purgeNow',
  storageResolveFileUrl: 'storage:resolveFileUrl',
  askRun: 'ask:run',
  dashboardGet: 'dashboard:get'
} as const

export const IPC_EVENTS = {
  recordingStateChanged: 'event:recordingStateChanged',
  captureError: 'event:captureError',
  analysisBatchUpdated: 'event:analysisBatchUpdated',
  timelineUpdated: 'event:timelineUpdated',
  storageUsageUpdated: 'event:storageUsageUpdated',
  navigate: 'event:navigate'
} as const

export type IpcChannel = IpcContractKey
type IpcContractKey = keyof IpcContract
