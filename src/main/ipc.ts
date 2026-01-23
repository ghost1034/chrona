import { ipcMain } from 'electron'
import type { IpcContract } from '../shared/ipc'
import { SettingsStore } from './settings'
import type { CaptureService } from './capture/capture'
import type { StorageService } from './storage/storage'
import { shell } from 'electron'
import type { AnalysisService } from './analysis/analysis'
import { getGeminiApiKey, setGeminiApiKey } from './gemini/keychain'

type Handler<K extends keyof IpcContract> = (
  req: IpcContract[K]['req']
) => Promise<IpcContract[K]['res']> | IpcContract[K]['res']

export function registerIpc(opts: {
  settings: SettingsStore
  capture: CaptureService
  storage: StorageService
  analysis: AnalysisService
}) {
  handle('app:ping', async () => ({ ok: true, nowTs: Math.floor(Date.now() / 1000) }))
  handle('settings:getAll', async () => opts.settings.getAll())
  handle('settings:update', async (patch) => opts.settings.update(patch ?? {}))

  handle('capture:getState', async () => opts.capture.getState())
  handle('capture:setEnabled', async (req) => opts.capture.setEnabled(req.enabled))
  handle('capture:setInterval', async (req) => opts.capture.setIntervalSeconds(req.intervalSeconds))
  handle('capture:setSelectedDisplay', async (req) => opts.capture.setSelectedDisplay(req.displayId))
  handle('capture:listDisplays', async () => opts.capture.listDisplays())

  handle('debug:openRecordingsFolder', async () => {
    const p = opts.storage.resolveRelPath('recordings')
    await shell.openPath(p)
    return { ok: true }
  })

  // Phase 5 debug helpers
  handle('analysis:runTick', async () => opts.analysis.runTickNow())
  handle('analysis:getRecentBatches', async (req) =>
    opts.storage.fetchRecentBatches(req?.limit ?? 25)
  )

  handle('gemini:setApiKey', async (req) => {
    await setGeminiApiKey(req.apiKey)
    return { ok: true }
  })
  handle('gemini:hasApiKey', async () => {
    const k = await getGeminiApiKey()
    return { hasApiKey: !!k }
  })
}

function handle<K extends keyof IpcContract>(channel: K, fn: Handler<K>) {
  ipcMain.handle(channel, async (_event, req: IpcContract[K]['req']) => fn(req))
}
