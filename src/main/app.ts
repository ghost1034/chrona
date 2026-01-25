import type { BrowserWindow } from 'electron'
import { app, shell } from 'electron'
import { createTray } from './tray'
import { createMainWindow } from './window'
import { registerIpc } from './ipc'
import { SettingsStore } from './settings'
import { createLogger } from './logger'
import { StorageService } from './storage/storage'
import { CaptureService } from './capture/capture'
import { IPC_EVENTS } from '../shared/ipc'
import { AnalysisService } from './analysis/analysis'

let quitting = false
let mainWindow: BrowserWindow | null = null

function ensureSingleInstance(): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) return false

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  return true
}

async function main() {
  if (!ensureSingleInstance()) {
    app.quit()
    return
  }

  await app.whenReady()

  const log = createLogger({ userDataPath: app.getPath('userData') })
  log.info('app.ready', { version: app.getVersion(), platform: process.platform })
  log.info('app.paths', { userData: app.getPath('userData') })

  const settings = new SettingsStore({ userDataPath: app.getPath('userData') })
  const storage = new StorageService({ userDataPath: app.getPath('userData') })
  await storage.init()

  const win = await createMainWindow()
  mainWindow = win

  let trayCtl: ReturnType<typeof createTray> | null = null

  const capture = new CaptureService({
    settings,
    storage,
    log,
    events: {
      recordingStateChanged: (state) => {
        trayCtl?.updateMenu()
        win.webContents.send(IPC_EVENTS.recordingStateChanged, state)
      },
      captureError: (payload) => {
        trayCtl?.updateMenu()
        win.webContents.send(IPC_EVENTS.captureError, payload)
      }
    }
  })
  await capture.init()

  const analysis = new AnalysisService({
    storage,
    log,
    events: {
      analysisBatchUpdated: (payload) => {
        win.webContents.send(IPC_EVENTS.analysisBatchUpdated, payload)
      },
      timelineUpdated: (payload) => {
        win.webContents.send(IPC_EVENTS.timelineUpdated, payload)
      }
    },
    settings
  })
  analysis.start()

  registerIpc({ settings, capture, storage, analysis })

  win.webContents.on('render-process-gone', (_event, details) => {
    log.error('renderer.gone', { reason: details.reason, exitCode: details.exitCode })
  })

  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
  })

  trayCtl = createTray({
    getCaptureState: () => capture.getState(),
    onToggleRecording: (enabled) => {
      void capture.setEnabled(enabled)
    },
    onOpenRecordingsFolder: () => {
      const p = storage.resolveRelPath('recordings')
      void shell.openPath(p)
    },
    onOpen: () => {
      win.show()
      win.focus()
    },
    onQuit: () => {
      quitting = true
      trayCtl?.tray.destroy()
      log.info('app.quit')
      app.quit()
    }
  })

  trayCtl.updateMenu()

  app.on('activate', () => {
    if (!mainWindow) return
    mainWindow.show()
    mainWindow.focus()
  })
}

void main()
