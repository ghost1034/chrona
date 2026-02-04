import { describe, expect, it } from 'vitest'
import type { JournalEntryDTO } from './journal'
import { formatJournalDayForClipboard, formatJournalRangeMarkdown } from './export'

describe('journal export formatting', () => {
  it('formats a day for clipboard', () => {
    const entry: JournalEntryDTO = {
      dayKey: '2026-02-06',
      intentions: '- Ship journal MVP\n- Keep it simple',
      notes: 'Did a bunch of work.',
      reflections: 'Went well overall.',
      summary: 'Good progress.',
      status: 'draft',
      createdAt: '2026-02-06 10:00:00',
      updatedAt: '2026-02-06 11:00:00'
    }

    const text = formatJournalDayForClipboard({ dayKey: entry.dayKey, entry })
    expect(text).toContain('# Chrona journal · 2026-02-06')
    expect(text).toContain('## Intentions')
    expect(text).toContain('## Notes')
    expect(text).toContain('## Reflections')
    expect(text).toContain('## Summary')
  })

  it('formats a range with missing days', () => {
    const entry: JournalEntryDTO = {
      dayKey: '2026-02-06',
      intentions: 'Test',
      notes: null,
      reflections: null,
      summary: null,
      status: 'complete',
      createdAt: 'x',
      updatedAt: 'x'
    }

    const md = formatJournalRangeMarkdown({
      startDayKey: '2026-02-05',
      endDayKey: '2026-02-07',
      entries: [entry]
    })

    expect(md).toContain('## 2026-02-05')
    expect(md).toContain('## 2026-02-06')
    expect(md).toContain('## 2026-02-07')
    expect(md).toContain('Status: complete')
    expect(md).toContain('_No journal entry._')
  })
})
