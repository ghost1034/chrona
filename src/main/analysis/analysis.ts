import type { Logger } from '../logger'
import type { ClaimedAnalysisBatch, StorageService } from '../storage/storage'
import { createScreenshotBatches } from '../../shared/batching'
import { AIService } from '../ai/ai'
import type { SettingsStore } from '../settings'
import { isIncompleteLocalCardCoverage, isLocalRuntimeUnavailable } from '../ai/errors'
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
  private stopped = true
  private tickInFlight: Promise<{ createdBatchIds: number[]; unprocessedCount: number }> | null =
    null

  private processingInFlight: Promise<void> | null = null
  private startupRecoveryPending = true
  private readonly ai: AIService

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
    this.ai = new AIService({ storage: opts.storage, log: opts.log, settings: opts.settings })
  }

  start() {
    if (this.timer) return
    this.stopped = false
    this.startupRecoveryPending = true
    this.log.info('analysis.start', {})
    void this.drainPendingBatches()
    this.scheduleNextTick(0)
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  rescheduleFromSettings() {
    if (this.stopped) return
    void (async () => {
      const delayMs = await this.getNextCheckIntervalMs()
      this.scheduleNextTick(delayMs)
    })()
  }

  retryPendingFromSettings() {
    if (this.stopped) return
    void this.drainPendingBatches()
  }

  private scheduleNextTick(delayMs: number) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.onTimerTick()
    }, Math.max(0, Math.floor(delayMs)))
  }

  private async onTimerTick() {
    try {
      await this.runTickNow()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.log.error('analysis.tickFailed', { message })
    } finally {
      if (this.stopped) return
      const delayMs = await this.getNextCheckIntervalMs()
      this.scheduleNextTick(delayMs)
    }
  }

  private async getNextCheckIntervalMs(): Promise<number> {
    const s = await this.settings.getAll()
    const raw = Number(s.analysisCheckIntervalSeconds)
    const sec = clampNumber(raw, { min: 10, max: 10 * 60, fallback: 60 })
    return sec * 1000
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
    const cfg = await this.getAnalysisConfig()
    const nowSec = Math.floor(Date.now() / 1000)
    const sinceTs = nowSec - cfg.lookbackSec

    const unprocessed = await this.storage.fetchUnprocessedScreenshots({ sinceTs })
    const unprocessedCount = unprocessed.length
    if (unprocessedCount === 0) return { createdBatchIds: [], unprocessedCount }

    const batches = createScreenshotBatches(
      unprocessed.map((s) => ({ id: s.id, capturedAt: s.capturedAt })),
      { targetDurationSec: cfg.targetDurationSec, maxGapSec: cfg.maxGapSec }
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
      if (duration < cfg.minBatchDurationSec) {
        await this.storage.setBatchStatus({
          batchId,
          status: 'skipped_short',
          reason: `duration_lt_${cfg.minBatchDurationSec}s`
        })
        this.events.analysisBatchUpdated({
          batchId,
          status: 'skipped_short',
          reason: `duration_lt_${cfg.minBatchDurationSec}s`
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
    if (this.processingInFlight) return this.processingInFlight
    const processing = this.drainPendingBatchesSingleFlight()
    this.processingInFlight = processing
    try {
      await processing
    } finally {
      if (this.processingInFlight === processing) this.processingInFlight = null
    }
  }

  private async drainPendingBatchesSingleFlight(): Promise<void> {
    if (this.startupRecoveryPending) {
      this.startupRecoveryPending = false
      const recovered = await this.storage.recoverInterruptedAnalysisBatches()
      for (const batchId of recovered.pendingBatchIds) {
        this.events.analysisBatchUpdated({ batchId, status: 'pending', reason: null })
      }
      for (const batchId of recovered.transcribedBatchIds) {
        this.events.analysisBatchUpdated({ batchId, status: 'transcribed', reason: null })
      }
      if (recovered.pendingBatchIds.length > 0 || recovered.transcribedBatchIds.length > 0) {
        this.log.info('analysis.recoveredInterruptedBatches', {
          pendingBatchIds: recovered.pendingBatchIds,
          transcribedBatchIds: recovered.transcribedBatchIds
        })
      }
    }
    const providerStatus = await this.ai.getProviderStatus()
    if (!providerStatus.configured) {
      this.log.warn('analysis.aiNotConfigured', { provider: providerStatus.provider })
      return
    }

    while (true) {
      const claimed = await this.storage.claimNextAnalysisBatch()
      if (!claimed) return
      this.events.analysisBatchUpdated({
        batchId: claimed.batch.id,
        status: claimed.batch.status,
        reason: null
      })
      try {
        await this.processClaimedBatch(claimed)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const incompleteCardCoverage = isIncompleteLocalCardCoverage(e)
        if (incompleteCardCoverage) {
          this.log.warn('analysis.batchCardCoverageIncomplete', {
            batchId: claimed.batch.id,
            message
          })
        } else {
          this.log.error('analysis.batchFailed', { batchId: claimed.batch.id, message })
        }
        if (incompleteCardCoverage) {
          await this.storage.setBatchStatus({
            batchId: claimed.batch.id,
            status: 'transcribed',
            reason: message
          })
          this.events.analysisBatchUpdated({
            batchId: claimed.batch.id,
            status: 'transcribed',
            reason: message
          })
        } else if (isLocalRuntimeUnavailable(e)) {
          await this.storage.setBatchStatus({
            batchId: claimed.batch.id,
            status: claimed.resumeStatus,
            reason: message
          })
          this.events.analysisBatchUpdated({
            batchId: claimed.batch.id,
            status: claimed.resumeStatus,
            reason: message
          })
        } else {
          await this.failBatchWithSystemCard(claimed.batch.id, message)
        }
        return
      }
    }
  }

  private async processClaimedBatch(claimed: ClaimedAnalysisBatch): Promise<void> {
    const batch = claimed.batch
    if (claimed.resumeStatus === 'transcribed') {
      await this.generateCardsForBatch(batch.id)
      return
    }

    const screenshots = await this.storage.getBatchScreenshots(batch.id)
    if (screenshots.length === 0) {
      await this.storage.setBatchStatus({ batchId: batch.id, status: 'failed_empty', reason: 'empty' })
      this.events.analysisBatchUpdated({ batchId: batch.id, status: 'failed_empty', reason: 'empty' })
      return
    }

    const intervalSeconds = (await this.settings.getAll()).captureIntervalSeconds
    const res = await this.ai.transcribeBatch({
      batchId: batch.id,
      batchStartTs: batch.batchStartTs,
      batchEndTs: batch.batchEndTs,
      screenshots: screenshots.map((screen) => ({
        filePath: screen.filePath,
        capturedAt: screen.capturedAt
      })),
      screenshotIntervalSeconds: intervalSeconds
    })

    if (res.observationsInserted === 0) {
      await this.storage.setBatchStatus({ batchId: batch.id, status: 'analyzed', reason: '0_observations' })
      this.events.analysisBatchUpdated({ batchId: batch.id, status: 'analyzed', reason: '0_observations' })
      return
    }

    const reason = `observations=${res.observationsInserted}`
    await this.storage.setBatchStatus({ batchId: batch.id, status: 'transcribed', reason })
    this.events.analysisBatchUpdated({ batchId: batch.id, status: 'transcribed', reason })
  }

  private async generateCardsForBatch(batchId: number): Promise<void> {
    const batch = await this.storage.getBatch(batchId)
    if (!batch) return

    const cfg = await this.getAnalysisConfig()

    const windowEndTs = batch.batchEndTs
    const windowStartTs = Math.max(0, windowEndTs - cfg.windowLookbackSec)

    const observations = await this.storage.fetchObservationsInRange({
      startTs: windowStartTs,
      endTs: windowEndTs
    })

    const context = await this.storage.fetchCardsInRange({
      startTs: windowStartTs,
      endTs: windowEndTs,
      includeSystem: false
    })

    const cardsRes = await this.ai.generateCards({
      batchId,
      windowStartTs,
      windowEndTs,
      targetStartTs: batch.batchStartTs,
      targetEndTs: batch.batchEndTs,
      observations: observations.map((o) => ({
        startTs: o.startTs,
        endTs: o.endTs,
        observation: o.observation
      })),
      contextCards: context.map((c: any) => ({
        startTs: Number(c.start_ts),
        endTs: Number(c.end_ts),
        category: String(c.category),
        subcategory: c.subcategory ?? null,
        title: String(c.title),
        summary: c.summary ?? null
      }))
    })

    const replaceRes = await this.storage.replaceCardsInRange({
      fromTs: batch.batchStartTs,
      toTs: batch.batchEndTs,
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

    // Clean up any old timelapses from replaced or trimmed cards.
    void this.timelapse.deleteTimelapseFiles(replaceRes.removedVideoPaths)

    // Generate timelapses asynchronously for new cards and trimmed remnants.
    this.timelapse.enqueueCardIds([...replaceRes.insertedCardIds, ...replaceRes.trimmedCardIds])

    const affectedStartTs = Math.min(
      batch.batchStartTs,
      ...cardsRes.cards.map((card) => card.startTs)
    )
    const affectedEndTs = Math.max(
      batch.batchEndTs,
      ...cardsRes.cards.map((card) => card.endTs)
    )
    this.emitTimelineUpdatedForRange(affectedStartTs, affectedEndTs)

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
    this.timelapse.enqueueCardIds(replaceRes.trimmedCardIds)

    this.emitTimelineUpdatedForRange(batch.batchStartTs, batch.batchEndTs)
  }

  private emitTimelineUpdatedForRange(startTs: number, endTs: number) {
    const a = dayKeyFromUnixSeconds(startTs)
    const b = dayKeyFromUnixSeconds(endTs)
    this.events.timelineUpdated({ dayKey: a })
    if (b !== a) this.events.timelineUpdated({ dayKey: b })
  }

  private async getAnalysisConfig(): Promise<{
    lookbackSec: number
    targetDurationSec: number
    maxGapSec: number
    minBatchDurationSec: number
    windowLookbackSec: number
  }> {
    const s = await this.settings.getAll()

    const lookbackSec = clampNumber(Number(s.analysisLookbackSeconds), {
      min: 60 * 60,
      max: 7 * 24 * 60 * 60,
      fallback: 24 * 60 * 60
    })

    const targetDurationSec = clampNumber(Number(s.analysisBatchTargetDurationSec), {
      min: 5 * 60,
      max: 4 * 60 * 60,
      fallback: 30 * 60
    })

    const maxGapSec = clampNumber(Number(s.analysisBatchMaxGapSec), {
      min: 10,
      max: targetDurationSec,
      fallback: 5 * 60
    })

    const minBatchDurationSec = clampNumber(Number(s.analysisMinBatchDurationSec), {
      min: 60,
      max: targetDurationSec,
      fallback: 5 * 60
    })

    const windowLookbackSec = clampNumber(Number(s.analysisCardWindowLookbackSec), {
      min: 10 * 60,
      max: 6 * 60 * 60,
      fallback: 60 * 60
    })

    return {
      lookbackSec,
      targetDurationSec,
      maxGapSec,
      minBatchDurationSec,
      windowLookbackSec
    }
  }
}

function clampNumber(n: number, opts: { min: number; max: number; fallback: number }): number {
  if (!Number.isFinite(n)) return opts.fallback
  if (n < opts.min) return opts.min
  if (n > opts.max) return opts.max
  return Math.floor(n)
}
