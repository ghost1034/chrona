import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TimelineCardDTO, TimelineSearchHitDTO } from '../../../shared/timeline'
import { dayWindowForDayKey, formatClockAscii } from '../../../shared/time'
import { Icon } from '../../components/Icon'

type Action = {
  id: string
  label: string
  detail: string
  keywords: string
  icon: Parameters<typeof Icon>[0]['name']
  run: () => void | Promise<void>
}

export function QuickAccess(props: {
  platform: 'darwin' | 'win32' | 'linux'
  dayKey: string
  nowTs: number
  recording: boolean
  onNavigate: (target: 'today' | 'timeline' | 'reflect' | 'insights' | 'ask' | 'settings') => void
  onToggleRecording: () => Promise<void>
  onJumpToCard: (card: TimelineCardDTO) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<TimelineSearchHitDTO[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const runId = useRef(0)
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      setOpen((value) => {
        if (!value) openerRef.current = document.activeElement as HTMLElement | null
        return !value
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const actions = useMemo<Action[]>(() => [
    { id: 'today', label: 'Go to Today', detail: 'Daily capture health and activity', keywords: 'home now', icon: 'sun', run: () => props.onNavigate('today') },
    { id: 'timeline', label: 'Go to Timeline', detail: 'Browse the selected day', keywords: 'activity history', icon: 'timeline', run: () => props.onNavigate('timeline') },
    { id: 'reflect', label: 'Go to Reflect', detail: 'Review and journal', keywords: 'review journal write', icon: 'book', run: () => props.onNavigate('reflect') },
    { id: 'insights', label: 'Go to Insights', detail: 'Patterns across your time', keywords: 'stats dashboard charts', icon: 'chart', run: () => props.onNavigate('insights') },
    { id: 'ask', label: 'Go to Ask', detail: 'Explore activity with AI', keywords: 'question ai assistant', icon: 'spark', run: () => props.onNavigate('ask') },
    { id: 'capture', label: props.recording ? 'Stop recording' : 'Start recording', detail: 'Toggle screen capture', keywords: 'capture pause resume', icon: props.recording ? 'close' : 'focus', run: props.onToggleRecording },
    { id: 'settings', label: 'Open Settings', detail: 'Preferences, privacy, and data', keywords: 'preferences configuration', icon: 'settings', run: () => props.onNavigate('settings') }
  ], [props])

  const filteredActions = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return actions
    return actions.filter((action) => {
      const haystack = `${action.label} ${action.detail} ${action.keywords}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [actions, query])

  useEffect(() => {
    const value = query.trim()
    if (!open || value.length < 2) {
      runId.current += 1
      setHits([])
      setLoading(false)
      setError(null)
      return
    }
    const currentRun = ++runId.current
    setLoading(true)
    setError(null)
    const timer = window.setTimeout(() => {
      const today = dayWindowForDayKey(props.dayKey)
      void window.chrona.searchTimeline({
        query: value,
        scope: { startTs: 0, endTs: Math.max(today.endTs, props.nowTs) },
        filters: { includeSystem: true },
        limit: 8,
        offset: 0
      }).then((result) => {
        if (runId.current !== currentRun) return
        setHits(result.hits.slice(0, 8))
      }).catch((cause) => {
        if (runId.current !== currentRun) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setHits([])
      }).finally(() => {
        if (runId.current === currentRun) setLoading(false)
      })
    }, 150)
    return () => window.clearTimeout(timer)
  }, [open, props.dayKey, props.nowTs, query])

  const items = [
    ...filteredActions.map((action) => ({ id: `action:${action.id}`, action })),
    ...hits.map((hit) => ({ id: `card:${hit.card.dayKey}:${hit.card.id}`, hit }))
  ]
  const safeIndex = Math.min(activeIndex, Math.max(0, items.length - 1))

  function execute(index: number) {
    const item = items[index]
    if (!item) return
    setOpen(false)
    setQuery('')
    if ('action' in item) void item.action.run()
    else props.onJumpToCard(item.hit.card)
  }

  return (
    <Dialog.Root open={open} onOpenChange={(value) => { setOpen(value); if (!value) setQuery('') }}>
      <Dialog.Portal>
        <Dialog.Overlay className="quickAccessOverlay" />
        <Dialog.Content
          className="quickAccess"
          aria-describedby="quick-access-hint"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            openerRef.current?.focus()
          }}
        >
          <Dialog.Title className="srOnly">Quick access</Dialog.Title>
          <div className="quickAccessInputRow">
            <Icon name="search" />
            <input
              autoFocus
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((value) => Math.min(items.length - 1, value + 1)) }
                if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((value) => Math.max(0, value - 1)) }
                if (event.key === 'Enter') { event.preventDefault(); execute(safeIndex) }
              }}
              placeholder="Search Chrona or jump to activity…"
              aria-label="Quick access search"
              aria-controls="quick-access-results"
              aria-activedescendant={items[safeIndex]?.id}
            />
            <kbd>Esc</kbd>
          </div>
          <div className="quickAccessResults" id="quick-access-results" role="listbox">
            {filteredActions.length ? <div className="quickAccessGroupLabel">Actions</div> : null}
            {filteredActions.map((action, index) => (
              <button id={`action:${action.id}`} role="option" aria-selected={safeIndex === index} className={safeIndex === index ? 'active' : ''} key={action.id} onMouseMove={() => setActiveIndex(index)} onClick={() => execute(index)}>
                <Icon name={action.icon} /><span><strong>{action.label}</strong><small>{action.detail}</small></span>
              </button>
            ))}
            {query.trim().length >= 2 ? <div className="quickAccessGroupLabel">Timeline {loading ? '· Searching…' : ''}</div> : null}
            {hits.map((hit, hitIndex) => {
              const index = filteredActions.length + hitIndex
              return <button id={`card:${hit.card.dayKey}:${hit.card.id}`} role="option" aria-selected={safeIndex === index} className={safeIndex === index ? 'active' : ''} key={`${hit.card.dayKey}:${hit.card.id}`} onMouseMove={() => setActiveIndex(index)} onClick={() => execute(index)}>
                <Icon name="timeline" /><span><strong>{hit.card.title}</strong><small>{hit.card.dayKey} · {formatClockAscii(hit.card.startTs)} · {hit.card.category}</small></span>
              </button>
            })}
            {!loading && !error && query.trim().length >= 2 && items.length === 0 ? <div className="quickAccessState">No matching actions or activities.</div> : null}
            {error ? <div className="quickAccessState error" role="status">Timeline search unavailable: {error}</div> : null}
          </div>
          <div className="quickAccessFooter" id="quick-access-hint"><span><kbd>↑</kbd><kbd>↓</kbd> Move</span><span><kbd>↵</kbd> Open</span><span>{props.platform === 'darwin' ? '⌘K' : 'Ctrl+K'} Quick access</span></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
