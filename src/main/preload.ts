import { contextBridge, ipcRenderer } from 'electron'
import type { IpcContract } from '../shared/ipc'
import { IPC_EVENTS } from '../shared/ipc'

type Invoke = <K extends keyof IpcContract>(
  channel: K,
  req: IpcContract[K]['req']
) => Promise<IpcContract[K]['res']>

const invoke: Invoke = (channel, req) => ipcRenderer.invoke(channel, req)

contextBridge.exposeInMainWorld('dayflow', {
  ping: () => invoke('app:ping', undefined),
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
  openRecordingsFolder: () => invoke('debug:openRecordingsFolder', undefined),

  runAnalysisTick: () => invoke('analysis:runTick', undefined),
  getRecentBatches: (limit: number) => invoke('analysis:getRecentBatches', { limit }),

  setGeminiApiKey: (apiKey: string) => invoke('gemini:setApiKey', { apiKey }),
  hasGeminiApiKey: () => invoke('gemini:hasApiKey', undefined),

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
  }
})

type InvokeResult<K extends keyof IpcContract> = Promise<IpcContract[K]['res']>

export type DayflowApi = {
  ping: () => InvokeResult<'app:ping'>
  getSettings: () => InvokeResult<'settings:getAll'>
  updateSettings: (patch: IpcContract['settings:update']['req']) =>
    InvokeResult<'settings:update'>

  getCaptureState: () => InvokeResult<'capture:getState'>
  setRecordingEnabled: (enabled: boolean) => InvokeResult<'capture:setEnabled'>
  setCaptureInterval: (intervalSeconds: number) => InvokeResult<'capture:setInterval'>
  setSelectedDisplay: (displayId: string | null) => InvokeResult<'capture:setSelectedDisplay'>
  listDisplays: () => InvokeResult<'capture:listDisplays'>
  openRecordingsFolder: () => InvokeResult<'debug:openRecordingsFolder'>

  runAnalysisTick: () => InvokeResult<'analysis:runTick'>
  getRecentBatches: (limit: number) => InvokeResult<'analysis:getRecentBatches'>

  setGeminiApiKey: (apiKey: string) => InvokeResult<'gemini:setApiKey'>
  hasGeminiApiKey: () => InvokeResult<'gemini:hasApiKey'>

  onRecordingStateChanged: (
    cb: (state: IpcContract['capture:getState']['res']) => void
  ) => () => void
  onCaptureError: (cb: (err: { message: string }) => void) => () => void

  onAnalysisBatchUpdated: (
    cb: (payload: { batchId: number; status: string; reason?: string | null }) => void
  ) => () => void
}
