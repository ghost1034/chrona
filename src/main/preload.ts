import { contextBridge, ipcRenderer } from 'electron'
import type { IpcContract } from '../shared/ipc'
import { IPC_EVENTS } from '../shared/ipc'

type Invoke = <K extends keyof IpcContract>(
  channel: K,
  req: IpcContract[K]['req']
) => Promise<IpcContract[K]['res']>

const invoke: Invoke = (channel, req) => ipcRenderer.invoke(channel, req)

contextBridge.exposeInMainWorld('chrona', {
  ping: () => invoke('app:ping', undefined),
  getAutoStartEnabled: () => invoke('app:getAutoStart', undefined),
  setAutoStartEnabled: (enabled: boolean) => invoke('app:setAutoStart', { enabled }),
  openGeminiKeyPage: () => invoke('app:openGeminiKeyPage', undefined),
  openMacScreenRecordingSettings: () => invoke('app:openMacScreenRecordingSettings', undefined),
  relaunch: () => invoke('app:relaunch', undefined),
  getSetupStatus: () => invoke('setup:getStatus', undefined),
  getSettings: () => invoke('settings:getAll', undefined),
  updateSettings: (patch: IpcContract['settings:update']['req']) =>
    invoke('settings:update', patch),

  getCaptureState: () => invoke('capture:getState', undefined),
  setRecordingEnabled: (enabled: boolean) => invoke('capture:setEnabled', { enabled }),
  setCaptureInterval: (intervalSeconds: number) =>
    invoke('capture:setInterval', { intervalSeconds }),
  setSelectedDisplay: (displayId: string | null) =>
    invoke('capture:setSelectedDisplay', { displayId }),
  listDisplays: () => invoke('capture:listDisplays', undefined),
  probeCaptureAccess: () => invoke('capture:probeAccess', undefined),
  openRecordingsFolder: () => invoke('debug:openRecordingsFolder', undefined),

  runAnalysisTick: () => invoke('analysis:runTick', undefined),
  getRecentBatches: (limit: number) => invoke('analysis:getRecentBatches', { limit }),

  setGeminiApiKey: (apiKey: string) => invoke('gemini:setApiKey', { apiKey }),
  hasGeminiApiKey: () => invoke('gemini:hasApiKey', undefined),
  testGeminiApiKey: (apiKey?: string | null) => invoke('gemini:testApiKey', { apiKey }),

  getTimelineDay: (dayKey: string) => invoke('timeline:getDay', { dayKey }),
  searchTimeline: (req: IpcContract['timeline:search']['req']) => invoke('timeline:search', req),
  updateTimelineCardCategory: (opts: { cardId: number; category: string; subcategory?: string | null }) =>
    invoke('timeline:updateCardCategory', opts),
  copyDayToClipboard: (dayKey: string) => invoke('timeline:copyDayToClipboard', { dayKey }),
  saveMarkdownRange: (startDayKey: string, endDayKey: string) =>
    invoke('timeline:saveMarkdownRange', { startDayKey, endDayKey }),

  getJournalDay: (dayKey: string) => invoke('journal:getDay', { dayKey }),
  upsertJournalEntry: (dayKey: string, patch: IpcContract['journal:upsert']['req']['patch']) =>
    invoke('journal:upsert', { dayKey, patch }),
  deleteJournalEntry: (dayKey: string) => invoke('journal:delete', { dayKey }),
  draftJournalWithGemini: (
    dayKey: string,
    options?: { includeObservations?: boolean; includeReview?: boolean }
  ) => invoke('journal:draftWithGemini', { dayKey, options }),
  copyJournalDayToClipboard: (dayKey: string) => invoke('journal:copyDayToClipboard', { dayKey }),
  saveJournalMarkdownRange: (startDayKey: string, endDayKey: string) =>
    invoke('journal:saveMarkdownRange', { startDayKey, endDayKey }),

  getReviewDay: (dayKey: string) => invoke('review:getDay', { dayKey }),
  applyReviewRating: (startTs: number, endTs: number, rating: 'focus' | 'neutral' | 'distracted') =>
    invoke('review:applyRating', { startTs, endTs, rating }),

  getStorageUsage: () => invoke('storage:getUsage', undefined),
  purgeStorageNow: () => invoke('storage:purgeNow', undefined),
  resolveFileUrl: (relPath: string) => invoke('storage:resolveFileUrl', { relPath }),

  askChrona: (req: IpcContract['ask:run']['req']) => invoke('ask:run', req),

  getDashboardStats: (scope: { startTs: number; endTs: number }, options?: { includeSystem?: boolean }) =>
    invoke('dashboard:get', { scope, options }),

  onRecordingStateChanged: (cb: (state: IpcContract['capture:getState']['res']) => void) => {
    const listener = (_event: unknown, payload: IpcContract['capture:getState']['res']) => cb(payload)
    ipcRenderer.on(IPC_EVENTS.recordingStateChanged, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.recordingStateChanged, listener)
  },
  onCaptureError: (cb: (err: { message: string }) => void) => {
    const listener = (_event: unknown, payload: { message: string }) => cb(payload)
    ipcRenderer.on(IPC_EVENTS.captureError, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.captureError, listener)
  },

  onAnalysisBatchUpdated: (
    cb: (payload: { batchId: number; status: string; reason?: string | null }) => void
  ) => {
    const listener = (
      _event: unknown,
      payload: { batchId: number; status: string; reason?: string | null }
    ) => cb(payload)
    ipcRenderer.on(IPC_EVENTS.analysisBatchUpdated, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.analysisBatchUpdated, listener)
  },

  onTimelineUpdated: (cb: (payload: { dayKey: string }) => void) => {
    const listener = (_event: unknown, payload: { dayKey: string }) => cb(payload)
    ipcRenderer.on(IPC_EVENTS.timelineUpdated, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.timelineUpdated, listener)
  },

  onStorageUsageUpdated: (
    cb: (payload: {
      recordingsBytes: number
      timelapsesBytes: number
      recordingsLimitBytes: number
      timelapsesLimitBytes: number
    }) => void
  ) => {
    const listener = (
      _event: unknown,
      payload: {
        recordingsBytes: number
        timelapsesBytes: number
        recordingsLimitBytes: number
        timelapsesLimitBytes: number
      }
    ) => cb(payload)
    ipcRenderer.on(IPC_EVENTS.storageUsageUpdated, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.storageUsageUpdated, listener)
  },

  onNavigate: (cb: (payload: { view: string }) => void) => {
    const listener = (_event: unknown, payload: { view: string }) => cb(payload)
    ipcRenderer.on(IPC_EVENTS.navigate, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.navigate, listener)
  }
})

