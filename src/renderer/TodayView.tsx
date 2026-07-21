import { useEffect, useMemo, useState } from 'react'
import type { DashboardStatsDTO } from '../shared/dashboard'
import type { TimelineCardDTO } from '../shared/timeline'
import type { CategoryDefinition } from '../shared/categories'
import { dayWindowForDayKey, formatClockAscii } from '../shared/time'
import { getCategoryColor } from '../shared/categoryColors'

export function TodayView(props: {
  dayKey: string
  cards: TimelineCardDTO[]
  categories: CategoryDefinition[]
  recording: boolean
  systemPaused: boolean
  lastError: string | null
  hasGeminiKey: boolean | null
  onToggleRecording: () => Promise<void>
  onOpenTimeline: (cardId?: number) => void
  onOpenReview: () => void
  onOpenJournal: () => void
  onOpenSettings: () => void
}) {
  const [stats, setStats] = useState<DashboardStatsDTO | null>(null)
  const [journalState, setJournalState] = useState<'none' | 'draft' | 'complete' | 'loading'>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const scope = dayWindowForDayKey(props.dayKey)
    setError(null)
    setJournalState('loading')
    void Promise.all([
      window.chrona.getDashboardStats(scope, { includeSystem: false }),
      window.chrona.getJournalDay(props.dayKey)
    ])
      .then(([nextStats, journal]) => {
        if (cancelled) return
        setStats(nextStats)
        setJournalState(journal.entry?.status ?? 'none')
      })
      .catch((cause) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setJournalState('none')
      })
    return () => {
      cancelled = true
    }
  }, [props.dayKey, props.cards])

  const colors = useMemo(() => {
    const result: Record<string, string> = {}
    for (const category of props.categories) result[category.name] = category.color
    return result
  }, [props.categories])

  const recentCards = useMemo(
    () => props.cards.filter((card) => card.category !== 'System').slice(-5).reverse(),
    [props.cards]
  )

  const coverage = stats?.review.coverageFraction ?? 0
  const nextAction = !props.recording
    ? { label: 'Start recording', action: () => void props.onToggleRecording() }
    : coverage < 0.8 && (stats?.review.unreviewedCardCount ?? 0) > 0
      ? { label: `Review ${stats?.review.unreviewedCardCount ?? 0} activities`, action: props.onOpenReview }
      : journalState !== 'complete'
        ? { label: journalState === 'none' ? 'Start today’s journal' : 'Finish today’s journal', action: props.onOpenJournal }
        : { label: 'Explore your timeline', action: () => props.onOpenTimeline() }

  return (
    <div className="todayView">
      <section className="todayHero" aria-labelledby="today-heading">
        <div>
          <div className="eyebrow">Capture → understand → reflect</div>
          <h2 id="today-heading">{props.systemPaused ? 'Capture is paused' : props.recording ? 'Capture is healthy' : 'Capture is off'}</h2>
          <p>{recentCards[0] ? `Most recent: ${recentCards[0].title} at ${formatClockAscii(recentCards[0].startTs)}.` : 'No activity has been captured for this day yet.'}</p>
        </div>
        <button className="btn btn-accent todayPrimaryAction" onClick={nextAction.action}>
          {nextAction.label}
          <span aria-hidden="true">→</span>
        </button>
      </section>

      {(props.lastError || props.systemPaused || props.hasGeminiKey === false) && (
        <section className="healthBanner" aria-label="Recording and analysis health">
          <span className={`statusDot ${props.lastError ? 'danger' : 'warning'}`} aria-hidden="true" />
          <div>
            <strong>{props.lastError ? 'Capture needs attention' : props.systemPaused ? 'Capture is paused' : 'Analysis is waiting'}</strong>
            <p>{props.lastError ?? (props.systemPaused ? 'Chrona will resume when your computer is active.' : 'Add a Gemini key to analyze recorded activity.')}</p>
          </div>
          <button className="btn btn-quiet" onClick={props.onOpenSettings}>Open settings</button>
        </section>
      )}

      <section className="metricGrid" aria-label="Today’s summary">
        <Metric label="Tracked time" value={formatDuration(stats?.trackedSeconds ?? 0)} hint={`${props.cards.length} timeline cards`} />
        <Metric label="Reviewed focus" value={formatDuration(stats?.review.focusSeconds ?? 0)} hint="Rated as focused" />
        <Metric label="Review coverage" value={`${Math.round(coverage * 100)}%`} hint="80% daily target" progress={coverage} />
        <Metric label="Journal" value={journalState === 'loading' ? 'Loading…' : sentenceCase(journalState)} hint={journalState === 'complete' ? 'Ready to revisit' : 'A quiet place to reflect'} />
      </section>

      <div className="todayGrid">
        <section className="todaySection" aria-labelledby="recent-heading">
          <div className="sectionHeading">
            <div>
              <div className="eyebrow">Timeline</div>
              <h3 id="recent-heading">Recent activity</h3>
            </div>
            <button className="btn btn-quiet" onClick={() => props.onOpenTimeline()}>View full day</button>
          </div>
          {recentCards.length ? (
            <div className="todayActivityList">
              {recentCards.map((card) => (
                <button key={card.id} className="todayActivity" onClick={() => props.onOpenTimeline(card.id)}>
                  <span className="categoryMark" style={{ background: getCategoryColor(card.category, colors) }} />
                  <span className="todayActivityTime">{formatClockAscii(card.startTs)}</span>
                  <span className="todayActivityCopy">
                    <strong>{card.title}</strong>
                    <small>{card.category}{card.subcategory ? ` · ${card.subcategory}` : ''}</small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="emptyState">
              <div className="emptyStateIcon" aria-hidden="true">○</div>
              <strong>Your day is ready to begin</strong>
              <p>Start recording and activity will appear here as Chrona analyzes it.</p>
              <button className="btn btn-accent" onClick={() => void props.onToggleRecording()}>
                {props.recording ? 'Recording is on' : 'Start recording'}
              </button>
            </div>
          )}
        </section>

        <section className="todaySection todayReflection" aria-labelledby="reflection-heading">
          <div className="eyebrow">Reflection</div>
          <h3 id="reflection-heading">Today’s journal</h3>
          <p>{journalState === 'complete' ? 'Your reflection is complete. Return whenever you want to add another thought.' : 'Capture a decision, a useful detail, or what you want to remember tomorrow.'}</p>
          <button className="btn" onClick={props.onOpenJournal}>{journalState === 'none' ? 'Start writing' : 'Open journal'}</button>
          <div className="reflectionRule" />
          <div className="miniStat">
            <span>Longest work block</span>
            <strong>{formatDuration(stats?.blocks.longestWorkBlockSeconds ?? 0)}</strong>
          </div>
          {error ? <div className="inlineError" role="status">Couldn’t refresh summary: {error}</div> : null}
        </section>
      </div>
    </div>
  )
}

function Metric(props: { label: string; value: string; hint: string; progress?: number }) {
  return (
    <article className="metricCard">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {typeof props.progress === 'number' ? (
        <div className="metricProgress" aria-label={`${Math.round(props.progress * 100)} percent`}>
          <span style={{ width: `${Math.min(100, props.progress * 100)}%` }} />
        </div>
      ) : null}
      <small>{props.hint}</small>
    </article>
  )
}

function formatDuration(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60))
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (!hours) return `${remainder}m`
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
