import fs from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from './schema'
import { dayKeyFromUnixSeconds, formatClockAscii } from '../../shared/time'
import type { JournalEntryDTO, JournalEntryPatch, JournalEntryStatus } from '../../shared/journal'
import type { TimelineSearchRequestDTO } from '../../shared/timeline'

export type ScreenshotRow = {
  id: number
  capturedAt: number
  filePath: string
  fileSize: number | null
  isDeleted: 0 | 1
}

export type TimelineCardRow = {
  id: number
  batchId: number | null
  startTs: number
  endTs: number
  dayKey: string
  title: string
  summary: string | null
  detailedSummary: string | null
  category: string
  subcategory: string | null
  metadata: string | null
  videoSummaryUrl: string | null
  isDeleted: boolean
}

export type AnalysisBatchRow = {
  id: number
  batchStartTs: number
  batchEndTs: number
  status: string
  reason: string | null
  createdAt: string
}

export type ObservationInsert = {
  startTs: number
  endTs: number
  observation: string
  metadata?: string | null
  llmModel?: string | null
}

export type TimelineCardInsert = {
  startTs: number
  endTs: number
  title: string
  summary?: string | null
  category: string
  subcategory?: string | null
  detailedSummary?: string | null
  metadata?: string | null
  videoSummaryUrl?: string | null
  startDisplay?: string
  endDisplay?: string
}

export type TimelineSearchHitRow = {
  cardRow: any
  rank?: number | null
  snippet?: string | null
}

export type TimelineSearchResult = {
  hits: TimelineSearchHitRow[]
  limit: number
  offset: number
  hasMore: boolean
}

export type ReviewRating = 'focus' | 'neutral' | 'distracted'

export type JournalEntryRow = {
  id: number
  dayKey: string
  intentions: string | null
  notes: string | null
  reflections: string | null
  summary: string | null
  status: JournalEntryStatus
  createdAt: string
  updatedAt: string
}

export class StorageService {
  private readonly userDataPath: string
  private db: Database.Database | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(opts: { userDataPath: string }) {
    this.userDataPath = opts.userDataPath
  }

  async init(): Promise<void> {
    await fs.mkdir(this.absPath('db'), { recursive: true })
    await fs.mkdir(this.absPath('recordings', 'screenshots'), { recursive: true })
    await fs.mkdir(this.absPath('timelapses'), { recursive: true })

    const dbPath = this.absPath('db', 'chrona.sqlite')
    const db = new Database(dbPath)
    this.db = db

    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('busy_timeout = 5000')
    db.pragma('foreign_keys = ON')

    migrate(db)
  }

  async close(): Promise<void> {
    await this.enqueue(() => {
      this.db?.close()
      this.db = null
    })
  }

  getUserDataPath(): string {
    return this.userDataPath
  }

  resolveRelPath(relPath: string): string {
    return this.absPath(...relPath.split('/'))
  }

  async saveScreenshotJpeg(opts: {
    capturedAtMs: number
    jpegBytes: Buffer
  }): Promise<{ screenshotId: number; relPath: string; fileSize: number }> {
    const capturedAtSec = Math.floor(opts.capturedAtMs / 1000)
    const relPath = this.makeScreenshotRelPath(opts.capturedAtMs)
    const absPath = this.resolveRelPath(relPath)

    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, opts.jpegBytes)
    const fileSize = opts.jpegBytes.byteLength

    const screenshotId = await this.enqueue(() => {
      const db = this.mustDb()
      const stmt = db.prepare(
        'INSERT INTO screenshots (captured_at, file_path, file_size) VALUES (?, ?, ?)'
      )
      const info = stmt.run(capturedAtSec, relPath, fileSize)
      return Number(info.lastInsertRowid)
    })

