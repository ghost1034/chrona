import type { Logger } from '../logger'
import type { SettingsStore } from '../settings'
import type { StorageService } from '../storage/storage'

type Events = {
  storageUsageUpdated: (payload: {
    recordingsBytes: number
    timelapsesBytes: number
    recordingsLimitBytes: number
    timelapsesLimitBytes: number
  }) => void
}

export class RetentionService {
  private readonly storage: StorageService
  private readonly settings: SettingsStore
  private readonly log: Logger
  private readonly events: Events

  private purgeTimer: NodeJS.Timeout | null = null
  private usageTimer: NodeJS.Timeout | null = null
  private purgeInFlight: Promise<void> | null = null

  constructor(opts: { storage: StorageService; settings: SettingsStore; log: Logger; events: Events }) {
    this.storage = opts.storage
    this.settings = opts.settings
    this.log = opts.log
    this.events = opts.events
  }

  start() {
    if (this.purgeTimer || this.usageTimer) return

    // Emit usage early so the UI can show something immediately.
    void this.emitUsage()

    // Hourly purge.
    this.purgeTimer = setInterval(() => {
      void this.purgeIfNeeded()
    }, 60 * 60 * 1000)

    // Periodic usage updates.
    this.usageTimer = setInterval(() => {
      void this.emitUsage()
    }, 5 * 60 * 1000)
  }

  stop() {
    if (this.purgeTimer) clearInterval(this.purgeTimer)
    if (this.usageTimer) clearInterval(this.usageTimer)
    this.purgeTimer = null
    this.usageTimer = null
  }

  async getUsage(): Promise<{
    recordingsBytes: number
    timelapsesBytes: number
    recordingsLimitBytes: number
    timelapsesLimitBytes: number
  }> {
    const s = await this.settings.getAll()
    const recordingsBytes = await this.storage.getRecordingsUsageBytes()
    const timelapsesBytes = await this.storage.getTimelapsesUsageBytes()
    return {
      recordingsBytes,
      timelapsesBytes,
      recordingsLimitBytes: s.storageLimitRecordingsBytes,
      timelapsesLimitBytes: s.storageLimitTimelapsesBytes
    }
  }

  async purgeNow(): Promise<{
    deletedScreenshotCount: number
    deletedTimelapseCount: number
    freedRecordingsBytes: number
    freedTimelapsesBytes: number
    recordingsBytes: number
    timelapsesBytes: number
  }> {
    const s = await this.settings.getAll()

    const recordingsBefore = await this.storage.getRecordingsUsageBytes()
    const timelapsesBefore = await this.storage.getTimelapsesUsageBytes()

    const rec = await this.storage.purgeRecordingsToLimit(s.storageLimitRecordingsBytes)
    const tl = await this.storage.purgeTimelapsesToLimit(s.storageLimitTimelapsesBytes)

    await this.storage.purgeStragglers()

    const recordingsBytes = await this.storage.getRecordingsUsageBytes()
    const timelapsesBytes = await this.storage.getTimelapsesUsageBytes()

    this.log.info('retention.purgeNow', {
      recordingsBefore,
      timelapsesBefore,
      deletedScreenshotCount: rec.deletedCount,
      deletedTimelapseCount: tl.deletedCount,
      recordingsAfter: recordingsBytes,
      timelapsesAfter: timelapsesBytes
    })

    await this.emitUsage()

    return {
      deletedScreenshotCount: rec.deletedCount,
      deletedTimelapseCount: tl.deletedCount,
      freedRecordingsBytes: rec.freedBytes,
      freedTimelapsesBytes: tl.freedBytes,
      recordingsBytes,
      timelapsesBytes
    }
  }

  private async purgeIfNeeded(): Promise<void> {
    if (this.purgeInFlight) return
    this.purgeInFlight = this.purgeNow().then(
      () => undefined,
      () => undefined
    )
    await this.purgeInFlight
    this.purgeInFlight = null
  }

  private async emitUsage(): Promise<void> {
    try {
      const usage = await this.getUsage()
      this.events.storageUsageUpdated(usage)
    } catch (e) {
      this.log.warn('retention.usageFailed', { message: e instanceof Error ? e.message : String(e) })
    }
  }
}
