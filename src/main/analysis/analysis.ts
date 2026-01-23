import type { Logger } from '../logger'
import type { StorageService } from '../storage/storage'
import { createScreenshotBatches } from '../../shared/batching'
import { GeminiService } from '../gemini/gemini'
import type { SettingsStore } from '../settings'
import { getGeminiApiKey } from '../gemini/keychain'

type Events = {
  analysisBatchUpdated: (payload: { batchId: number; status: string; reason?: string | null }) => void
}

export class AnalysisService {
  private readonly storage: StorageService
  private readonly log: Logger
  private readonly events: Events
  private readonly settings: SettingsStore

  private timer: NodeJS.Timeout | null = null
  private tickInFlight: Promise<{ createdBatchIds: number[]; unprocessedCount: number }> | null =
    null

  private readonly checkIntervalMs = 60_000
  private readonly lookbackSec = 24 * 60 * 60

  private readonly targetDurationSec = 30 * 60
  private readonly maxGapSec = 5 * 60
  private readonly minBatchDurationSec = 5 * 60

  private processingInFlight = false
  private processingBatchId: number | null = null
  private readonly gemini: GeminiService

  constructor(opts: { storage: StorageService; log: Logger; events: Events; settings: SettingsStore }) {
    this.storage = opts.storage
    this.log = opts.log
    this.events = opts.events
    this.settings = opts.settings
    this.gemini = new GeminiService({ storage: opts.storage, log: opts.log })
  }

  start() {
    if (this.timer) return
    this.log.info('analysis.start', { checkIntervalMs: this.checkIntervalMs })
    void this.runTickNow()
    void this.drainPendingBatches()
    this.timer = setInterval(() => {
      void this.runTickNow()
    }, this.checkIntervalMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async runTickNow(): Promise<{ createdBatchIds: number[]; unprocessedCount: number }> {
    if (this.tickInFlight) {
      await this.tickInFlight
      return { createdBatchIds: [], unprocessedCount: 0 }
    }

    const p = this.tick()
    this.tickInFlight = p
    try {
      return await p
    } finally {
      this.tickInFlight = null
    }
  }

  private async tick(): Promise<{ createdBatchIds: number[]; unprocessedCount: number }> {
    const nowSec = Math.floor(Date.now() / 1000)
    const sinceTs = nowSec - this.lookbackSec

    const unprocessed = await this.storage.fetchUnprocessedScreenshots({ sinceTs })
    const unprocessedCount = unprocessed.length
    if (unprocessedCount === 0) return { createdBatchIds: [], unprocessedCount }

    const batches = createScreenshotBatches(
      unprocessed.map((s) => ({ id: s.id, capturedAt: s.capturedAt })),
      { targetDurationSec: this.targetDurationSec, maxGapSec: this.maxGapSec }
    )

    const createdBatchIds: number[] = []
    for (const b of batches) {
      if (b.screenshotIds.length === 0) {
        // Should be impossible, but keep logic defensive.
        continue
      }

      const batchId = await this.storage.createBatchWithScreenshots({
        startTs: b.startTs,
        endTs: b.endTs,
        screenshotIds: b.screenshotIds
      })
      createdBatchIds.push(batchId)

      const persistedScreens = await this.storage.getBatchScreenshots(batchId)
      if (persistedScreens.length === 0) {
        await this.storage.setBatchStatus({
          batchId,
          status: 'failed_empty',
          reason: 'no_screenshots_linked'
        })
        this.events.analysisBatchUpdated({
          batchId,
          status: 'failed_empty',
          reason: 'no_screenshots_linked'
        })
        continue
      }

      const duration = b.endTs - b.startTs
      if (duration < this.minBatchDurationSec) {
        await this.storage.setBatchStatus({
          batchId,
          status: 'skipped_short',
          reason: `duration_lt_${this.minBatchDurationSec}s`
        })
        this.events.analysisBatchUpdated({
          batchId,
          status: 'skipped_short',
          reason: `duration_lt_${this.minBatchDurationSec}s`
        })
        continue
      }

      this.events.analysisBatchUpdated({ batchId, status: 'pending', reason: null })
    }

    this.log.info('analysis.tick', {
      unprocessedCount,
      createdBatches: createdBatchIds.length
    })

    // After creating batches, try processing pending ones.
    await this.drainPendingBatches()

    return { createdBatchIds, unprocessedCount }
  }

  private async drainPendingBatches(): Promise<void> {
    if (this.processingInFlight) return

    const apiKey = await getGeminiApiKey()
    if (!apiKey && !process.env.CHRONA_GEMINI_MOCK) {
      // Leave batches as pending; user can add a key later.
      this.log.warn('analysis.geminiKeyMissing')
      return
    }

    this.processingInFlight = true
    try {
      while (true) {
        const batch = await this.storage.fetchNextBatchByStatus('pending')
        if (!batch) return
        this.processingBatchId = batch.id

        const screenshots = await this.storage.getBatchScreenshots(batch.id)
        if (screenshots.length === 0) {
          await this.storage.setBatchStatus({
            batchId: batch.id,
            status: 'failed_empty',
            reason: 'empty'
          })
          this.events.analysisBatchUpdated({
            batchId: batch.id,
            status: 'failed_empty',
            reason: 'empty'
          })
          this.processingBatchId = null
          continue
        }

        await this.storage.setBatchStatus({
          batchId: batch.id,
          status: 'processing_transcribe',
          reason: null
        })
        this.events.analysisBatchUpdated({ batchId: batch.id, status: 'processing_transcribe' })

        const relPaths = screenshots.map((s) => s.filePath)
        const intervalSeconds = (await this.settings.getAll()).captureIntervalSeconds
        const res = await this.gemini.transcribeBatch({
          batchId: batch.id,
          batchStartTs: batch.batchStartTs,
          batchEndTs: batch.batchEndTs,
          screenshotRelPaths: relPaths,
          screenshotIntervalSeconds: intervalSeconds
        })

        await this.storage.setBatchStatus({
          batchId: batch.id,
          status: 'transcribed',
          reason: `observations=${res.observationsInserted}`
        })
        this.events.analysisBatchUpdated({
          batchId: batch.id,
          status: 'transcribed',
          reason: `observations=${res.observationsInserted}`
        })

        this.processingBatchId = null
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.log.error('analysis.transcribeFailed', { message })
      if (this.processingBatchId) {
        await this.storage.setBatchStatus({
          batchId: this.processingBatchId,
          status: 'failed',
          reason: message
        })
        this.events.analysisBatchUpdated({
          batchId: this.processingBatchId,
          status: 'failed',
          reason: message
        })
      }
    } finally {
      this.processingBatchId = null
      this.processingInFlight = false
    }
  }
}
