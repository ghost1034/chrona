import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, shell } from 'electron'

function isSafeExternalUrl(urlString: string): boolean {
  try {
    const u = new URL(urlString)
    const p = u.protocol.toLowerCase()
    return p === 'http:' || p === 'https:' || p === 'mailto:'
  } catch {
    return false
  }
}

function isAllowedAppNavigationUrl(urlString: string): boolean {
  const devUrl = process.env.CHRONA_DEV_SERVER_URL
  if (devUrl) {
    try {
      const devOrigin = new URL(devUrl).origin
      return urlString.startsWith(devOrigin)
    } catch {
      // fall through
    }
  }

  // In prod, the renderer is loaded from a file URL.
  const indexHtml = path.join(__dirname, '..', 'renderer', 'index.html')
  const indexHref = pathToFileURL(indexHtml).href
  if (urlString === indexHref || urlString.startsWith(indexHref + '#')) return true

  // Allow our app-controlled media protocol.
  return urlString.startsWith('chrona-media:')
}

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

  // Keep links from navigating inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigationUrl(url)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })

  await loadRenderer(win)

  win.once('ready-to-show', () => {
    win.show()
  })

  return win
}

async function loadRenderer(win: BrowserWindow) {
  const devUrl = process.env.CHRONA_DEV_SERVER_URL
  if (devUrl) {
    await win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
    return
  }

  const indexHtml = path.join(__dirname, '..', 'renderer', 'index.html')
  await win.loadFile(indexHtml)
}
