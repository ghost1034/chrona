import type { Logger } from '../logger'
import type { SettingsStore } from '../settings'
import type { StorageService, SyncCardRow } from '../storage/storage'
import type { SyncStatusDTO } from '../../shared/sync'
import { deleteDeviceToken, getDeviceToken, setDeviceToken } from './deviceToken'
import { SyncClient, SyncHttpError, normalizeEndpoint, type SyncCardPayload } from './syncClient'

const BATCH_CAP = 500
const MAX_BATCHES_PER_TICK = 20
const DEBOUNCE_MS = 5_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 5 * 60_000
const FULL_RECONCILE_INTERVAL_SEC = 60 * 60
const MIN_INTERVAL_SECONDS = 30

const META_DEVICE_ID = 'device_id'
const META_DISPLAY_NAME = 'device_display_name'
const META_LAST_SYNC_TS = 'last_sync_ts'
const META_LAST_FULL_RECONCILE_TS = 'last_full_reconcile_ts'

type Events = {
  syncStatusChanged: (status: SyncStatusDTO) => void
}

/**
 * Pushes timeline cards to a paired CPAAutomation backend.
 *
 * Change detection is hash-diff based (sync_state sidecar, see storage.ts):
 * each tick reconciles sync_state incrementally, with a full reconciliation
 * scan hourly to catch in-place edits of old cards. Failures leave sync_state
 * dirty, so the engine is offline-tolerant by construction.
 */
export class SyncService {
  private readonly storage: StorageService
  private readonly settings: SettingsStore
  private readonly log: Logger
  private readonly events: Events
  private readonly platform: string
  private readonly appVersion: string

  private timer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private started = false

  private tickInFlight: Promise<void> | null = null
  private rerunRequested = false

  private token: string | null = null
  private deviceId: string | null = null
  private displayName: string | null = null
  private cachedEnabled = false
  private cachedEndpoint = ''
  private syncing = false
  private lastSyncTs: number | null = null
  private pendingCount = 0
  private lastError: string | null = null
  private consecutiveFailures = 0

  constructor(opts: {
    storage: StorageService
    settings: SettingsStore
    log: Logger
    events: Events
    platform: string
    appVersion: string
  }) {
    this.storage = opts.storage
    this.settings = opts.settings
    this.log = opts.log
    this.events = opts.events
    this.platform = opts.platform
    this.appVersion = opts.appVersion
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.token = await getDeviceToken().catch(() => null)
    this.deviceId = await this.storage.getSyncMeta(META_DEVICE_ID).catch(() => null)
    this.displayName = await this.storage.getSyncMeta(META_DISPLAY_NAME).catch(() => null)
    const lastSyncRaw = await this.storage.getSyncMeta(META_LAST_SYNC_TS).catch(() => null)
    this.lastSyncTs = lastSyncRaw ? Number(lastSyncRaw) || null : null
    this.pendingCount = await this.storage.countPendingSync().catch(() => 0)

    await this.scheduleTimer()
    this.emitStatus()

    // Drain any backlog accumulated while the app was closed.
    void this.runTick({ heartbeat: true })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.timer = null
    this.debounceTimer = null
    this.retryTimer = null
    this.started = false
  }

  rescheduleFromSettings(): void {
    void this.scheduleTimer()
  }

  /** Debounced trigger from AnalysisService's timelineUpdated event. */
  notifyTimelineUpdated(): void {
    this.scheduleDebouncedSync()
  }

  /**
   * Targeted hook for the known in-place edit path (updateCardCategory) so
   * edits sync promptly instead of waiting for the hourly full reconcile.
   */
  notifyCardEdited(cardId: number): void {
    void this.storage
      .reconcileSyncCardById(cardId)
      .then(() => this.scheduleDebouncedSync())
      .catch((e) => {
        this.log.warn('sync.reconcileCardFailed', { cardId, message: errMessage(e) })
      })
  }

  async getStatus(): Promise<SyncStatusDTO> {
    const s = await this.settings.getAll()
    this.cachedEnabled = !!s.syncEnabled
    this.cachedEndpoint = s.syncEndpoint ?? ''
    this.pendingCount = await this.storage.countPendingSync().catch(() => this.pendingCount)
    return this.snapshot()
  }

