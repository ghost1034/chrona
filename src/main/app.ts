import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { createTray } from './tray'
import { createMainWindow } from './window'
import { registerIpc } from './ipc'
import { SettingsStore } from './settings'
import { createLogger } from './logger'
import { StorageService } from './storage/storage'

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

  const settings = new SettingsStore({ userDataPath: app.getPath('userData') })
  const storage = new StorageService({ userDataPath: app.getPath('userData') })
  await storage.init()

  registerIpc({ settings })

  const win = await createMainWindow()
  mainWindow = win

  win.webContents.on('render-process-gone', (_event, details) => {
    log.error('renderer.gone', { reason: details.reason, exitCode: details.exitCode })
  })

  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
  })

  const tray = createTray({
    onOpen: () => {
      win.show()
      win.focus()
    },
    onQuit: () => {
      quitting = true
      tray.destroy()
      log.info('app.quit')
      app.quit()
    }
  })

  app.on('activate', () => {
    if (!mainWindow) return
    mainWindow.show()
    mainWindow.focus()
  })
}

void main()
