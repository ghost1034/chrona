import fs from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from './schema'
import { dayKeyFromUnixSeconds, formatClockAscii } from '../../shared/time'

export type ScreenshotRow = {
  id: number
  capturedAt: number
  filePath: string
  fileSize: number | null
  isDeleted: 0 | 1
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

export type ReviewRating = 'focus' | 'neutral' | 'distracted'

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

    const dbPath = this.absPath('db', 'dayflow.sqlite')
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

  async markScreenshotsDeletedByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    await this.enqueue(() => {
      const db = this.mustDb()
      const placeholders = ids.map(() => '?').join(',')
      db.prepare(`UPDATE screenshots SET is_deleted = 1 WHERE id IN (${placeholders})`).run(...ids)
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

function mapScreenshotRow(r: any): ScreenshotRow {
  return {
    id: Number(r.id),
    capturedAt: Number(r.captured_at),
    filePath: String(r.file_path),
    fileSize: r.file_size === null || r.file_size === undefined ? null : Number(r.file_size),
    isDeleted: Number(r.is_deleted) === 1 ? 1 : 0
  }
}

function normalizeRelPath(p: string): string {
  return p.replaceAll('\\\\', '/').replaceAll('\\', '/')
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
