import type { TimelineCardDTO } from './timeline'
import { formatClockAscii } from './time'
import type { JournalEntryDTO } from './journal'

export function formatDayForClipboard(opts: {
  dayKey: string
  cards: TimelineCardDTO[]
}): string {
  const lines: string[] = []
  lines.push(`Chrona timeline · ${opts.dayKey}`)
  lines.push('')

  const cards = [...opts.cards].sort((a, b) => a.startTs - b.startTs)
  let i = 1
  for (const c of cards) {
    const start = formatClockAscii(c.startTs)
    const end = formatClockAscii(c.endTs)
    lines.push(`${i}. ${start} - ${end} — ${c.title}`)
    if (c.summary) lines.push(`   Summary: ${c.summary}`)
    if (c.detailedSummary) lines.push(`   Details: ${c.detailedSummary}`)
    lines.push(`   Category: ${c.category}${c.subcategory ? ` / ${c.subcategory}` : ''}`)
    lines.push('')
    i += 1
  }

  return lines.join('\n').trimEnd() + '\n'
}

export function formatRangeMarkdown(opts: {
  startDayKey: string
  endDayKey: string
  days: Array<{ dayKey: string; cards: TimelineCardDTO[] }>
}): string {
  const sections: string[] = []
  for (const d of opts.days) {
    sections.push(`## ${d.dayKey}`)
    sections.push('')
    const cards = [...d.cards].sort((a, b) => a.startTs - b.startTs)
    let i = 1
    for (const c of cards) {
      const start = formatClockAscii(c.startTs)
      const end = formatClockAscii(c.endTs)
      sections.push(`${i}. ${start} - ${end} — ${c.title}`)
      if (c.summary) sections.push(`   - Summary: ${c.summary}`)
      if (c.detailedSummary) sections.push(`   - Details: ${c.detailedSummary}`)
      sections.push(`   - Category: ${c.category}${c.subcategory ? ` / ${c.subcategory}` : ''}`)
      sections.push('')
      i += 1
    }
    sections.push('---')
    sections.push('')
  }

  // Drop trailing separator.
  while (sections.length > 0 && sections[sections.length - 1] === '') sections.pop()
  if (sections[sections.length - 1] === '---') sections.pop()
  if (sections[sections.length - 1] === '') sections.pop()

  return sections.join('\n') + '\n'
}

export function formatJournalDayForClipboard(opts: {
  dayKey: string
  entry: JournalEntryDTO | null
}): string {
  const lines: string[] = []
  lines.push(`# Chrona journal · ${opts.dayKey}`)
  lines.push('')

  if (!opts.entry) {
    lines.push('_No journal entry._')
    lines.push('')
    return lines.join('\n').trimEnd() + '\n'
  }

  lines.push(`Status: ${opts.entry.status}`)
  lines.push('')

  lines.push('## Intentions')
  lines.push('')
  lines.push(opts.entry.intentions?.trim() ? opts.entry.intentions.trim() : '_None._')
  lines.push('')

  lines.push('## Notes')
  lines.push('')
  lines.push(opts.entry.notes?.trim() ? opts.entry.notes.trim() : '_None._')
  lines.push('')

  lines.push('## Reflections')
  lines.push('')
  lines.push(opts.entry.reflections?.trim() ? opts.entry.reflections.trim() : '_None._')
  lines.push('')

  lines.push('## Summary')
  lines.push('')
  lines.push(opts.entry.summary?.trim() ? opts.entry.summary.trim() : '_None._')
  lines.push('')

  return lines.join('\n').trimEnd() + '\n'
}

export function formatJournalRangeMarkdown(opts: {
  startDayKey: string
  endDayKey: string
  entries: JournalEntryDTO[]
}): string {
  const map = new Map<string, JournalEntryDTO>()
  for (const e of opts.entries) map.set(e.dayKey, e)

  const days = listDayKeysInRange(opts.startDayKey, opts.endDayKey)

  const sections: string[] = []
  for (const dayKey of days) {
    const entry = map.get(dayKey) ?? null
    sections.push(`## ${dayKey}`)
    sections.push('')
    if (!entry) {
      sections.push('_No journal entry._')
      sections.push('')
      sections.push('---')
      sections.push('')
      continue
    }

    sections.push(`Status: ${entry.status}`)
    sections.push('')

    sections.push('### Intentions')
    sections.push('')
    sections.push(entry.intentions?.trim() ? entry.intentions.trim() : '_None._')
    sections.push('')

    sections.push('### Notes')
    sections.push('')
    sections.push(entry.notes?.trim() ? entry.notes.trim() : '_None._')
    sections.push('')

    sections.push('### Reflections')
    sections.push('')
    sections.push(entry.reflections?.trim() ? entry.reflections.trim() : '_None._')
    sections.push('')

    sections.push('### Summary')
    sections.push('')
    sections.push(entry.summary?.trim() ? entry.summary.trim() : '_None._')
    sections.push('')

    sections.push('---')
    sections.push('')
  }

  // Drop trailing separator.
  while (sections.length > 0 && sections[sections.length - 1] === '') sections.pop()
  if (sections[sections.length - 1] === '---') sections.pop()
  if (sections[sections.length - 1] === '') sections.pop()

  return sections.join('\n') + '\n'
}

function listDayKeysInRange(startDayKey: string, endDayKey: string): string[] {
  const start = parseDayKey(startDayKey)
  const end = parseDayKey(endDayKey)
  if (!start || !end) throw new Error('Invalid dayKey')
  if (start.getTime() > end.getTime()) throw new Error('startDayKey must be <= endDayKey')

  const out: string[] = []
  const d = new Date(start)
  while (d.getTime() <= end.getTime()) {
    out.push(formatYYYYMMDDLocal(d))
    d.setDate(d.getDate() + 1)
  }
  return out
}

function parseDayKey(dayKey: string): Date | null {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(dayKey)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const da = Number(m[3])
  const d = new Date(y, mo, da, 0, 0, 0, 0)
  return Number.isNaN(d.getTime()) ? null : d
}

function formatYYYYMMDDLocal(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
