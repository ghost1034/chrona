import type { TimelineCardDTO } from './timeline'
import { formatClockAscii } from './time'

export type TimelineExportOptions = {
  includeSystem?: boolean
  includeReviewCoverage?: boolean
}

export type TimelineExportRow = {
  card_id: number
  batch_id: number | null
  day_key: string
  start_ts: number
  end_ts: number
  start_local: string
  end_local: string
  start_clock: string
  end_clock: string
  duration_minutes: number
  category: string
  subcategory: string | null
  title: string
  summary: string | null
  detailed_summary: string | null
  app_site_primary: string | null
  app_site_secondary: string | null
  video_summary_url: string | null
  metadata_json: string | null
  review_coverage: number | null
}

export const TIMELINE_EXPORT_COLUMNS: ReadonlyArray<{
  key: keyof TimelineExportRow
  header: string
}> = [
  { key: 'card_id', header: 'card_id' },
  { key: 'batch_id', header: 'batch_id' },
  { key: 'day_key', header: 'day_key' },
  { key: 'start_ts', header: 'start_ts' },
  { key: 'end_ts', header: 'end_ts' },
  { key: 'start_local', header: 'start_local' },
  { key: 'end_local', header: 'end_local' },
  { key: 'start_clock', header: 'start_clock' },
  { key: 'end_clock', header: 'end_clock' },
  { key: 'duration_minutes', header: 'duration_minutes' },
  { key: 'category', header: 'category' },
  { key: 'subcategory', header: 'subcategory' },
  { key: 'title', header: 'title' },
  { key: 'summary', header: 'summary' },
  { key: 'detailed_summary', header: 'detailed_summary' },
  { key: 'app_site_primary', header: 'app_site_primary' },
  { key: 'app_site_secondary', header: 'app_site_secondary' },
  { key: 'video_summary_url', header: 'video_summary_url' },
  { key: 'metadata_json', header: 'metadata_json' },
  { key: 'review_coverage', header: 'review_coverage' }
]

export function buildTimelineExportRowsForDay(opts: {
  dayKey: string
  cards: TimelineCardDTO[]
  options?: TimelineExportOptions
  coverageByCardId?: Record<number, number> | null
}): TimelineExportRow[] {
  const includeSystem = opts.options?.includeSystem ?? true
  const includeReviewCoverage = opts.options?.includeReviewCoverage ?? false
  const coverageByCardId = opts.coverageByCardId ?? null

  const cards = [...opts.cards]
    .filter((c) => includeSystem || c.category !== 'System')
    .sort((a, b) => a.startTs - b.startTs)

  const out: TimelineExportRow[] = []
  for (const c of cards) {
    const durSec = Math.max(0, c.endTs - c.startTs)
    const durationMinutes = Math.round((durSec / 60) * 10) / 10

    const sites = parseAppSitesFromMetadata(c.metadata)
    const coverage =
      includeReviewCoverage && coverageByCardId && Object.prototype.hasOwnProperty.call(coverageByCardId, c.id)
        ? clamp01(Number((coverageByCardId as any)[c.id]))
        : null

    out.push({
      card_id: c.id,
      batch_id: c.batchId ?? null,
      day_key: opts.dayKey,
      start_ts: c.startTs,
      end_ts: c.endTs,
      start_local: formatLocalDateTimeAscii(c.startTs),
      end_local: formatLocalDateTimeAscii(c.endTs),
      start_clock: formatClockAscii(c.startTs),
      end_clock: formatClockAscii(c.endTs),
      duration_minutes: durationMinutes,
      category: c.category,
      subcategory: c.subcategory ?? null,
      title: c.title,
      summary: c.summary ?? null,
      detailed_summary: c.detailedSummary ?? null,
      app_site_primary: sites.primary,
      app_site_secondary: sites.secondary,
      video_summary_url: c.videoSummaryUrl ?? null,
      metadata_json: c.metadata ?? null,
      review_coverage: coverage
    })
  }
  return out
}

export function formatTimelineRowsCsv(opts: {
  rows: TimelineExportRow[]
  includeBom?: boolean
}): string {
  const includeBom = opts.includeBom ?? true

  const headers = TIMELINE_EXPORT_COLUMNS.map((c) => c.header)
  const lines: string[] = []
  lines.push(formatCsvRow(headers))

  for (const r of opts.rows) {
    const cells = TIMELINE_EXPORT_COLUMNS.map((c) => {
      const v = (r as any)[c.key]
      if (v === null || v === undefined) return ''
      if (typeof v === 'number') return String(v)
      if (typeof v === 'boolean') return v ? 'true' : 'false'
      return mitigateCsvInjection(String(v))
    })
    lines.push(formatCsvRow(cells))
  }

  const body = lines.join('\r\n') + '\r\n'
  return includeBom ? '\uFEFF' + body : body
}

export function mitigateCsvInjection(s: string): string {
  const trimmedLeft = s.replace(/^\s+/, '')
  if (!trimmedLeft) return s
  const ch = trimmedLeft[0]
  if (ch === '=' || ch === '+' || ch === '-' || ch === '@') {
    return "'" + s
  }
  return s
}

export function parseAppSitesFromMetadata(metadata: string | null): {
  primary: string | null
  secondary: string | null
} {
  if (!metadata) return { primary: null, secondary: null }
  const parsed = safeJsonParse(metadata)
  if (!parsed || typeof parsed !== 'object') return { primary: null, secondary: null }
  const appSites = (parsed as any).appSites
  if (!appSites || typeof appSites !== 'object') return { primary: null, secondary: null }
  const primary = normalizeNullableString((appSites as any).primary)
  const secondary = normalizeNullableString((appSites as any).secondary)
  return { primary, secondary }
}

export function formatLocalDateTimeAscii(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const pad2 = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function formatCsvRow(cells: string[]): string {
  return cells.map(escapeCsvCell).join(',')
}

function escapeCsvCell(s: string): string {
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

function normalizeNullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s : null
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
