import { describe, expect, it } from 'vitest'
import { buildTimelineExportRowsForDay, formatTimelineRowsCsv } from './timelineExport'
import type { TimelineCardDTO } from './timeline'

describe('timeline export', () => {
  it('builds rows and parses appSites from metadata', () => {
    const cards: TimelineCardDTO[] = [
      {
        id: 1,
        batchId: 9,
        startTs: 1_700_000_000,
        endTs: 1_700_000_600,
        dayKey: '2026-02-06',
        title: 'Work',
        summary: null,
        detailedSummary: null,
        category: 'Work',
        subcategory: null,
        metadata: JSON.stringify({ appSites: { primary: 'github.com', secondary: null } }),
        videoSummaryUrl: null
      }
    ]

    const rows = buildTimelineExportRowsForDay({ dayKey: '2026-02-06', cards })
    expect(rows).toHaveLength(1)
    expect(rows[0].app_site_primary).toBe('github.com')
    expect(rows[0].app_site_secondary).toBe(null)
    expect(rows[0].duration_minutes).toBe(10)
  })

  it('formats CSV with escaping and injection mitigation', () => {
    const cards: TimelineCardDTO[] = [
      {
        id: 2,
        batchId: null,
        startTs: 1_700_000_000,
        endTs: 1_700_000_060,
        dayKey: '2026-02-06',
        title: '=SUM(1,1)',
        summary: 'Line 1\nLine 2, with comma and "quote"',
        detailedSummary: null,
        category: 'Work',
        subcategory: 'Coding',
        metadata: null,
        videoSummaryUrl: null
      }
    ]

    const rows = buildTimelineExportRowsForDay({ dayKey: '2026-02-06', cards })
    const csv = formatTimelineRowsCsv({ rows, includeBom: true })

    expect(csv.startsWith('\uFEFFcard_id')).toBe(true)
    expect(csv).toContain("'=SUM(1,1)")

    // Summary should be quoted (contains newline, comma, quote).
    expect(csv).toContain('"Line 1')
    expect(csv).toContain('""quote""')
  })
})
