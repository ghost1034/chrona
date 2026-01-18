import path from 'node:path'
import { BrowserWindow } from 'electron'

export async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1120,
    height: 720,
    show: false,
    backgroundColor: '#0e1116',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  })

  await loadRenderer(win)

  win.once('ready-to-show', () => {
    win.show()
  })

  return win
}

async function loadRenderer(win: BrowserWindow) {
  const devUrl = process.env.DAYFLOW_DEV_SERVER_URL
  if (devUrl) {
    await win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
    return
  }

  const indexHtml = path.join(__dirname, '..', 'renderer', 'index.html')
  await win.loadFile(indexHtml)
}