  async pair(opts: { code: string; endpoint?: string }): Promise<SyncStatusDTO> {
    const code = String(opts.code ?? '').trim()
    if (!code) throw new Error('Pairing code is required')

    // Don't let an in-flight tick ack cards across the resetSyncState below.
    await this.awaitInFlightTick()

    if (opts.endpoint !== undefined) {
      const normalized = normalizeEndpoint(opts.endpoint)
      await this.settings.update({ syncEndpoint: normalized })
    }

    const s = await this.settings.getAll()
    if (!s.syncEndpoint) throw new Error('Sync server URL is required')

    const client = new SyncClient({ endpoint: s.syncEndpoint })
    const res = await client.pair({
      code,
      platform: this.platform,
      appVersion: this.appVersion
    })

    await setDeviceToken(res.deviceToken)
    this.token = res.deviceToken
    this.deviceId = res.deviceId
    this.displayName = res.displayName
    await this.storage.setSyncMeta(META_DEVICE_ID, res.deviceId)
    await this.storage.setSyncMeta(META_DISPLAY_NAME, res.displayName)

    // This is a brand-new device row server-side — any previous acks are
    // meaningless, so re-push the full timeline.
    await this.storage.resetSyncState()

    await this.settings.update({ syncEnabled: true })
    this.cachedEnabled = true
    this.cachedEndpoint = s.syncEndpoint
    this.lastError = null
    this.consecutiveFailures = 0
    this.clearRetry()

    this.log.info('sync.paired', { deviceId: res.deviceId, displayName: res.displayName })
    this.emitStatus()

    void this.runTick({ fullReconcile: true })
    return this.getStatus()
  }

  async unpair(): Promise<SyncStatusDTO> {
    // Don't let an in-flight tick ack cards across the resetSyncState below.
    await this.awaitInFlightTick()

    await deleteDeviceToken().catch(() => undefined)
    this.token = null
    this.deviceId = null
    this.displayName = null
    this.lastError = null
    this.consecutiveFailures = 0
    this.clearRetry()

    await this.storage.setSyncMeta(META_DEVICE_ID, null)
    await this.storage.setSyncMeta(META_DISPLAY_NAME, null)
    await this.storage.setSyncMeta(META_LAST_SYNC_TS, null)
    await this.storage.resetSyncState()
    this.lastSyncTs = null

    await this.settings.update({ syncEnabled: false })
    this.cachedEnabled = false

    this.log.info('sync.unpaired', {})
    this.emitStatus()
    return this.getStatus()
  }

  async setEnabled(enabled: boolean): Promise<SyncStatusDTO> {
    await this.settings.update({ syncEnabled: !!enabled })
    this.cachedEnabled = !!enabled
    this.emitStatus()
    if (enabled) void this.runTick()
    return this.getStatus()
  }

  async runNow(): Promise<SyncStatusDTO> {
    await this.runTick({ fullReconcile: true, heartbeat: true })
    return this.getStatus()
  }

  private async awaitInFlightTick(): Promise<void> {
    this.rerunRequested = false
    while (this.tickInFlight) {
      await this.tickInFlight
    }
  }

  private async scheduleTimer(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    const s = await this.settings.getAll()
    const interval = Math.max(
      MIN_INTERVAL_SECONDS,
      Math.floor(Number(s.syncIntervalSeconds)) || 300
    )
    this.timer = setInterval(() => {
      void this.runTick({ heartbeat: true })
    }, interval * 1000)
  }

