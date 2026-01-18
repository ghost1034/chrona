import { ipcMain } from 'electron'
import type { IpcContract } from '../shared/ipc'
import { SettingsStore } from './settings'

type Handler<K extends keyof IpcContract> = (
  req: IpcContract[K]['req']
) => Promise<IpcContract[K]['res']> | IpcContract[K]['res']

export function registerIpc(opts: { settings: SettingsStore }) {
  handle('app:ping', async () => ({ ok: true, nowTs: Math.floor(Date.now() / 1000) }))
  handle('settings:getAll', async () => opts.settings.getAll())
  handle('settings:update', async (patch) => opts.settings.update(patch ?? {}))
}

function handle<K extends keyof IpcContract>(channel: K, fn: Handler<K>) {
  ipcMain.handle(channel, async (_event, req: IpcContract[K]['req']) => fn(req))
}
