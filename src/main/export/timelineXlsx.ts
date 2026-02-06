import type { TimelineExportRow } from '../../shared/timelineExport'
import { TIMELINE_EXPORT_COLUMNS } from '../../shared/timelineExport'

export async function buildTimelineXlsxBuffer(opts: {
  rows: TimelineExportRow[]
  meta?: {
    startDayKey: string
    endDayKey: string
    generatedAtLocal: string
    timezone: string
  }
}): Promise<Buffer> {
  const ExcelJSImport = await import('exceljs')
  const ExcelJS: any = (ExcelJSImport as any).default ?? ExcelJSImport

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Chrona'
  wb.created = new Date()

  const ws = wb.addWorksheet('Timeline', { views: [{ state: 'frozen', ySplit: 1 }] })

  ws.columns = TIMELINE_EXPORT_COLUMNS.map((c) => ({
    header: c.header,
    key: c.key,
    width: recommendedWidthForKey(c.key as any)
  }))

  const headerRow = ws.getRow(1)
  headerRow.font = { bold: true }
  headerRow.alignment = { vertical: 'middle' }
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: TIMELINE_EXPORT_COLUMNS.length }
  }

  for (const r of opts.rows) {
    const safeRow: any = {}
    for (const col of TIMELINE_EXPORT_COLUMNS) {
      const v = (r as any)[col.key]
      if (v === null || v === undefined) {
        safeRow[col.key] = null
        continue
      }

      if (typeof v === 'number' || typeof v === 'boolean') {
        safeRow[col.key] = v
        continue
      }

      safeRow[col.key] = String(v)
    }

    ws.addRow(safeRow)
  }

  // Wrap long text columns.
  const wrapKeys = new Set<keyof TimelineExportRow>([
    'summary',
    'detailed_summary',
    'metadata_json',
    'title'
  ])
  for (let i = 0; i < TIMELINE_EXPORT_COLUMNS.length; i += 1) {
    const key = TIMELINE_EXPORT_COLUMNS[i].key
    if (!wrapKeys.has(key)) continue
    ws.getColumn(i + 1).alignment = { wrapText: true, vertical: 'top' }
  }

  // Optional meta sheet.
  if (opts.meta) {
    const meta = wb.addWorksheet('Meta')
    meta.columns = [
      { header: 'key', key: 'key', width: 24 },
      { header: 'value', key: 'value', width: 60 }
    ]
    meta.getRow(1).font = { bold: true }
    meta.addRow({ key: 'startDayKey', value: opts.meta.startDayKey })
    meta.addRow({ key: 'endDayKey', value: opts.meta.endDayKey })
    meta.addRow({ key: 'generatedAtLocal', value: opts.meta.generatedAtLocal })
    meta.addRow({ key: 'timezone', value: opts.meta.timezone })
  }

  const bufLike = await wb.xlsx.writeBuffer()
  if (Buffer.isBuffer(bufLike)) return bufLike
  return Buffer.from(bufLike)
}

function recommendedWidthForKey(key: keyof TimelineExportRow): number {
  switch (key) {
    case 'card_id':
    case 'batch_id':
      return 10
    case 'day_key':
      return 12
    case 'start_ts':
    case 'end_ts':
      return 12
    case 'start_local':
    case 'end_local':
      return 20
    case 'start_clock':
    case 'end_clock':
      return 10
    case 'duration_minutes':
      return 16
    case 'category':
    case 'subcategory':
      return 16
    case 'title':
      return 40
    case 'summary':
    case 'detailed_summary':
      return 60
    case 'app_site_primary':
    case 'app_site_secondary':
      return 24
    case 'video_summary_url':
      return 32
    case 'metadata_json':
      return 60
    case 'review_coverage':
      return 16
    default:
      return 20
  }
}