    return { screenshotId, relPath, fileSize }
  }

  async insertScreenshotRow(opts: {
    capturedAtSec: number
    relPath: string
    fileSize?: number | null
  }): Promise<number> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const stmt = db.prepare(
        'INSERT INTO screenshots (captured_at, file_path, file_size) VALUES (?, ?, ?)'
      )
      const info = stmt.run(opts.capturedAtSec, normalizeRelPath(opts.relPath), opts.fileSize ?? null)
      return Number(info.lastInsertRowid)
    })
  }

  async fetchUnprocessedScreenshots(opts: { sinceTs: number }): Promise<ScreenshotRow[]> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const stmt = db.prepare(`
        SELECT id, captured_at, file_path, file_size, is_deleted
        FROM screenshots
        WHERE captured_at >= ?
          AND is_deleted = 0
          AND id NOT IN (SELECT screenshot_id FROM batch_screenshots)
        ORDER BY captured_at ASC
      `)
      const rows = stmt.all(opts.sinceTs) as any[]
      return rows.map(mapScreenshotRow)
    })
  }

  async createBatchWithScreenshots(opts: {
    startTs: number
    endTs: number
    screenshotIds: number[]
  }): Promise<number> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const create = db.transaction(() => {
        const batchInfo = db
          .prepare(
            'INSERT INTO analysis_batches (batch_start_ts, batch_end_ts, status) VALUES (?, ?, ?)'
          )
          .run(opts.startTs, opts.endTs, 'pending')
        const batchId = Number(batchInfo.lastInsertRowid)

        const join = db.prepare(
          'INSERT INTO batch_screenshots (batch_id, screenshot_id) VALUES (?, ?)'
        )
        for (const id of opts.screenshotIds) join.run(batchId, id)

        return batchId
      })

      return create()
    })
  }

  async setBatchStatus(opts: {
    batchId: number
    status: string
    reason?: string | null
  }): Promise<void> {
    await this.enqueue(() => {
      const db = this.mustDb()
      db.prepare('UPDATE analysis_batches SET status = ?, reason = ? WHERE id = ?').run(
        opts.status,
        opts.reason ?? null,
        opts.batchId
      )
    })
  }

  async getBatch(batchId: number): Promise<AnalysisBatchRow | null> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const row = db
        .prepare(
          'SELECT id, batch_start_ts, batch_end_ts, status, reason, created_at FROM analysis_batches WHERE id = ?'
        )
        .get(batchId) as any
      if (!row) return null
      return {
        id: row.id,
        batchStartTs: row.batch_start_ts,
        batchEndTs: row.batch_end_ts,
        status: row.status,
        reason: row.reason ?? null,
        createdAt: row.created_at
      }
    })
  }

  async fetchRecentBatches(limit: number): Promise<AnalysisBatchRow[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    return this.enqueue(() => {
      const db = this.mustDb()
      const rows = db
        .prepare(
          `SELECT id, batch_start_ts, batch_end_ts, status, reason, created_at
           FROM analysis_batches
           ORDER BY id DESC
           LIMIT ?`
        )
        .all(safeLimit) as any[]

      return rows.map((row) => ({
        id: row.id,
        batchStartTs: row.batch_start_ts,
        batchEndTs: row.batch_end_ts,
        status: row.status,
        reason: row.reason ?? null,
        createdAt: row.created_at
      }))
    })
  }

  async fetchNextBatchByStatus(status: string): Promise<AnalysisBatchRow | null> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const row = db
        .prepare(
          `SELECT id, batch_start_ts, batch_end_ts, status, reason, created_at
           FROM analysis_batches
           WHERE status = ?
           ORDER BY id ASC
           LIMIT 1`
        )
        .get(status) as any
      if (!row) return null
      return {
        id: row.id,
        batchStartTs: row.batch_start_ts,
        batchEndTs: row.batch_end_ts,
        status: row.status,
        reason: row.reason ?? null,
        createdAt: row.created_at
      }
    })
  }

  async getBatchScreenshots(batchId: number): Promise<ScreenshotRow[]> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const stmt = db.prepare(`
        SELECT s.id, s.captured_at, s.file_path, s.file_size, s.is_deleted
        FROM batch_screenshots bs
        JOIN screenshots s ON s.id = bs.screenshot_id
        WHERE bs.batch_id = ?
        ORDER BY s.captured_at ASC
      `)
      const rows = stmt.all(batchId) as any[]
      return rows.map(mapScreenshotRow)
    })
  }

  async insertObservations(batchId: number, observations: ObservationInsert[]): Promise<void> {
    if (observations.length === 0) return
    await this.enqueue(() => {
      const db = this.mustDb()
      const insert = db.prepare(
        'INSERT INTO observations (batch_id, start_ts, end_ts, observation, metadata, llm_model) VALUES (?, ?, ?, ?, ?, ?)'
      )

      const tx = db.transaction(() => {
        for (const o of observations) {
          insert.run(
            batchId,
            o.startTs,
            o.endTs,
            o.observation,
            o.metadata ?? null,
            o.llmModel ?? null
          )
        }
      })

      tx()
    })
  }

  async fetchObservationsInRange(opts: {
    startTs: number
    endTs: number
  }): Promise<ObservationInsert[]> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const rows = db
        .prepare(
          `SELECT start_ts, end_ts, observation, metadata, llm_model
           FROM observations
           WHERE start_ts < ? AND end_ts > ?
           ORDER BY start_ts ASC`
        )
        .all(opts.endTs, opts.startTs) as any[]

      return rows.map((r) => ({
        startTs: r.start_ts,
        endTs: r.end_ts,
        observation: r.observation,
        metadata: r.metadata ?? null,
        llmModel: r.llm_model ?? null
      }))
    })
  }

  async fetchCardsInRange(opts: {
    startTs: number
    endTs: number
    includeSystem?: boolean
  }): Promise<any[]> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const includeSystem = opts.includeSystem ?? true

      const whereSystem = includeSystem ? '' : "AND category != 'System'"
      const stmt = db.prepare(`
        SELECT *
        FROM timeline_cards
        WHERE is_deleted = 0
          AND start_ts < ?
          AND end_ts > ?
          ${whereSystem}
        ORDER BY start_ts ASC
      `)
      return stmt.all(opts.endTs, opts.startTs) as any[]
    })
  }

  async fetchCardsForDay(dayKey: string): Promise<any[]> {
    return this.enqueue(() => {
      const db = this.mustDb()
      return db
        .prepare(
          'SELECT * FROM timeline_cards WHERE day = ? AND is_deleted = 0 ORDER BY start_ts ASC'
        )
        .all(dayKey) as any[]
    })
  }

  async searchTimelineCards(req: TimelineSearchRequestDTO): Promise<TimelineSearchResult> {
    const queryRaw = String(req?.query ?? '')
    const query = queryRaw.trim()

    const startTs = Math.floor(Number(req?.scope?.startTs))
    const endTs = Math.floor(Number(req?.scope?.endTs))
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
      throw new Error('Invalid scope')
    }

    const limit = clampInt(req?.limit ?? 100, 1, 500)
    const offset = clampInt(req?.offset ?? 0, 0, 1_000_000)

    const filters = req?.filters ?? {}
    const includeSystem = filters.includeSystem ?? true
    const onlyErrors = !!filters.onlyErrors
    const hasVideo = !!filters.hasVideo
    const hasDetails = !!filters.hasDetails
    const categories = Array.isArray(filters.categories)
      ? filters.categories.map((c) => String(c)).filter((c) => c.trim().length > 0)
      : []

    return this.enqueue(() => {
      const db = this.mustDb()

      const where: string[] = []
      const params: any[] = []

      // Time overlap.
      where.push('tc.is_deleted = 0')
      where.push('tc.start_ts < ?')
      params.push(endTs)
      where.push('tc.end_ts > ?')
      params.push(startTs)

      if (onlyErrors) {
        where.push("tc.category = 'System'")
        where.push("(tc.subcategory = 'Error' OR tc.title = 'Processing failed')")
      } else {
        if (!includeSystem) where.push("tc.category != 'System'")
        if (categories.length > 0) {
          const placeholders = categories.map(() => '?').join(',')
          where.push(`tc.category IN (${placeholders})`)
          params.push(...categories)
        }
      }

      if (hasVideo) where.push("tc.video_summary_url IS NOT NULL AND TRIM(tc.video_summary_url) != ''")
      if (hasDetails) where.push("tc.detailed_summary IS NOT NULL AND TRIM(tc.detailed_summary) != ''")

      const wantFts = query.length > 0
      const hasFts =
        wantFts &&
        (db
          .prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'timeline_cards_fts' LIMIT 1")
          .get() as any)?.ok === 1

      const hits: TimelineSearchHitRow[] = []
      const take = limit + 1

      if (wantFts && hasFts) {
        const ftsQuery = toFtsQuery(query)
        const sql = `
          SELECT
            tc.*,
            bm25(timeline_cards_fts) AS rank,
            snippet(timeline_cards_fts, 1, '[', ']', '...', 10) AS snippet
          FROM timeline_cards_fts
          JOIN timeline_cards tc ON tc.id = timeline_cards_fts.rowid
          WHERE timeline_cards_fts MATCH ?
            AND ${where.join(' AND ')}
          ORDER BY rank ASC, tc.start_ts DESC
          LIMIT ? OFFSET ?
        `

        const rows = db
          .prepare(sql)
          .all(ftsQuery, ...params, take, offset) as any[]

        for (const r of rows) {
          hits.push({
            cardRow: r,
            rank: r.rank === null || r.rank === undefined ? null : Number(r.rank),
            snippet: r.snippet === null || r.snippet === undefined ? null : String(r.snippet)
          })
        }
      } else if (query.length > 0) {
        // Fallback: LIKE search when FTS isn't available.
        const like = `%${query.toLowerCase()}%`
        const sql = `
          SELECT tc.*
          FROM timeline_cards tc
          WHERE (
            LOWER(COALESCE(tc.title, '')) LIKE ? OR
            LOWER(COALESCE(tc.summary, '')) LIKE ? OR
            LOWER(COALESCE(tc.detailed_summary, '')) LIKE ? OR
            LOWER(COALESCE(tc.category, '')) LIKE ? OR
            LOWER(COALESCE(tc.subcategory, '')) LIKE ? OR
            LOWER(COALESCE(tc.metadata, '')) LIKE ?
          )
            AND ${where.join(' AND ')}
          ORDER BY tc.start_ts DESC
          LIMIT ? OFFSET ?
        `
        const rows = db
          .prepare(sql)
          .all(like, like, like, like, like, like, ...params, take, offset) as any[]
        for (const r of rows) hits.push({ cardRow: r })
      } else {
        // Queryless search (filters-only). Keep stable ordering.
        const sql = `
          SELECT tc.*
          FROM timeline_cards tc
          WHERE ${where.join(' AND ')}
          ORDER BY tc.start_ts DESC
          LIMIT ? OFFSET ?
        `
        const rows = db.prepare(sql).all(...params, take, offset) as any[]
        for (const r of rows) hits.push({ cardRow: r })
      }

      const hasMore = hits.length > limit
      const trimmed = hasMore ? hits.slice(0, limit) : hits

      return {
        hits: trimmed,
        limit,
        offset,
        hasMore
      }
    })
  }

  async fetchTimelineCardById(cardId: number): Promise<TimelineCardRow | null> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const r = db.prepare('SELECT * FROM timeline_cards WHERE id = ?').get(cardId) as any
      if (!r) return null
      return mapTimelineCardRow(r)
    })
  }

  async updateTimelineCardVideoSummaryUrl(opts: { cardId: number; relPath: string | null }): Promise<void> {
    await this.enqueue(() => {
      const db = this.mustDb()
      db.prepare('UPDATE timeline_cards SET video_summary_url = ? WHERE id = ?').run(
        opts.relPath,
        opts.cardId
      )
    })
  }

  async fetchScreenshotsInRange(opts: {
    startTs: number
    endTs: number
  }): Promise<ScreenshotRow[]> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const rows = db
        .prepare(
          `SELECT id, captured_at, file_path, file_size, is_deleted
           FROM screenshots
           WHERE is_deleted = 0
             AND captured_at >= ?
             AND captured_at <= ?
           ORDER BY captured_at ASC`
        )
        .all(opts.startTs, opts.endTs) as any[]
      return rows.map(mapScreenshotRow)
    })
  }

  async updateCardCategory(opts: {
    cardId: number
    category: string
    subcategory?: string | null
  }): Promise<void> {
    await this.enqueue(() => {
      const db = this.mustDb()
      db.prepare('UPDATE timeline_cards SET category = ?, subcategory = ? WHERE id = ?').run(
        opts.category,
        opts.subcategory ?? null,
        opts.cardId
      )
    })
  }

  async replaceCardsInRange(opts: {
    fromTs: number
    toTs: number
    batchId: number
    newCards: TimelineCardInsert[]
  }): Promise<{ insertedCardIds: number[]; removedVideoPaths: string[] }> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const tx = db.transaction(() => {
        const overlapping = db
          .prepare(
            `SELECT id, category, batch_id, video_summary_url
             FROM timeline_cards
             WHERE is_deleted = 0
               AND start_ts < ?
               AND end_ts > ?`
          )
          .all(opts.toTs, opts.fromTs) as any[]

        const idsToDelete: number[] = []
        const removedVideoPaths: string[] = []
        for (const row of overlapping) {
          const shouldDelete =
            row.category !== 'System' ||
            (row.category === 'System' && Number(row.batch_id) === opts.batchId)
          if (!shouldDelete) continue

          idsToDelete.push(Number(row.id))
          if (row.video_summary_url) removedVideoPaths.push(String(row.video_summary_url))
        }

        if (idsToDelete.length > 0) {
          const placeholders = idsToDelete.map(() => '?').join(',')
          db.prepare(`UPDATE timeline_cards SET is_deleted = 1 WHERE id IN (${placeholders})`).run(
            ...idsToDelete
          )
        }

        const insertedCardIds: number[] = []
        const insert = db.prepare(`
          INSERT INTO timeline_cards (
            batch_id, start, end, start_ts, end_ts, day,
            title, summary, category, subcategory, detailed_summary,
            metadata, video_summary_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        for (const c of opts.newCards) {
          const startDisplay = c.startDisplay ?? formatClockAscii(c.startTs)
          const endDisplay = c.endDisplay ?? formatClockAscii(c.endTs)
          const day = dayKeyFromUnixSeconds(c.startTs)
          const info = insert.run(
            opts.batchId,
            startDisplay,
            endDisplay,
            c.startTs,
            c.endTs,
            day,
            c.title,
            c.summary ?? null,
            c.category,
            c.subcategory ?? null,
            c.detailedSummary ?? null,
            c.metadata ?? null,
            c.videoSummaryUrl ?? null
          )
          insertedCardIds.push(Number(info.lastInsertRowid))
        }

        return { insertedCardIds, removedVideoPaths }
      })

      return tx()
    })
  }

  async applyReviewRatingSegment(opts: {
    startTs: number
    endTs: number
    rating: ReviewRating
  }): Promise<void> {
    await this.enqueue(() => {
      const db = this.mustDb()
      const tx = db.transaction(() => {
        const overlapping = db
          .prepare(
            `SELECT id, start_ts, end_ts, rating
             FROM timeline_review_ratings
             WHERE start_ts < ? AND end_ts > ?
             ORDER BY start_ts ASC`
          )
          .all(opts.endTs, opts.startTs) as any[]

        if (overlapping.length > 0) {
          const ids = overlapping.map((r) => Number(r.id))
          const placeholders = ids.map(() => '?').join(',')
          db.prepare(`DELETE FROM timeline_review_ratings WHERE id IN (${placeholders})`).run(...ids)

          const insert = db.prepare(
            'INSERT INTO timeline_review_ratings (start_ts, end_ts, rating) VALUES (?, ?, ?)'
          )

          for (const r of overlapping) {
            const prevStart = Number(r.start_ts)
            const prevEnd = Number(r.end_ts)
            const prevRating = String(r.rating) as ReviewRating

            if (prevStart < opts.startTs) {
              insert.run(prevStart, opts.startTs, prevRating)
            }
            if (prevEnd > opts.endTs) {
              insert.run(opts.endTs, prevEnd, prevRating)
            }
          }
        }

        db.prepare(
          'INSERT INTO timeline_review_ratings (start_ts, end_ts, rating) VALUES (?, ?, ?)'
        ).run(opts.startTs, opts.endTs, opts.rating)
      })

      tx()
    })
  }

  async fetchReviewSegmentsInRange(opts: {
    startTs: number
    endTs: number
  }): Promise<{ startTs: number; endTs: number; rating: ReviewRating }[]> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const rows = db
        .prepare(
          `SELECT start_ts, end_ts, rating
           FROM timeline_review_ratings
           WHERE start_ts < ? AND end_ts > ?
           ORDER BY start_ts ASC`
        )
        .all(opts.endTs, opts.startTs) as any[]

      return rows.map((r) => ({
        startTs: Number(r.start_ts),
        endTs: Number(r.end_ts),
        rating: String(r.rating) as ReviewRating
      }))
    })
  }

  async getJournalEntry(dayKey: string): Promise<JournalEntryDTO | null> {
    const k = String(dayKey ?? '').trim()
    if (!k) return null
    return this.enqueue(() => {
      const db = this.mustDb()
      const r = db
        .prepare(
          `SELECT day, intentions, notes, reflections, summary, status, created_at, updated_at
           FROM journal_entries
           WHERE day = ?`
        )
        .get(k) as any
      if (!r) return null
      return mapJournalEntryRow(r)
    })
  }

  async upsertJournalEntry(opts: {
    dayKey: string
    patch: JournalEntryPatch
  }): Promise<JournalEntryDTO> {
    const k = String(opts.dayKey ?? '').trim()
    if (!k) throw new Error('dayKey is required')

    const patch = opts.patch ?? {}
    const prev = await this.getJournalEntry(k)

    const next: JournalEntryDTO = {
      dayKey: k,
      intentions: Object.prototype.hasOwnProperty.call(patch, 'intentions')
        ? normalizeNullableText((patch as any).intentions)
        : prev?.intentions ?? null,
      notes: Object.prototype.hasOwnProperty.call(patch, 'notes')
        ? normalizeNullableText((patch as any).notes)
        : prev?.notes ?? null,
      reflections: Object.prototype.hasOwnProperty.call(patch, 'reflections')
        ? normalizeNullableText((patch as any).reflections)
        : prev?.reflections ?? null,
      summary: Object.prototype.hasOwnProperty.call(patch, 'summary')
        ? normalizeNullableText((patch as any).summary)
        : prev?.summary ?? null,
      status: Object.prototype.hasOwnProperty.call(patch, 'status')
        ? normalizeStatus((patch as any).status)
        : prev?.status ?? 'draft',
      createdAt: prev?.createdAt ?? '',
      updatedAt: prev?.updatedAt ?? ''
    }

    await this.enqueue(() => {
      const db = this.mustDb()
      db.prepare(
        `INSERT INTO journal_entries (day, intentions, notes, reflections, summary, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(day) DO UPDATE SET
           intentions = excluded.intentions,
           notes = excluded.notes,
           reflections = excluded.reflections,
           summary = excluded.summary,
           status = excluded.status,
           updated_at = CURRENT_TIMESTAMP`
      ).run(
        next.dayKey,
        next.intentions,
        next.notes,
        next.reflections,
        next.summary,
        next.status
      )
    })

    const saved = await this.getJournalEntry(k)
    if (!saved) {
      // Should be impossible; keep defensive.
      throw new Error('Failed to save journal entry')
    }
    return saved
  }

  async deleteJournalEntry(dayKey: string): Promise<void> {
    const k = String(dayKey ?? '').trim()
    if (!k) return
    await this.enqueue(() => {
      const db = this.mustDb()
      db.prepare('DELETE FROM journal_entries WHERE day = ?').run(k)
    })
  }

  async listJournalEntriesInRange(opts: {
    startDayKey: string
    endDayKey: string
  }): Promise<JournalEntryDTO[]> {
    const start = String(opts.startDayKey ?? '').trim()
    const end = String(opts.endDayKey ?? '').trim()
    if (!start || !end) throw new Error('startDayKey and endDayKey are required')
    if (start > end) throw new Error('startDayKey must be <= endDayKey')

    return this.enqueue(() => {
      const db = this.mustDb()
      const rows = db
        .prepare(
          `SELECT day, intentions, notes, reflections, summary, status, created_at, updated_at
           FROM journal_entries
           WHERE day >= ? AND day <= ?
           ORDER BY day ASC`
        )
        .all(start, end) as any[]
      return rows.map(mapJournalEntryRow)
    })
  }

  async markScreenshotsDeletedByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    await this.enqueue(() => {
      const db = this.mustDb()
      const placeholders = ids.map(() => '?').join(',')
      db.prepare(`UPDATE screenshots SET is_deleted = 1 WHERE id IN (${placeholders})`).run(...ids)
    })
  }

  async insertLLMCall(opts: {
    batchId?: number | null
    callGroupId?: string | null
    attempt?: number
    provider: string
    model?: string | null
    operation: string
    status: 'success' | 'failure'
    latencyMs?: number | null
    httpStatus?: number | null
    requestMethod?: string | null
    requestUrl?: string | null
    requestHeaders?: string | null
    requestBody?: string | null
    responseHeaders?: string | null
    responseBody?: string | null
    errorDomain?: string | null
    errorCode?: number | null
    errorMessage?: string | null
  }): Promise<number> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const stmt = db.prepare(`
        INSERT INTO llm_calls (
          batch_id, call_group_id, attempt, provider, model, operation, status,
          latency_ms, http_status, request_method, request_url,
          request_headers, request_body, response_headers, response_body,
          error_domain, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const info = stmt.run(
        opts.batchId ?? null,
        opts.callGroupId ?? null,
        opts.attempt ?? 1,
        opts.provider,
        opts.model ?? null,
        opts.operation,
        opts.status,
        opts.latencyMs ?? null,
        opts.httpStatus ?? null,
        opts.requestMethod ?? null,
        opts.requestUrl ?? null,
        opts.requestHeaders ?? null,
        opts.requestBody ?? null,
        opts.responseHeaders ?? null,
        opts.responseBody ?? null,
        opts.errorDomain ?? null,
        opts.errorCode ?? null,
        opts.errorMessage ?? null
      )
      return Number(info.lastInsertRowid)
    })
  }

  async purgeStragglers(): Promise<{ deletedCount: number }> {
    // Best-effort cleanup; intended to mirror the original app's "straggler" deletion.
    const roots = ['recordings/screenshots', 'timelapses']
    const relFiles: string[] = []

    for (const root of roots) {
      const absRoot = this.resolveRelPath(root)
      const files = await listFilesRecursive(absRoot)
      for (const abs of files) {
        const rel = absPathToRelUnderUserData(this.userDataPath, abs)
        if (rel) relFiles.push(rel)
      }
    }

    if (relFiles.length === 0) return { deletedCount: 0 }

    const referenced = await this.enqueue(() => {
      const db = this.mustDb()

      // Keep this bounded to avoid huge parameter lists.
      const chunkSize = 500
      const keep = new Set<string>()
      for (let i = 0; i < relFiles.length; i += chunkSize) {
        const chunk = relFiles.slice(i, i + chunkSize)
        const placeholders = chunk.map(() => '?').join(',')

        const screenshotRows = db
          .prepare(
            `SELECT file_path FROM screenshots WHERE is_deleted = 0 AND file_path IN (${placeholders})`
          )
          .all(...chunk) as any[]
        for (const r of screenshotRows) keep.add(String(r.file_path))

        const timelapseRows = db
          .prepare(
            `SELECT video_summary_url as p
             FROM timeline_cards
             WHERE is_deleted = 0
               AND video_summary_url IS NOT NULL
               AND video_summary_url IN (${placeholders})`
          )
          .all(...chunk) as any[]
        for (const r of timelapseRows) keep.add(String(r.p))
      }

      return keep
    })

    let deletedCount = 0
    for (const rel of relFiles) {
      if (referenced.has(rel)) continue
      try {
        await fs.unlink(this.resolveRelPath(rel))
        deletedCount += 1
      } catch {
        // ignore
      }
    }

    return { deletedCount }
  }

  async getRecordingsUsageBytes(): Promise<number> {
    return this.enqueue(() => {
      const db = this.mustDb()
      const row = db
        .prepare('SELECT COALESCE(SUM(COALESCE(file_size, 0)), 0) AS bytes FROM screenshots WHERE is_deleted = 0')
        .get() as any
      return Number(row?.bytes ?? 0)
    })
  }

  async getTimelapsesUsageBytes(): Promise<number> {
    // No timelapses yet in Phase 10 for most builds, but keep accounting correct.
    const root = this.resolveRelPath('timelapses')
    const files = await listFilesRecursive(root)
    let total = 0
    for (const f of files) {
      try {
        const st = await fs.stat(f)
        total += st.size
      } catch {
        // ignore
      }
    }
    return total
  }

  async purgeRecordingsToLimit(limitBytes: number): Promise<{
    deletedCount: number
    freedBytes: number
    remainingBytes: number
  }> {
    const limit = Math.max(0, Math.floor(limitBytes))
    let remaining = await this.getRecordingsUsageBytes()
    if (remaining <= limit) return { deletedCount: 0, freedBytes: 0, remainingBytes: remaining }

    let deletedCount = 0
    let freedBytes = 0

    while (remaining > limit) {
      const batch = await this.enqueue(() => {
        const db = this.mustDb()
        const rows = db
          .prepare(
            `SELECT id, file_path, COALESCE(file_size, 0) AS file_size
             FROM screenshots
             WHERE is_deleted = 0
             ORDER BY captured_at ASC
             LIMIT 500`
          )
          .all() as any[]

        if (rows.length === 0) return []
        const ids = rows.map((r) => Number(r.id))
        const placeholders = ids.map(() => '?').join(',')
        db.prepare(`UPDATE screenshots SET is_deleted = 1 WHERE id IN (${placeholders})`).run(...ids)

        return rows.map((r) => ({
          id: Number(r.id),
          relPath: String(r.file_path),
          fileSize: Number(r.file_size)
        }))
      })

      if (batch.length === 0) break

      for (const row of batch) {
        try {
          await fs.unlink(this.resolveRelPath(row.relPath))
        } catch {
          // ignore
        }
        deletedCount += 1
        freedBytes += row.fileSize
      }

      remaining = await this.getRecordingsUsageBytes()
    }

    return { deletedCount, freedBytes, remainingBytes: remaining }
  }

  async purgeTimelapsesToLimit(limitBytes: number): Promise<{
    deletedCount: number
    freedBytes: number
    remainingBytes: number
  }> {
    const limit = Math.max(0, Math.floor(limitBytes))

    const root = this.resolveRelPath('timelapses')
    const files = await listFilesRecursive(root)
    const entries: Array<{ abs: string; rel: string; size: number; mtimeMs: number }> = []
    for (const abs of files) {
      try {
        const st = await fs.stat(abs)
        const rel = absPathToRelUnderUserData(this.userDataPath, abs)
        if (!rel) continue
        entries.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        // ignore
      }
    }

    let total = entries.reduce((a, e) => a + e.size, 0)
    if (total <= limit) return { deletedCount: 0, freedBytes: 0, remainingBytes: total }

    const referenced = await this.enqueue(() => {
      const db = this.mustDb()
      const rows = db
        .prepare(
          `SELECT video_summary_url AS p
           FROM timeline_cards
           WHERE is_deleted = 0 AND video_summary_url IS NOT NULL`
        )
        .all() as any[]
      return new Set(rows.map((r) => String(r.p)))
    })

    // Prefer deleting unreferenced files first.
    const unref = entries.filter((e) => !referenced.has(e.rel)).sort((a, b) => a.mtimeMs - b.mtimeMs)
    const ref = entries.filter((e) => referenced.has(e.rel)).sort((a, b) => a.mtimeMs - b.mtimeMs)
    const ordered = [...unref, ...ref]

    let deletedCount = 0
    let freedBytes = 0

    for (const e of ordered) {
      if (total <= limit) break

      if (referenced.has(e.rel)) {
        await this.enqueue(() => {
          const db = this.mustDb()
          db.prepare('UPDATE timeline_cards SET video_summary_url = NULL WHERE video_summary_url = ?').run(
            e.rel
          )
        })
      }

      try {
        await fs.unlink(e.abs)
        deletedCount += 1
        freedBytes += e.size
        total -= e.size
      } catch {
        // ignore
      }
    }

    const remainingBytes = await this.getTimelapsesUsageBytes()
    return { deletedCount, freedBytes, remainingBytes }
  }

  private absPath(...parts: string[]): string {
    return path.join(this.userDataPath, ...parts)
  }

  private mustDb(): Database.Database {
    if (!this.db) throw new Error('StorageService not initialized')
    return this.db
  }

  private async enqueue<T>(fn: () => T): Promise<T> {
    // Serialize DB work to keep transaction ordering predictable.
    const next = this.queue.then(fn)
    this.queue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private makeScreenshotRelPath(capturedAtMs: number): string {
    const d = new Date(capturedAtMs)
    const dir = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    const filename = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(
      d.getHours()
    )}${pad2(d.getMinutes())}${pad2(d.getSeconds())}${pad3(d.getMilliseconds())}.jpg`

    return normalizeRelPath(`recordings/screenshots/${dir}/${filename}`)
  }
}

function clampInt(n: unknown, min: number, max: number): number {
  const x = Math.floor(Number(n))
  if (!Number.isFinite(x)) return min
  return Math.max(min, Math.min(max, x))
}

function toFtsQuery(q: string): string {
  const tokens = String(q ?? '')
    .trim()
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter(Boolean)

  if (tokens.length === 0) return ''

  const parts: string[] = []
  for (const t of tokens) {
    if (/^[A-Za-z0-9_]+$/.test(t)) {
      // Prefix matching for a more forgiving UX.
      parts.push(`${t}*`)
    } else {
      const escaped = t.replaceAll('"', '""')
      parts.push(`"${escaped}"`)
    }
  }

  return parts.join(' AND ')
}

function mapScreenshotRow(r: any): ScreenshotRow {
  return {
    id: Number(r.id),
    capturedAt: Number(r.captured_at),
    filePath: String(r.file_path),
    fileSize: r.file_size === null || r.file_size === undefined ? null : Number(r.file_size),
    isDeleted: Number(r.is_deleted) === 1 ? 1 : 0
  }
}

function mapTimelineCardRow(r: any): TimelineCardRow {
  return {
    id: Number(r.id),
    batchId: r.batch_id === null || r.batch_id === undefined ? null : Number(r.batch_id),
    startTs: Number(r.start_ts),
    endTs: Number(r.end_ts),
    dayKey: String(r.day),
    title: String(r.title),
    summary: r.summary ?? null,
    detailedSummary: r.detailed_summary ?? null,
    category: String(r.category),
    subcategory: r.subcategory ?? null,
    metadata: r.metadata ?? null,
    videoSummaryUrl: r.video_summary_url ?? null,
    isDeleted: Number(r.is_deleted) === 1
  }
}

function normalizeRelPath(p: string): string {
  return p.replaceAll('\\\\', '/').replaceAll('\\', '/')
}

function normalizeNullableText(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v)
  const trimmed = s.replace(/\r\n/g, '\n').trimEnd()
  return trimmed.length === 0 ? null : trimmed
}

function normalizeStatus(v: unknown): JournalEntryStatus {
  const s = String(v ?? '').trim()
  return s === 'complete' ? 'complete' : 'draft'
}

function mapJournalEntryRow(r: any): JournalEntryDTO {
  const status = String(r.status ?? 'draft').trim() === 'complete' ? 'complete' : 'draft'
  return {
    dayKey: String(r.day),
    intentions: r.intentions ?? null,
    notes: r.notes ?? null,
    reflections: r.reflections ?? null,
    summary: r.summary ?? null,
    status,
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? '')
  }
}

function absPathToRelUnderUserData(userDataPath: string, absFile: string): string | null {
  const rel = path.relative(userDataPath, absFile)
  if (rel.startsWith('..')) return null
  return normalizeRelPath(rel)
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  let entries: any[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const out: string[] = []
  await Promise.all(
    entries.map(async (e) => {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        const children = await listFilesRecursive(abs)
        out.push(...children)
        return
      }
      if (e.isFile()) out.push(abs)
    })
  )
  return out
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function pad3(n: number): string {
  return String(n).padStart(3, '0')
}
