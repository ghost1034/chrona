import crypto from 'node:crypto'
import path from 'node:path'
import { BrowserWindow, globalShortcut, screen } from 'electron'
import type { BlurRegion, NormalizedRect } from '../../shared/blurRegions'
import { IPC_EVENTS } from '../../shared/ipc'
import type { Logger } from '../logger'
import type { SettingsStore } from '../settings'

type EventSink = {
  blurRegionsChanged: () => void
}

export class BlurService {
  private readonly settings: SettingsStore
  private readonly log: Logger
  private readonly events: EventSink

  private readonly overlays = new Map<string, BrowserWindow>()
  private registeredHotkey: string | null = null
  private displayRemovedHooked = false

  constructor(opts: { settings: SettingsStore; log: Logger; events: EventSink }) {
    this.settings = opts.settings
    this.log = opts.log
    this.events = opts.events
  }

  async listRegions(): Promise<BlurRegion[]> {
    const s = await this.settings.getAll()
    return s.blurRegions
  }

  async addRegion(req: {
    displayId: string
    rect: NormalizedRect
    label?: string
  }): Promise<BlurRegion> {
    const region: BlurRegion = {
      id: 'blur_' + crypto.randomUUID().slice(0, 8),
      displayId: req.displayId,
      rect: req.rect,
      label: req.label,
      createdAtMs: Date.now()
    }
    const s = await this.settings.getAll()
    await this.settings.update({ blurRegions: [...s.blurRegions, region] })
    this.log.info('blur.regionAdded', { id: region.id, displayId: region.displayId })
    this.events.blurRegionsChanged()
    this.broadcastToOverlays()
    return region
  }

  async removeRegion(id: string): Promise<void> {
    const s = await this.settings.getAll()
    const next = s.blurRegions.filter((r) => r.id !== id)
    if (next.length === s.blurRegions.length) return
    await this.settings.update({ blurRegions: next })
    this.log.info('blur.regionRemoved', { id })
    this.events.blurRegionsChanged()
    this.broadcastToOverlays()
  }

  async setHotkey(accelerator: string): Promise<{ ok: boolean; message: string | null }> {
    const trimmed = accelerator.trim()
    if (trimmed) {
      // Trial-register to validate the accelerator before persisting it.
      this.unregisterHotkey()
      let registered = false
      try {
        registered = globalShortcut.register(trimmed, () => void this.openOverlays())
      } catch {
        registered = false
      }
      if (!registered) {
        // Restore the previous hotkey, if any.
        await this.refreshHotkey()
        return {
          ok: false,
          message: 'Could not register that shortcut. It may be invalid or already in use.'
        }
      }
      globalShortcut.unregister(trimmed)
    }
    await this.settings.update({ blurHotkey: trimmed })
    await this.refreshHotkey()
    return { ok: true, message: null }
  }

  async refreshHotkey(): Promise<void> {
    this.unregisterHotkey()
    const s = await this.settings.getAll()
    const accel = s.blurHotkey.trim()
    if (!accel) return
    try {
      if (globalShortcut.register(accel, () => void this.openOverlays())) {
        this.registeredHotkey = accel
        this.log.info('blur.hotkeyRegistered', { accelerator: accel })
      } else {
        this.log.warn('blur.hotkeyRegisterFailed', { accelerator: accel })
      }
    } catch (e) {
      this.log.warn('blur.hotkeyRegisterFailed', {
        accelerator: accel,
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }

  async openOverlays(): Promise<void> {
    this.hookDisplayRemoved()
    for (const display of screen.getAllDisplays()) {
      const displayId = String(display.id)
      const existing = this.overlays.get(displayId)
      if (existing && !existing.isDestroyed()) {
        existing.focus()
        continue
      }
      this.createOverlayWindow(display)
    }
  }

  closeOverlays(): void {
    for (const win of this.overlays.values()) {
      if (!win.isDestroyed()) win.close()
    }
    this.overlays.clear()
  }

  private createOverlayWindow(display: Electron.Display): void {
    const displayId = String(display.id)
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      show: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: path.join(__dirname, 'preload.cjs')
      }
    })

    win.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    // Keep the overlay itself out of screen captures.
    try {
      win.setContentProtection(true)
    } catch {
      // best-effort
    }

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    win.on('closed', () => {
      const current = this.overlays.get(displayId)
      if (current === win) this.overlays.delete(displayId)
    })

    this.overlays.set(displayId, win)

    void this.loadOverlay(win, displayId)
      .then(() => {
        if (!win.isDestroyed()) win.show()
      })
      .catch((e) => {
        this.log.error('blur.overlayLoadFailed', {
          displayId,
          message: e instanceof Error ? e.message : String(e)
        })
        if (!win.isDestroyed()) win.close()
      })
  }

  private async loadOverlay(win: BrowserWindow, displayId: string): Promise<void> {
    const devUrl = process.env.CHRONA_DEV_SERVER_URL
    if (devUrl) {
      const base = devUrl.endsWith('/') ? devUrl.slice(0, -1) : devUrl
      await win.loadURL(`${base}/overlay.html?displayId=${encodeURIComponent(displayId)}`)
      return
    }
    const overlayHtml = path.join(__dirname, '..', 'renderer', 'overlay.html')
    await win.loadFile(overlayHtml, { query: { displayId } })
  }

  private broadcastToOverlays(): void {
    // The main window is notified via events.blurRegionsChanged; overlays are
    // separate windows and need their own send.
    for (const win of this.overlays.values()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.blurRegionsChanged)
    }
  }

  private hookDisplayRemoved(): void {
    if (this.displayRemovedHooked) return
    this.displayRemovedHooked = true
    screen.on('display-removed', (_event, display) => {
      const win = this.overlays.get(String(display.id))
      if (win && !win.isDestroyed()) win.close()
    })
  }

  private unregisterHotkey(): void {
    if (this.registeredHotkey) {
      try {
        globalShortcut.unregister(this.registeredHotkey)
      } catch {
        // ignore
      }
      this.registeredHotkey = null
    }
  }
}
