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
import { RetentionService } from './retention/retention'
import { TimelapseService } from './timelapse/timelapse'
import { DeepLinkService, extractDeepLinksFromArgv } from './deeplink/deeplink'
import { applyAutoStart } from './autostart'
import { registerChronaMediaProtocol, registerChronaMediaScheme } from './mediaProtocol'
import { AskService } from './ask/ask'
import { DashboardService } from './dashboard/dashboard'
import { JournalService } from './journal/journal'

let quitting = false
let mainWindow: BrowserWindow | null = null
let pendingDeepLinks: string[] = []
let deepLinkHandler: ((url: string) => void) | null = null

// Must happen before app is ready.
try {
  registerChronaMediaScheme()
} catch {
  // ignore
}

// macOS can deliver deep links before app is ready.
app.on('open-url', (event, urlString) => {
  event.preventDefault()
  if (deepLinkHandler) deepLinkHandler(urlString)
  else pendingDeepLinks.push(urlString)
})

function ensureSingleInstance(): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) return false

  app.on('second-instance', (_event, argv) => {
    const urls = extractDeepLinksFromArgv(argv)
    if (urls.length > 0) {
      if (deepLinkHandler) urls.forEach((u) => deepLinkHandler?.(u))
      else pendingDeepLinks.push(...urls)
    }
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

  // Ensure Cmd+Q / dock Quit actually quits.
  // Without this, our window `close` handler treats the quit-driven close as a normal close
  // and hides the window instead of letting the app exit.
  app.on('before-quit', () => {
    quitting = true
  })

  await app.whenReady()

  const log = createLogger({ userDataPath: app.getPath('userData') })
  log.info('app.ready', { version: app.getVersion(), platform: process.platform })
  log.info('app.paths', { userData: app.getPath('userData') })

  const settings = new SettingsStore({ userDataPath: app.getPath('userData') })

  // Apply autostart setting early.
  const s0 = await settings.getAll()
  applyAutoStart(!!s0.autoStartEnabled, log)
  const storage = new StorageService({ userDataPath: app.getPath('userData') })
  await storage.init()

  // Make local timelapse files available to the renderer in dev/prod.
  // (http(s) -> file:// is blocked by Chromium, so use an app-controlled protocol)
  try {
    registerChronaMediaProtocol({ userDataPath: app.getPath('userData'), log })
  } catch (e) {
    log.warn('media.registerFailed', {
      message: e instanceof Error ? e.message : String(e)
    })
  }

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

  const deepLinks = new DeepLinkService({
    log,
    onAction: (action) => {
      switch (action) {
        case 'start-recording':
        case 'resume-recording':
          void capture.setEnabled(true)
          return
        case 'stop-recording':
        case 'pause-recording':
          void capture.setEnabled(false)
          return
      }
    }
  })

  deepLinkHandler = (urlString: string) => {
    deepLinks.handleUrl(urlString)
  }

  // Cold start deep link (Windows/Linux argv)
  pendingDeepLinks.push(...extractDeepLinksFromArgv(process.argv))
  if (pendingDeepLinks.length > 0) {
    pendingDeepLinks.forEach((u) => deepLinkHandler?.(u))
    pendingDeepLinks = []
  }

  // Best-effort protocol registration.
  try {
    if (process.defaultApp) {
      app.setAsDefaultProtocolClient('chrona', process.execPath, [process.argv[1]])
    } else {
      app.setAsDefaultProtocolClient('chrona')
    }
  } catch {
    // ignore
  }

  const timelapse = new TimelapseService({
    storage,
    settings,
    log,
    events: {
      timelineUpdated: (payload) => {
        win.webContents.send(IPC_EVENTS.timelineUpdated, payload)
      }
    }
  })

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
    settings,
    timelapse
  })
  analysis.start()

  const retention = new RetentionService({
    storage,
    settings,
    log,
    events: {
      storageUsageUpdated: (payload) => {
        win.webContents.send(IPC_EVENTS.storageUsageUpdated, payload)
      }
    }
  })
  retention.start()

  const ask = new AskService({ storage, log, settings })
  const dashboard = new DashboardService({ storage })
  const journal = new JournalService({ storage, log, settings })

  registerIpc({ settings, capture, storage, analysis, retention, ask, dashboard, journal, log })

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
    onOpenSettings: () => {
      win.show()
      win.focus()
      win.webContents.send(IPC_EVENTS.navigate, { view: 'settings' })
    },
    onOpenSetup: () => {
      win.show()
      win.focus()
      win.webContents.send(IPC_EVENTS.navigate, { view: 'onboarding' })
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
