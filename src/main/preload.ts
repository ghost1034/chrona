import { contextBridge, ipcRenderer } from 'electron'
import type { IpcContract } from '../shared/ipc'

type Invoke = <K extends keyof IpcContract>(
  channel: K,
  req: IpcContract[K]['req']
) => Promise<IpcContract[K]['res']>

const invoke: Invoke = (channel, req) => ipcRenderer.invoke(channel, req)

contextBridge.exposeInMainWorld('chrona', {
  ping: () => invoke('app:ping', undefined),
  getSettings: () => invoke('settings:getAll', undefined),
  updateSettings: (patch: IpcContract['settings:update']['req']) =>
    invoke('settings:update', patch)
})

type InvokeResult<K extends keyof IpcContract> = Promise<IpcContract[K]['res']>

export type ChronaApi = {
  ping: () => InvokeResult<'app:ping'>
  getSettings: () => InvokeResult<'settings:getAll'>
  updateSettings: (patch: IpcContract['settings:update']['req']) =>
    InvokeResult<'settings:update'>
}
