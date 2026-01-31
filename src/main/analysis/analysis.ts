import type { Logger } from '../logger'
import type { StorageService } from '../storage/storage'
import { createScreenshotBatches } from '../../shared/batching'
import { GeminiService } from '../gemini/gemini'
import type { SettingsStore } from '../settings'
import { getGeminiApiKey } from '../gemini/keychain'
import { dayKeyFromUnixSeconds } from '../../shared/time'
import type { TimelapseService } from '../timelapse/timelapse'

type Events = {
  analysisBatchUpdated: (payload: { batchId: number; status: string; reason?: string | null }) => void
  timelineUpdated: (payload: { dayKey: string }) => void
}

export class AnalysisService {
  private readonly storage: StorageService
  private readonly log: Logger
  private readonly events: Events
  private readonly settings: SettingsStore
  private readonly timelapse: TimelapseService

  private timer: NodeJS.Timeout | null = null
  private tickInFlight: Promise<{ createdBatchIds: number[]; unprocessedCount: number }> | null =
    null

  private readonly checkIntervalMs = 60_000
  private readonly lookbackSec = 24 * 60 * 60

  private readonly targetDurationSec = 10 * 60
  private readonly maxGapSec = 2 * 60
  private readonly minBatchDurationSec = 2 * 60

  private processingInFlight = false
  private processingBatchId: number | null = null
  private readonly gemini: GeminiService

  constructor(opts: {
    storage: StorageService
    log: Logger
    events: Events
    settings: SettingsStore
    timelapse: TimelapseService
  }) {
    this.storage = opts.storage
    this.log = opts.log
    this.events = opts.events
    this.settings = opts.settings
    this.timelapse = opts.timelapse
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
    if (!apiKey && !process.env.DAYFLOW_GEMINI_MOCK) {
      // Leave batches as pending; user can add a key later.
      this.log.warn('analysis.geminiKeyMissing')
      return
    }

    this.processingInFlight = true
    try {
      while (true) {
        const batch =
          (await this.storage.fetchNextBatchByStatus('pending')) ??
          (await this.storage.fetchNextBatchByStatus('transcribed'))
        if (!batch) return
        this.processingBatchId = batch.id

        if (batch.status === 'transcribed') {
          await this.generateCardsForBatch(batch.id)
          this.processingBatchId = null
          continue
        }

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

        if (res.observationsInserted === 0) {
          await this.storage.setBatchStatus({ batchId: batch.id, status: 'analyzed', reason: '0_observations' })
          this.events.analysisBatchUpdated({ batchId: batch.id, status: 'analyzed', reason: '0_observations' })
          this.processingBatchId = null
          continue
        }

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
      this.log.error('analysis.batchFailed', { message })
      if (this.processingBatchId) {
        await this.failBatchWithSystemCard(this.processingBatchId, message)
      }
    } finally {
      this.processingBatchId = null
      this.processingInFlight = false
    }
  }

  private async generateCardsForBatch(batchId: number): Promise<void> {
    const batch = await this.storage.getBatch(batchId)
    if (!batch) return

    const windowEndTs = batch.batchEndTs
    const windowStartTs = windowEndTs - 1200

    await this.storage.setBatchStatus({
      batchId,
      status: 'processing_generate_cards',
      reason: null
    })
    this.events.analysisBatchUpdated({ batchId, status: 'processing_generate_cards' })

    const observations = await this.storage.fetchObservationsInRange({
      startTs: windowStartTs,
      endTs: windowEndTs
    })

    const context = await this.storage.fetchCardsInRange({
      startTs: windowStartTs,
      endTs: windowEndTs,
      includeSystem: false
    })

    const cardsRes = await this.gemini.generateCards({
      batchId,
      windowStartTs,
      windowEndTs,
      observations: observations.map((o) => ({
        startTs: o.startTs,
        endTs: o.endTs,
        observation: o.observation
      })),
      contextCards: context.map((c: any) => ({
        startTs: Number(c.start_ts),
        endTs: Number(c.end_ts),
        category: String(c.category),
        title: String(c.title),
        summary: c.summary ?? null
      }))
    })

    const replaceRes = await this.storage.replaceCardsInRange({
      fromTs: windowStartTs,
      toTs: windowEndTs,
      batchId,
      newCards: cardsRes.cards.map((c) => ({
        startTs: c.startTs,
        endTs: c.endTs,
        category: c.category,
        subcategory: c.subcategory ?? null,
        title: c.title,
        summary: c.summary ?? null,
        detailedSummary: c.detailedSummary ?? null,
        metadata: c.metadata ?? null
      }))
    })

    // Clean up any old timelapses from replaced cards.
    void this.timelapse.deleteTimelapseFiles(replaceRes.removedVideoPaths)

    // Generate timelapses asynchronously for new cards.
    this.timelapse.enqueueCardIds(replaceRes.insertedCardIds)

    this.events.timelineUpdated({ dayKey: dayKeyFromUnixSeconds(windowEndTs) })

    await this.storage.setBatchStatus({ batchId, status: 'analyzed', reason: null })
    this.events.analysisBatchUpdated({ batchId, status: 'analyzed' })
  }

  private async failBatchWithSystemCard(batchId: number, reason: string) {
    const batch = await this.storage.getBatch(batchId)
    if (!batch) return

    await this.storage.setBatchStatus({ batchId, status: 'failed', reason })
    this.events.analysisBatchUpdated({ batchId, status: 'failed', reason })

    const replaceRes = await this.storage.replaceCardsInRange({
      fromTs: batch.batchStartTs,
      toTs: batch.batchEndTs,
      batchId,
      newCards: [
        {
          startTs: batch.batchStartTs,
          endTs: batch.batchEndTs,
          category: 'System',
          subcategory: 'Error',
          title: 'Processing failed',
          summary: reason,
          detailedSummary: null,
          metadata: null
        }
      ]
    })

    void this.timelapse.deleteTimelapseFiles(replaceRes.removedVideoPaths)

    this.events.timelineUpdated({ dayKey: dayKeyFromUnixSeconds(batch.batchEndTs) })
  }
}