type InvokeResult<K extends keyof IpcContract> = Promise<IpcContract[K]['res']>

export type ChronaApi = {
  ping: () => InvokeResult<'app:ping'>
  getAutoStartEnabled: () => InvokeResult<'app:getAutoStart'>
  setAutoStartEnabled: (enabled: boolean) => InvokeResult<'app:setAutoStart'>
  openGeminiKeyPage: () => InvokeResult<'app:openGeminiKeyPage'>
  openMacScreenRecordingSettings: () => InvokeResult<'app:openMacScreenRecordingSettings'>
  relaunch: () => InvokeResult<'app:relaunch'>
  getSetupStatus: () => InvokeResult<'setup:getStatus'>
  getSettings: () => InvokeResult<'settings:getAll'>
  updateSettings: (patch: IpcContract['settings:update']['req']) =>
    InvokeResult<'settings:update'>

  getCaptureState: () => InvokeResult<'capture:getState'>
  setRecordingEnabled: (enabled: boolean) => InvokeResult<'capture:setEnabled'>
  setCaptureInterval: (intervalSeconds: number) => InvokeResult<'capture:setInterval'>
  setSelectedDisplay: (displayId: string | null) => InvokeResult<'capture:setSelectedDisplay'>
  listDisplays: () => InvokeResult<'capture:listDisplays'>
  probeCaptureAccess: () => InvokeResult<'capture:probeAccess'>
  openRecordingsFolder: () => InvokeResult<'debug:openRecordingsFolder'>

  runAnalysisTick: () => InvokeResult<'analysis:runTick'>
  getRecentBatches: (limit: number) => InvokeResult<'analysis:getRecentBatches'>

  setGeminiApiKey: (apiKey: string) => InvokeResult<'gemini:setApiKey'>
  hasGeminiApiKey: () => InvokeResult<'gemini:hasApiKey'>
  testGeminiApiKey: (apiKey?: string | null) => InvokeResult<'gemini:testApiKey'>

  getTimelineDay: (dayKey: string) => InvokeResult<'timeline:getDay'>
  searchTimeline: (req: IpcContract['timeline:search']['req']) => InvokeResult<'timeline:search'>
  updateTimelineCardCategory: (opts: {
    cardId: number
    category: string
    subcategory?: string | null
  }) => InvokeResult<'timeline:updateCardCategory'>
  copyDayToClipboard: (dayKey: string) => InvokeResult<'timeline:copyDayToClipboard'>
  saveMarkdownRange: (startDayKey: string, endDayKey: string) => InvokeResult<'timeline:saveMarkdownRange'>

  getJournalDay: (dayKey: string) => InvokeResult<'journal:getDay'>
  upsertJournalEntry: (
    dayKey: string,
    patch: IpcContract['journal:upsert']['req']['patch']
  ) => InvokeResult<'journal:upsert'>
  deleteJournalEntry: (dayKey: string) => InvokeResult<'journal:delete'>
  draftJournalWithGemini: (
    dayKey: string,
    options?: { includeObservations?: boolean; includeReview?: boolean }
  ) => InvokeResult<'journal:draftWithGemini'>
  copyJournalDayToClipboard: (dayKey: string) => InvokeResult<'journal:copyDayToClipboard'>
  saveJournalMarkdownRange: (startDayKey: string, endDayKey: string) => InvokeResult<'journal:saveMarkdownRange'>

  getReviewDay: (dayKey: string) => InvokeResult<'review:getDay'>
  applyReviewRating: (startTs: number, endTs: number, rating: 'focus' | 'neutral' | 'distracted') =>
    InvokeResult<'review:applyRating'>

  getStorageUsage: () => InvokeResult<'storage:getUsage'>
  purgeStorageNow: () => InvokeResult<'storage:purgeNow'>
  resolveFileUrl: (relPath: string) => InvokeResult<'storage:resolveFileUrl'>

  askChrona: (req: IpcContract['ask:run']['req']) => InvokeResult<'ask:run'>

  getDashboardStats: (
    scope: { startTs: number; endTs: number },
    options?: { includeSystem?: boolean }
  ) => InvokeResult<'dashboard:get'>

  onRecordingStateChanged: (
    cb: (state: IpcContract['capture:getState']['res']) => void
  ) => () => void
  onCaptureError: (cb: (err: { message: string }) => void) => () => void

  onAnalysisBatchUpdated: (
    cb: (payload: { batchId: number; status: string; reason?: string | null }) => void
  ) => () => void

  onTimelineUpdated: (cb: (payload: { dayKey: string }) => void) => () => void
  onStorageUsageUpdated: (cb: (payload: {
    recordingsBytes: number
    timelapsesBytes: number
    recordingsLimitBytes: number
    timelapsesLimitBytes: number
  }) => void) => () => void

  onNavigate: (cb: (payload: { view: string }) => void) => () => void
}
