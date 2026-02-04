import type { DisplayInfo, CaptureState } from '../../shared/ipc'
import { desktopCapturer, powerMonitor, screen } from 'electron'
import type { Logger } from '../logger'
import type { SettingsStore } from '../settings'
import type { StorageService } from '../storage/storage'

type EventSink = {
  recordingStateChanged: (state: CaptureState) => void
  captureError: (payload: { message: string }) => void
}

export class CaptureService {
  private readonly settings: SettingsStore
  private readonly storage: StorageService
  private readonly log: Logger
  private readonly events: EventSink

  private desiredRecordingEnabled = false
  private isSystemPaused = false

  private intervalSeconds = 10
  private selectedDisplayId: string | null = null

  private resolvedDisplayId: string | null = null
  private pendingDisplayId: string | null = null
  private pendingDisplaySinceMs: number | null = null

  private timer: NodeJS.Timeout | null = null
  private nextTickAtMs: number | null = null
  private inFlight = false

  private lastCaptureTs: number | null = null
  private consecutiveFailures = 0
  private lastError: string | null = null

  private readonly displayHysteresisMs = 4000

  constructor(opts: {
    settings: SettingsStore
    storage: StorageService
    log: Logger
    events: EventSink
  }) {
    this.settings = opts.settings
    this.storage = opts.storage
    this.log = opts.log
    this.events = opts.events
  }

  async init(): Promise<void> {
    const s = await this.settings.getAll()
    this.intervalSeconds = s.captureIntervalSeconds
    this.selectedDisplayId = s.captureSelectedDisplayId

    powerMonitor.on('suspend', () => this.setSystemPaused(true))
    powerMonitor.on('resume', () => this.setSystemPaused(false))

    // Not all platforms support these.
    powerMonitor.on('lock-screen', () => this.setSystemPaused(true))
    powerMonitor.on('unlock-screen', () => this.setSystemPaused(false))

    this.emitState()
  }

  getState(): CaptureState {
    return {
      desiredRecordingEnabled: this.desiredRecordingEnabled,
      isSystemPaused: this.isSystemPaused,
      intervalSeconds: this.intervalSeconds,
      selectedDisplayId: this.selectedDisplayId,
      resolvedDisplayId: this.resolvedDisplayId,
      lastCaptureTs: this.lastCaptureTs,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError
    }
  }

  async setEnabled(enabled: boolean): Promise<CaptureState> {
    this.desiredRecordingEnabled = enabled
    this.log.info('capture.setEnabled', { enabled })
    this.updateRunningState()
    this.emitState()
    return this.getState()
  }

  async setIntervalSeconds(intervalSeconds: number): Promise<CaptureState> {
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error('intervalSeconds must be > 0')
    }

    const next = Math.max(1, Math.round(intervalSeconds))
    this.intervalSeconds = next
    await this.settings.update({ captureIntervalSeconds: next })
    this.log.info('capture.setIntervalSeconds', { intervalSeconds: next })

