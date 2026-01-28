import fs from 'node:fs/promises'
import type { Logger } from '../logger'
import type { SettingsStore } from '../settings'
import type { StorageService } from '../storage/storage'
import { buildTimelapseFromJpegs } from './ffmpeg'
import { dayKeyFromUnixSeconds } from '../../shared/time'

export class TimelapseService {
  private readonly storage: StorageService
  private readonly settings: SettingsStore
  private readonly log: Logger
  private readonly events: { timelineUpdated: (payload: { dayKey: string }) => void }

  private queue: number[] = []
  private inQueue = new Set<number>()
  private running = false
  private drainPromise: Promise<void> | null = null

  constructor(opts: {
    storage: StorageService
    settings: SettingsStore
    log: Logger
    events: { timelineUpdated: (payload: { dayKey: string }) => void }
  }) {
    this.storage = opts.storage
    this.settings = opts.settings
    this.log = opts.log
    this.events = opts.events
  }

  enqueueCardIds(cardIds: number[]): void {
    for (const id of cardIds) {
      if (this.inQueue.has(id)) continue
      this.inQueue.add(id)
      this.queue.push(id)
    }
    this.drainPromise = this.drainPromise ?? this.drain()
  }

  async waitForIdle(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 50))
    }
    if (this.drainPromise) await this.drainPromise
  }

  async deleteTimelapseFiles(relPaths: string[]): Promise<void> {
    await Promise.all(
      relPaths.map(async (p) => {
        try {
          await fs.unlink(this.storage.resolveRelPath(p))
        } catch {
          // ignore
        }
      })
    )
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const s = await this.settings.getAll()
      if (!s.timelapsesEnabled) {
        // Drop backlog by default; user can regenerate via future enhancements.
        this.queue = []
        this.inQueue.clear()
        return
      }

      while (this.queue.length > 0) {
        const id = this.queue.shift()!
        this.inQueue.delete(id)
        try {
          await this.generateForCardId(id, s.timelapseFps)
        } catch (e) {
          this.log.warn('timelapse.failed', {
            cardId: id,
            message: e instanceof Error ? e.message : String(e)
          })
        }
      }
    } finally {
      this.running = false
      this.drainPromise = null
    }
  }

  private async generateForCardId(cardId: number, fps: number): Promise<void> {
    const card = await this.storage.fetchTimelineCardById(cardId)
    if (!card) return
    if (card.isDeleted) return
    if (card.category === 'System') return

    const existing = card.videoSummaryUrl
    if (existing) {
      try {
        await fs.stat(this.storage.resolveRelPath(existing))
        return
      } catch {
        // proceed to regenerate
      }
    }

    const shots = await this.storage.fetchScreenshotsInRange({
      startTs: card.startTs,
      endTs: card.endTs
    })

    if (shots.length < 2) return

    const dayKey = card.dayKey || dayKeyFromUnixSeconds(card.startTs)
    const relOut = `timelapses/${dayKey}/${cardId}.mp4`
    const absOut = this.storage.resolveRelPath(relOut)

    const absInputs = shots.map((s) => this.storage.resolveRelPath(s.filePath))

    this.log.info('timelapse.start', { cardId, frames: absInputs.length })
    try {
      await buildTimelapseFromJpegs({
        inputJpegPaths: absInputs,
        outMp4Path: absOut,
        fps,
        targetHeight: 720
      })

      await this.storage.updateTimelineCardVideoSummaryUrl({ cardId, relPath: relOut })
      this.log.info('timelapse.done', { cardId, relOut })
      this.events.timelineUpdated({ dayKey })
    } catch (e) {
      // Don't allow timelapse failures to crash the app.
      this.log.warn('timelapse.encodeFailed', {
        cardId,
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }
}
