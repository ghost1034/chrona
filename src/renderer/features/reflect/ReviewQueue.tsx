import { useEffect, useState } from 'react'
import type { TimelineCardDTO } from '../../../shared/timeline'
import { formatClockAscii } from '../../../shared/time'
import { Icon } from '../../components/Icon'

export function ReviewQueue(props: {
  cards: TimelineCardDTO[]
  coverage: Record<number, number>
  onRate: (card: TimelineCardDTO, rating: 'focus' | 'neutral' | 'distracted') => void
}) {
  const [index, setIndex] = useState(0)
  const rows = props.cards
    .filter((card) => card.category !== 'System')
    .map((card) => ({ card, coverage: props.coverage[card.id] ?? 0 }))
    .filter((item) => item.coverage < .8)
    .sort((a, b) => a.card.startTs - b.card.startTs)
  const safeIndex = Math.max(0, Math.min(index, rows.length - 1))
  const current = rows[safeIndex]

  useEffect(() => {
    if (index >= rows.length) setIndex(Math.max(0, rows.length - 1))
  }, [index, rows.length])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const element = document.activeElement as HTMLElement | null
      if (element && ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return
      if (!current) return
      const rating = ({ '1': 'focus', '2': 'neutral', '3': 'distracted' } as const)[event.key as '1' | '2' | '3']
      if (rating) { event.preventDefault(); props.onRate(current.card, rating) }
      if (event.key === 'ArrowLeft') { event.preventDefault(); setIndex((value) => Math.max(0, value - 1)) }
      if (event.key === 'ArrowRight') { event.preventDefault(); setIndex((value) => Math.min(rows.length - 1, value + 1)) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [current, props, rows.length])

  if (!current) return <div className="reviewEmpty reviewComplete"><div className="emptyStateIcon" aria-hidden="true">✓</div><div className="sideTitle">You’re all caught up</div><div className="sideMeta">Every activity is at least 80% reviewed.</div></div>

  return (
    <div className="reviewQueue">
      <div className="reviewHeader"><div><div className="eyebrow">Daily review</div><div className="sideTitle">How focused was this activity?</div></div><div className="reviewProgressCopy">{safeIndex + 1} of {rows.length}</div></div>
      <div className="reviewProgress" aria-label={`${safeIndex + 1} of ${rows.length} activities`}><span style={{ width: `${((safeIndex + 1) / rows.length) * 100}%` }} /></div>
      <article className="reviewFocusCard"><div className="reviewTime">{formatClockAscii(current.card.startTs)} — {formatClockAscii(current.card.endTs)}</div><h2>{current.card.title}</h2><div className="reviewCategory"><span />{current.card.category}{current.card.subcategory ? ` · ${current.card.subcategory}` : ''}</div>{current.card.summary ? <p>{current.card.summary}</p> : null}<div className="reviewCoverageNote">Currently {Math.round(current.coverage * 100)}% covered · 80% completes this activity</div></article>
      <div className="reviewRatingActions" aria-label="Focus rating">
        <button onClick={() => props.onRate(current.card, 'focus')}><Icon name="focus" /><span><strong>Focus</strong><small>Intentional, productive</small></span><kbd>1</kbd></button>
        <button onClick={() => props.onRate(current.card, 'neutral')}><Icon name="neutral" /><span><strong>Neutral</strong><small>Necessary or routine</small></span><kbd>2</kbd></button>
        <button onClick={() => props.onRate(current.card, 'distracted')}><Icon name="distracted" /><span><strong>Distracted</strong><small>Unplanned, low value</small></span><kbd>3</kbd></button>
      </div>
      <div className="reviewNavActions"><button className="btn btn-quiet" disabled={safeIndex === 0} onClick={() => setIndex((value) => Math.max(0, value - 1))}>← Previous</button><button className="btn btn-quiet" disabled={safeIndex === rows.length - 1} onClick={() => setIndex((value) => Math.min(rows.length - 1, value + 1))}>Skip for now →</button></div>
    </div>
  )
}