    // Restart scheduling to apply immediately.
    if (this.timer) this.stopLoop()
    this.updateRunningState()
    this.emitState()
    return this.getState()
  }

  async setSelectedDisplay(displayId: string | null): Promise<CaptureState> {
    this.selectedDisplayId = displayId
    await this.settings.update({ captureSelectedDisplayId: displayId })
    this.pendingDisplayId = null
    this.pendingDisplaySinceMs = null
    this.log.info('capture.setSelectedDisplay', { displayId })
    this.emitState()
    return this.getState()
  }

  listDisplays(): DisplayInfo[] {
    const displays = screen.getAllDisplays()
    return displays.map((d) => ({
      id: String(d.id),
      bounds: {
        x: d.bounds.x,
        y: d.bounds.y,
        width: d.bounds.width,
        height: d.bounds.height
      },
      scaleFactor: d.scaleFactor
    }))
  }

  private setSystemPaused(paused: boolean) {
    if (this.isSystemPaused === paused) return
    this.isSystemPaused = paused
    this.log.info('capture.systemPause', { paused })
    this.updateRunningState()
    this.emitState()
  }

  private updateRunningState() {
    const shouldRun = this.desiredRecordingEnabled && !this.isSystemPaused
    if (shouldRun && !this.timer) this.startLoop()
    if (!shouldRun && this.timer) this.stopLoop()
  }

  private startLoop() {
    this.consecutiveFailures = 0
    this.lastError = null
    this.nextTickAtMs = Date.now()
    this.scheduleNextTick()
    this.log.info('capture.loopStarted', { intervalSeconds: this.intervalSeconds })
  }

  private stopLoop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.nextTickAtMs = null
    this.inFlight = false
    this.log.info('capture.loopStopped')
  }

  private scheduleNextTick() {
    if (!this.desiredRecordingEnabled || this.isSystemPaused) return

    const now = Date.now()

    if (this.nextTickAtMs === null) this.nextTickAtMs = now
    if (this.nextTickAtMs < now) this.nextTickAtMs = now

    const delay = Math.max(0, this.nextTickAtMs - now)
    this.timer = setTimeout(() => {
      void this.onTick()
    }, delay)
  }

  private async onTick() {
    try {
      if (!this.desiredRecordingEnabled || this.isSystemPaused) return
      if (this.inFlight) {
        this.log.warn('capture.tickSkippedInFlight')
        return
      }

      this.inFlight = true
      await this.captureOnce()
      this.consecutiveFailures = 0
      this.lastError = null
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.consecutiveFailures += 1
      this.lastError = message
      this.log.error('capture.failed', { message, consecutiveFailures: this.consecutiveFailures })
      this.events.captureError({ message })

      if (this.consecutiveFailures >= 3) {
        // Avoid endless loops if permissions are missing or capture is consistently failing.
        this.desiredRecordingEnabled = false
        this.stopLoop()
        this.log.warn('capture.autoDisabledAfterFailures', {
          consecutiveFailures: this.consecutiveFailures
        })
      }
    } finally {
      this.inFlight = false
      this.emitState()

      // Advance based on intended schedule, not completion time.
      const intervalMs = this.intervalSeconds * 1000
      this.nextTickAtMs = (this.nextTickAtMs ?? Date.now()) + intervalMs

      this.scheduleNextTick()
    }
  }

  private async captureOnce(): Promise<void> {
    const capturedAtMs = Date.now()
    const displayId = this.resolveDisplayIdForCapture(capturedAtMs)
    this.resolvedDisplayId = displayId

    const targetSize = this.thumbnailSizeForDisplay(displayId)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: targetSize,
      fetchWindowIcons: false
    })

    const source = sources.find((s) => String(s.display_id) === displayId) ?? sources[0]
    if (!source) throw new Error('No screen sources available')

    const img = source.thumbnail
    if (img.isEmpty()) throw new Error('Capture thumbnail is empty')

    const jpegBytes = img.toJPEG(85)
    await this.storage.saveScreenshotJpeg({ capturedAtMs, jpegBytes })

    this.lastCaptureTs = Math.floor(capturedAtMs / 1000)
    this.log.debug('capture.saved', {
      capturedAtMs,
      displayId: this.resolvedDisplayId,
      bytes: jpegBytes.byteLength
    })
  }

  private resolveDisplayIdForCapture(nowMs: number): string {
    const displays = screen.getAllDisplays()
    const fallback = displays[0]
    if (!fallback) throw new Error('No displays detected')

    if (this.selectedDisplayId) {
      const match = displays.find((d) => String(d.id) === this.selectedDisplayId)
      return String(match?.id ?? fallback.id)
    }

    const cursor = screen.getCursorScreenPoint()
    const nearest = screen.getDisplayNearestPoint(cursor)
    const candidate = String(nearest.id)

    if (!this.resolvedDisplayId) {
      this.pendingDisplayId = null
      this.pendingDisplaySinceMs = null
      return candidate
    }

    if (candidate === this.resolvedDisplayId) {
      this.pendingDisplayId = null
      this.pendingDisplaySinceMs = null
      return this.resolvedDisplayId
    }

    if (this.pendingDisplayId !== candidate) {
      this.pendingDisplayId = candidate
      this.pendingDisplaySinceMs = nowMs
      return this.resolvedDisplayId
    }

    const since = this.pendingDisplaySinceMs ?? nowMs
    if (nowMs - since >= this.displayHysteresisMs) {
      this.pendingDisplayId = null
      this.pendingDisplaySinceMs = null
      return candidate
    }

    return this.resolvedDisplayId
  }

  private thumbnailSizeForDisplay(displayId: string): { width: number; height: number } {
    const displays = screen.getAllDisplays()
    const d = displays.find((x) => String(x.id) === displayId) ?? displays[0]
    if (!d) return { width: 1920, height: 1080 }

    const w = Math.max(1, d.size.width)
    const h = Math.max(1, d.size.height)
    const targetH = 1080
    const targetW = Math.round((w / h) * targetH)
    return { width: targetW, height: targetH }
  }

  private emitState() {
    this.events.recordingStateChanged(this.getState())
  }
}
