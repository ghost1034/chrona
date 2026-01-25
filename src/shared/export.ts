import type { TimelineCardDTO } from './timeline'
import { formatClockAscii } from './time'

export function formatDayForClipboard(opts: {
  dayKey: string
  cards: TimelineCardDTO[]
}): string {
  const lines: string[] = []
  lines.push(`Dayflow timeline · ${opts.dayKey}`)
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