  private scheduleDebouncedSync(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.runTick()
    }, DEBOUNCE_MS)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    const exp = Math.min(
      BACKOFF_CAP_MS,
      BACKOFF_BASE_MS * 2 ** Math.max(0, this.consecutiveFailures - 1)
    )
    // Jitter to 50–100% of the exponential delay.
    const delay = Math.round(exp * (0.5 + Math.random() * 0.5))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.runTick()
    }, delay)
  }

  /** One sync pass; concurrent calls coalesce into a follow-up run. */
  private async runTick(opts?: { heartbeat?: boolean; fullReconcile?: boolean }): Promise<void> {
    if (this.tickInFlight) {
      this.rerunRequested = true
      await this.tickInFlight
      return
    }

    this.tickInFlight = this.tickOnce(opts).then(
      () => undefined,
      () => undefined
    )
    await this.tickInFlight
    this.tickInFlight = null

    if (this.rerunRequested) {
      this.rerunRequested = false
      void this.runTick()
    }
  }

  private async tickOnce(opts?: { heartbeat?: boolean; fullReconcile?: boolean }): Promise<void> {
    const s = await this.settings.getAll()
    this.cachedEnabled = !!s.syncEnabled
    this.cachedEndpoint = s.syncEndpoint ?? ''

    if (!this.token || !s.syncEnabled || !s.syncEndpoint) return

    this.syncing = true
    this.emitStatus()

    try {
      const nowSec = Math.floor(Date.now() / 1000)
      const lastFullRaw = await this.storage.getSyncMeta(META_LAST_FULL_RECONCILE_TS)
      const lastFull = Number(lastFullRaw ?? 0) || 0
      const full = !!opts?.fullReconcile || nowSec - lastFull >= FULL_RECONCILE_INTERVAL_SEC

      await this.storage.reconcileSyncState({ full })
      if (full) await this.storage.setSyncMeta(META_LAST_FULL_RECONCILE_TS, String(nowSec))

      const client = new SyncClient({ endpoint: s.syncEndpoint })
      const token = this.token
      let sentAnything = false

      for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
        const cards = await this.storage.getCardsToSync(BATCH_CAP)
        const deletedIds = await this.storage.getDeletedCardsToSync(BATCH_CAP)
        if (cards.length === 0 && deletedIds.length === 0) break

        const res = await client.pushCards({
          token,
          cards: cards.map(toSyncCardPayload),
          deletedSourceCardIds: deletedIds
        })

        await this.storage.markCardsSynced({
          synced: cards.map((c) => ({ cardId: c.cardId, contentHash: c.contentHash })),
          deletedCardIds: deletedIds
        })

        sentAnything = true
        this.log.info('sync.pushedBatch', {
          cards: cards.length,
          deleted: deletedIds.length,
          accepted: res.accepted,
          skippedUnchanged: res.skippedUnchanged
        })
      }

      // Nothing to push on a periodic tick → cheap heartbeat so the server's
      // last_seen_at stays fresh (and revocation is detected promptly).
      if (!sentAnything && opts?.heartbeat) {
        await client.ping({ token })
      }

      this.lastSyncTs = nowSec
      await this.storage.setSyncMeta(META_LAST_SYNC_TS, String(nowSec))
      this.lastError = null
      this.consecutiveFailures = 0
      this.clearRetry()
    } catch (e) {
      if (e instanceof SyncHttpError && e.status === 401) {
        // Token revoked server-side. Drop it; user must pair again.
        this.log.warn('sync.tokenRejected', {})
        await deleteDeviceToken().catch(() => undefined)
        this.token = null
        this.lastError = 'This device was unpaired by the server. Pair again to resume syncing.'
      } else {
        this.consecutiveFailures += 1
        this.lastError = errMessage(e)
        this.log.warn('sync.tickFailed', {
          message: this.lastError,
          consecutiveFailures: this.consecutiveFailures
        })
        this.scheduleRetry()
      }
    } finally {
      this.pendingCount = await this.storage.countPendingSync().catch(() => this.pendingCount)
      this.syncing = false
      this.emitStatus()
    }
  }

  private snapshot(): SyncStatusDTO {
    return {
      paired: !!this.token,
      enabled: this.cachedEnabled,
      endpoint: this.cachedEndpoint,
      deviceId: this.deviceId,
      displayName: this.displayName,
      syncing: this.syncing,
      lastSyncTs: this.lastSyncTs,
      pendingCount: this.pendingCount,
      lastError: this.lastError
    }
  }

  private emitStatus(): void {
    try {
      this.events.syncStatusChanged(this.snapshot())
    } catch {
      // never let a renderer notification break the sync loop
    }
  }
}

function toSyncCardPayload(c: SyncCardRow): SyncCardPayload {
  return {
    source_card_id: c.cardId,
    content_hash: c.contentHash,
    title: c.title,
    summary: c.summary,
    detailed_summary: c.detailedSummary,
    // Server caps these at 64 chars (models/chrona.py); truncate, don't 422.
    category: c.category.slice(0, 64),
    subcategory: c.subcategory === null ? null : c.subcategory.slice(0, 64),
    start_ts: c.startTs,
    end_ts: c.endTs,
    day_key: c.dayKey,
    is_deleted: false,
    source_created_at: sqliteUtcToIso(c.createdAt)
  }
}

/** SQLite CURRENT_TIMESTAMP is UTC 'YYYY-MM-DD HH:MM:SS' — make that explicit. */
function sqliteUtcToIso(s: string | null): string | null {
  if (!s) return null
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(s.trim())
  if (m) return `${m[1]}T${m[2]}Z`
  return s
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
