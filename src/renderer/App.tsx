import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TimelineCardDTO } from '../shared/timeline'
import { dayKeyFromUnixSeconds, dayWindowForDayKey, formatClockAscii } from '../shared/time'
import { formatBytes } from '../shared/format'
import type { AskSourceRef } from '../shared/ask'
import { DashboardView } from './DashboardView'

type DisplayInfo = { id: string; bounds: { width: number; height: number }; scaleFactor: number }

const HOURS_IN_TIMELINE = 24
const TIMELINE_GRID_PADDING_PX = 16
const TIMELINE_ZOOM_DEFAULT_PX_PER_HOUR = 600
const TIMELINE_ZOOM_MIN_PX_PER_HOUR = 50
const TIMELINE_ZOOM_MAX_PX_PER_HOUR = 3600
const TIMELINE_MIN_CARD_HEIGHT_PX = 1

const CARD_TINY_MAX_HEIGHT_PX = 16
const CARD_SMALL_MAX_HEIGHT_PX = 44

type TimelineMetrics = {
  contentHeightPx: number
  gridHeightPx: number
}

export function App() {
  const [interval, setInterval] = useState<number | null>(null)
  const [recording, setRecording] = useState<boolean>(false)
  const [systemPaused, setSystemPaused] = useState<boolean>(false)
  const [statusLine, setStatusLine] = useState<string>('')
  const [lastError, setLastError] = useState<string | null>(null)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [selectedDisplayId, setSelectedDisplayId] = useState<string | null>(null)
  const [analysisLine, setAnalysisLine] = useState<string>('')

  const [hasGeminiKey, setHasGeminiKey] = useState<boolean | null>(null)
  const [geminiKeyInput, setGeminiKeyInput] = useState<string>('')
  const [timelapsesEnabled, setTimelapsesEnabled] = useState<boolean>(false)
  const [autoStartEnabled, setAutoStartEnabled] = useState<boolean>(false)

  const [storageUsage, setStorageUsage] = useState<{
    recordingsBytes: number
    timelapsesBytes: number
    recordingsLimitBytes: number
    timelapsesLimitBytes: number
  } | null>(null)
  const [limitRecordingsGb, setLimitRecordingsGb] = useState<string>('10')
  const [limitTimelapsesGb, setLimitTimelapsesGb] = useState<string>('10')

  const [dayKey, setDayKey] = useState<string>(() => dayKeyFromUnixSeconds(Math.floor(Date.now() / 1000)))
  const [cards, setCards] = useState<TimelineCardDTO[]>([])
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [view, setView] = useState<'timeline' | 'review' | 'ask' | 'dashboard'>('timeline')
  const [reviewCoverage, setReviewCoverage] = useState<Record<number, number>>({})

  const [timelinePxPerHour, setTimelinePxPerHour] = useState<number>(TIMELINE_ZOOM_DEFAULT_PX_PER_HOUR)
  const timelineScrollRef = useRef<HTMLDivElement | null>(null)
  const didInitTimelineZoomRef = useRef<boolean>(false)
  const saveTimelineZoomTimeoutRef = useRef<number | null>(null)
  const selectedCard = useMemo(
    () => cards.find((c) => c.id === selectedCardId) ?? null,
    [cards, selectedCardId]
  )

  const [selectedVideoUrl, setSelectedVideoUrl] = useState<string | null>(null)

  const [askMessages, setAskMessages] = useState<
    Array<{ id: string; role: 'user' | 'assistant'; content: string; sources?: AskSourceRef[] }>
  >([])
  const [askInput, setAskInput] = useState<string>('')
  const [askLoading, setAskLoading] = useState<boolean>(false)
  const [askError, setAskError] = useState<string | null>(null)
  const [askFollowUps, setAskFollowUps] = useState<string[]>([])
  const [askScopePreset, setAskScopePreset] = useState<'day' | 'today' | 'yesterday' | 'last7' | 'last30'>(
    'day'
  )
  const [askUseObservations, setAskUseObservations] = useState<boolean>(true)
  const [askIncludeReview, setAskIncludeReview] = useState<boolean>(true)
  const askScrollRef = useRef<HTMLDivElement | null>(null)
  const pendingJumpRef = useRef<{ dayKey: string; cardId: number } | null>(null)

  useEffect(() => {
    void (async () => {
      const state = await window.chrona.getCaptureState()
      setInterval(state.intervalSeconds)
      setRecording(state.desiredRecordingEnabled)
      setSystemPaused(state.isSystemPaused)
      setLastError(state.lastError)
      setSelectedDisplayId(state.selectedDisplayId)
      setStatusLine(formatCaptureStatus(state))

      setDisplays(await window.chrona.listDisplays())
      setHasGeminiKey((await window.chrona.hasGeminiApiKey()).hasApiKey)

      const settings = await window.chrona.getSettings()
      setTimelapsesEnabled(!!settings.timelapsesEnabled)
      setTimelinePxPerHour(
        clampTimelinePxPerHour(settings.timelinePxPerHour ?? TIMELINE_ZOOM_DEFAULT_PX_PER_HOUR)
      )
      setAutoStartEnabled((await window.chrona.getAutoStartEnabled()).enabled)

      const usage = await window.chrona.getStorageUsage()
      setStorageUsage(usage)
      setLimitRecordingsGb(String(Math.round(usage.recordingsLimitBytes / (1024 * 1024 * 1024))))
      setLimitTimelapsesGb(String(Math.round(usage.timelapsesLimitBytes / (1024 * 1024 * 1024))))
    })()

    const unsubState = window.chrona.onRecordingStateChanged((state) => {
      setInterval(state.intervalSeconds)
      setRecording(state.desiredRecordingEnabled)
      setSystemPaused(state.isSystemPaused)
      setLastError(state.lastError)
      setSelectedDisplayId(state.selectedDisplayId)
      setStatusLine(formatCaptureStatus(state))
    })

    const unsubErr = window.chrona.onCaptureError((err) => {
      setLastError(err.message)
    })

    const unsubAnalysis = window.chrona.onAnalysisBatchUpdated((p) => {
      setAnalysisLine(`batch ${p.batchId}: ${p.status}${p.reason ? ` (${p.reason})` : ''}`)
    })

    const unsubUsage = window.chrona.onStorageUsageUpdated((u) => {
      setStorageUsage(u)
    })

    return () => {
      unsubState()
      unsubErr()
      unsubAnalysis()
      unsubUsage()
    }
  }, [])

  useEffect(() => {
    void (async () => {
      if (!selectedCard || !selectedCard.videoSummaryUrl) {
        setSelectedVideoUrl(null)
        return
      }
      try {
        const res = await window.chrona.resolveFileUrl(selectedCard.videoSummaryUrl)
        setSelectedVideoUrl(res.fileUrl)
      } catch {
        setSelectedVideoUrl(null)
      }
    })()
  }, [selectedCardId])

  useEffect(() => {
    void refreshDay(dayKey, false)
  }, [dayKey])

  useEffect(() => {
    if (view !== 'ask') return
    // Keep chat scrolled to bottom on updates.
    requestAnimationFrame(() => {
      const el = askScrollRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
    })
  }, [askMessages, view, askLoading])

  useEffect(() => {
    if (!didInitTimelineZoomRef.current) {
      didInitTimelineZoomRef.current = true
      return
    }

    if (saveTimelineZoomTimeoutRef.current !== null) {
      window.clearTimeout(saveTimelineZoomTimeoutRef.current)
    }

    saveTimelineZoomTimeoutRef.current = window.setTimeout(() => {
      void window.chrona.updateSettings({ timelinePxPerHour })
    }, 300)

    return () => {
      if (saveTimelineZoomTimeoutRef.current !== null) {
        window.clearTimeout(saveTimelineZoomTimeoutRef.current)
      }
    }
  }, [timelinePxPerHour])

  useEffect(() => {
    if (view !== 'review') return
    void refreshReview(dayKey)
  }, [view, dayKey])

  useEffect(() => {
    const unsub = window.chrona.onTimelineUpdated((p) => {
      if (p.dayKey !== dayKey) return
      void refreshDay(dayKey, true)
    })
    return () => unsub()
  }, [dayKey])

  async function refreshDay(k: string, preserveSelection: boolean) {
    const day = await window.chrona.getTimelineDay(k)
    const nextCards = resolveOverlapsForDisplay(day.cards)
    setCards(nextCards)

    setSelectedCardId((_prev) => {
      const pending = pendingJumpRef.current
      if (pending && pending.dayKey === k) {
        pendingJumpRef.current = null
        return nextCards.some((c) => c.id === pending.cardId) ? pending.cardId : null
      }

      if (!preserveSelection) return null
      if (_prev === null) return null
      return nextCards.some((c) => c.id === _prev) ? _prev : null
    })
  }

  async function refreshReview(k: string) {
    const res = await window.chrona.getReviewDay(k)
    setReviewCoverage(res.coverageByCardId)
  }

  async function onSaveInterval() {
    if (interval === null || !Number.isFinite(interval) || interval <= 0) return
    const next = await window.chrona.setCaptureInterval(interval)
    setInterval(next.intervalSeconds)
  }

  async function onSelectDisplay(id: string) {
    const displayId = id === 'auto' ? null : id
    setSelectedDisplayId(displayId)
    await window.chrona.setSelectedDisplay(displayId)
  }

  async function onRunAnalysisTick() {
    const res = await window.chrona.runAnalysisTick()
    setAnalysisLine(`tick: created=${res.createdBatchIds.length} unprocessed=${res.unprocessedCount}`)
  }

  async function onSaveGeminiKey() {
    if (!geminiKeyInput.trim()) return
    await window.chrona.setGeminiApiKey(geminiKeyInput)
    setGeminiKeyInput('')
    setHasGeminiKey((await window.chrona.hasGeminiApiKey()).hasApiKey)
  }

  async function onSaveStorageLimits() {
    const recGb = Number(limitRecordingsGb)
    const tlGb = Number(limitTimelapsesGb)
    if (!Number.isFinite(recGb) || recGb <= 0) return
    if (!Number.isFinite(tlGb) || tlGb <= 0) return

    await window.chrona.updateSettings({
      storageLimitRecordingsBytes: Math.floor(recGb * 1024 * 1024 * 1024),
      storageLimitTimelapsesBytes: Math.floor(tlGb * 1024 * 1024 * 1024)
    })
    const usage = await window.chrona.getStorageUsage()
    setStorageUsage(usage)
  }

  async function onToggleTimelapsesEnabled(enabled: boolean) {
    setTimelapsesEnabled(enabled)
    await window.chrona.updateSettings({ timelapsesEnabled: enabled })
  }

  async function onToggleAutoStartEnabled(enabled: boolean) {
    const res = await window.chrona.setAutoStartEnabled(enabled)
    setAutoStartEnabled(res.enabled)
  }

  async function onPurgeNow() {
    const res = await window.chrona.purgeStorageNow()
    setAnalysisLine(
      `purge: screenshots=${res.deletedScreenshotCount} timelapses=${res.deletedTimelapseCount} freed=${formatBytes(res.freedRecordingsBytes + res.freedTimelapsesBytes)}`
    )
    const usage = await window.chrona.getStorageUsage()
    setStorageUsage(usage)
  }

  async function onToggleRecording() {
    const next = await window.chrona.setRecordingEnabled(!recording)
    setRecording(next.desiredRecordingEnabled)
    setSystemPaused(next.isSystemPaused)
    setStatusLine(formatCaptureStatus(next))
  }

  async function onCopyDay() {
    await window.chrona.copyDayToClipboard(dayKey)
  }

  async function onExportDay() {
    await window.chrona.saveMarkdownRange(dayKey, dayKey)
  }

  async function onApplyRating(card: TimelineCardDTO, rating: 'focus' | 'neutral' | 'distracted') {
    await window.chrona.applyReviewRating(card.startTs, card.endTs, rating)
    await refreshReview(dayKey)
  }

  function shiftDay(deltaDays: number) {
    const base = new Date(dayKey + 'T00:00:00')
    base.setDate(base.getDate() + deltaDays)
    const next = dayKeyFromUnixSeconds(Math.floor(base.getTime() / 1000) + 4 * 60 * 60)
    setDayKey(next)
  }

  const timelineMetrics = useMemo(() => getTimelineMetrics(timelinePxPerHour), [timelinePxPerHour])

  const applyZoom = useCallback(
    (nextPxPerHourRaw: number, opts?: { anchorY?: number }) => {
      const nextPxPerHour = clampTimelinePxPerHour(nextPxPerHourRaw)
      if (nextPxPerHour === timelinePxPerHour) return

      const scroller = timelineScrollRef.current
      if (!scroller) {
        setTimelinePxPerHour(nextPxPerHour)
        return
      }

      const anchorY = opts?.anchorY ?? scroller.clientHeight / 2
      const oldContentHeightPx = HOURS_IN_TIMELINE * timelinePxPerHour
      const newContentHeightPx = HOURS_IN_TIMELINE * nextPxPerHour

      const oldAnchorPosPx = scroller.scrollTop + anchorY
      const progress = clampNumber(
        (oldAnchorPosPx - TIMELINE_GRID_PADDING_PX) / oldContentHeightPx,
        0,
        1
      )

      setTimelinePxPerHour(nextPxPerHour)

      requestAnimationFrame(() => {
        const scroller2 = timelineScrollRef.current
        if (!scroller2) return
        const newAnchorPosPx = TIMELINE_GRID_PADDING_PX + progress * newContentHeightPx
        scroller2.scrollTop = Math.max(0, newAnchorPosPx - anchorY)
      })
    },
    [timelinePxPerHour]
  )

  const zoomIn = useCallback(
    (anchorY?: number) => applyZoom(timelinePxPerHour + 10, { anchorY }),
    [applyZoom, timelinePxPerHour]
  )
  const zoomOut = useCallback(
    (anchorY?: number) => applyZoom(timelinePxPerHour - 10, { anchorY }),
    [applyZoom, timelinePxPerHour]
  )
  const zoomReset = useCallback(
    (anchorY?: number) => applyZoom(TIMELINE_ZOOM_DEFAULT_PX_PER_HOUR, { anchorY }),
    [applyZoom]
  )

  useEffect(() => {
    if (view !== 'timeline') return
    const scroller = timelineScrollRef.current
    if (!scroller) return

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      if (e.deltaY === 0) return

      e.preventDefault()
      const rect = scroller.getBoundingClientRect()
      const anchorY = e.clientY - rect.top

      if (e.deltaY < 0) {
        applyZoom(Math.round(timelinePxPerHour * 1.1), { anchorY })
      } else {
        applyZoom(Math.round(timelinePxPerHour / 1.1), { anchorY })
      }
    }

    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [applyZoom, timelinePxPerHour, view])

  useEffect(() => {
    if (view !== 'timeline') return

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return

      if (e.key === '0') {
        e.preventDefault()
        zoomReset()
        return
      }

      // Cmd/Ctrl + is often reported as '=' with Shift.
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        zoomIn()
        return
      }

      if (e.key === '-') {
        e.preventDefault()
        zoomOut()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, zoomIn, zoomOut, zoomReset])

  const windowInfo = dayWindowForDayKey(dayKey)
  const isToday = dayKey === dayKeyFromUnixSeconds(Math.floor(Date.now() / 1000))
  const nowTs = Math.floor(Date.now() / 1000)
  const nowYpx =
    isToday && nowTs >= windowInfo.startTs && nowTs <= windowInfo.endTs
      ? timeToYpx(nowTs, windowInfo.startTs, windowInfo.endTs, timelineMetrics)
      : null

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="wordmark">Chrona</div>
          <div className="tagline">
            {view === 'ask'
              ? 'Ask Chrona'
              : view === 'review'
                ? 'Review'
                : view === 'dashboard'
                  ? 'Dashboard'
                  : `Timeline · ${dayKey}`}
          </div>
        </div>

        <div className="toolbar">
          <button
            className={`btn ${view === 'timeline' ? 'btn-accent' : ''}`}
            onClick={() => setView('timeline')}
          >
            Timeline
          </button>
          <button
            className={`btn ${view === 'review' ? 'btn-accent' : ''}`}
            onClick={() => setView('review')}
          >
            Review
          </button>
          <button className={`btn ${view === 'ask' ? 'btn-accent' : ''}`} onClick={() => setView('ask')}>
            Ask
          </button>
          <button
            className={`btn ${view === 'dashboard' ? 'btn-accent' : ''}`}
            onClick={() => setView('dashboard')}
          >
            Dashboard
          </button>
          <button className="btn" disabled={view !== 'timeline'} onClick={() => zoomOut()}>
            Zoom -
          </button>
          <button className="btn" disabled={view !== 'timeline'} onClick={() => zoomIn()}>
            Zoom +
          </button>
          <button className="btn" disabled={view !== 'timeline'} onClick={() => zoomReset()}>
            Reset
          </button>
          <div className="pill" title="Timeline zoom">
            Zoom {Math.round((timelinePxPerHour / TIMELINE_ZOOM_DEFAULT_PX_PER_HOUR) * 100)}%
          </div>
          <button className="btn" onClick={() => shiftDay(-1)}>
            Prev
          </button>
          <button
            className="btn"
            onClick={() => setDayKey(dayKeyFromUnixSeconds(Math.floor(Date.now() / 1000)))}
          >
            Today
          </button>
          <button className="btn" onClick={() => shiftDay(1)}>
            Next
          </button>
          <input
            className="input"
            type="date"
            value={dayKey}
            onChange={(e) => setDayKey(e.target.value)}
          />
          <button className="btn" onClick={() => void onCopyDay()}>
            Copy
          </button>
          <button className="btn" onClick={() => void onExportDay()}>
            Export
          </button>
        </div>
      </header>

      <main className="layout">
        {view === 'timeline' ? (
          <section className="timeline">
            <div className="timelineScroll" ref={timelineScrollRef}>
              <div className="timelineGrid" style={{ height: `${timelineMetrics.gridHeightPx}px` }}>
                {renderTimeTicks(windowInfo.startTs, timelinePxPerHour)}
                {nowYpx !== null ? <div className="nowLine" style={{ top: `${nowYpx}px` }} /> : null}

                {cards.map((c) => {
                  const layout = cardLayout(c, windowInfo.startTs, windowInfo.endTs, timelineMetrics)
                  return (
                    <div
                      key={c.id}
                      className={`card ${layout.sizeClass} ${selectedCardId === c.id ? 'selected' : ''} ${c.category === 'System' ? 'system' : ''}`}
                      style={layout.style}
                      onClick={() => setSelectedCardId(c.id)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="cardTitle">{c.title}</div>
                      <div className="cardMeta">
                        {formatClockAscii(c.startTs)} - {formatClockAscii(c.endTs)} · {c.category}
                      </div>

                      <div className="cardHover" aria-hidden="true">
                        <div className="cardHoverTitle">{c.title}</div>
                        <div className="cardHoverMeta">
                          {formatClockAscii(c.startTs)} - {formatClockAscii(c.endTs)} · {c.category}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>
        ) : view === 'review' ? (
          <section className="timeline">
            <div className="timelineScroll">
              <div className="reviewList">
                {renderReviewList(cards, reviewCoverage, (card, rating) => void onApplyRating(card, rating))}
              </div>
            </div>
          </section>
        ) : view === 'ask' ? (
          <section className="timeline">
            <div className="timelineScroll" ref={askScrollRef}>
              <div className="askWrap">
                {askMessages.length === 0 ? (
                  <div className="askEmpty">
                    <div className="sideTitle">Ask Chrona</div>
                    <div className="sideMeta">Ask questions about your time in the selected scope.</div>
                    <div className="askSuggestions">
                      {[
                        'What did I work on today?',
                        'How much time was Work vs Distraction?',
                        'What were my longest uninterrupted focus blocks?',
                        'Summarize this day in 5 bullets.',
                        'What did I do between 2 PM and 5 PM?',
                        'What were my biggest context switches?'
                      ].map((q) => (
                        <button
                          key={q}
                          className="chip"
                          disabled={askLoading}
                          onClick={() => {
                            setAskInput(q)
                            void onRunAsk(q)
                          }}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="askMessages">
                  {askMessages.map((m) => (
                    <div key={m.id} className={`askMsg ${m.role === 'user' ? 'user' : 'assistant'}`}>
                      <div className="askMsgRole">{m.role === 'user' ? 'You' : 'Chrona'}</div>
                      <div className="askMsgBody">{m.content}</div>
                      {m.role === 'assistant' && m.sources && m.sources.length > 0 ? (
                        <div className="askSources">
                          <div className="askSourcesLabel">Sources</div>
                          <div className="askSourcesChips">
                            {m.sources.slice(0, 12).map((s) => (
                              <button
                                key={`${m.id}:${s.cardId}`}
                                className="chip"
                                onClick={() => jumpToCard(s)}
                              >
                                {formatClockAscii(s.startTs)}-{formatClockAscii(s.endTs)} · {s.title}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))}

                  {askLoading ? (
                    <div className="askMsg assistant">
                      <div className="askMsgRole">Chrona</div>
                      <div className="askMsgBody">Thinking…</div>
                    </div>
                  ) : null}

                  {askError ? <div className="mono error">Ask error: {askError}</div> : null}

                  {askFollowUps.length > 0 && !askLoading ? (
                    <div className="askFollowUps">
                      {askFollowUps.map((q) => (
                        <button
                          key={q}
                          className="chip"
                          onClick={() => {
                            setAskInput(q)
                            void onRunAsk(q)
                          }}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="askComposer">
                  <textarea
                    className="input askInput"
                    rows={2}
                    placeholder="Ask about your time…"
                    value={askInput}
                    onChange={(e) => setAskInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        void onRunAsk(askInput)
                      }
                    }}
                  />
                  <button className="btn btn-accent" disabled={askLoading} onClick={() => void onRunAsk(askInput)}>
                    Ask
                  </button>
                </div>
                <div className="askHint mono">Tip: Cmd/Ctrl+Enter to send</div>
              </div>
            </div>
          </section>
        ) : (
          <section className="timeline">
            <div className="timelineScroll">
              <DashboardView
                selectedDayKey={dayKey}
                onJumpToDay={(k) => {
                  setDayKey(k)
                  setSelectedCardId(null)
                  setView('timeline')
                }}
              />
            </div>
          </section>
        )}

        <aside className="side">
          {view === 'ask' ? (
            <div className="sidePanel">
              <div className="sideTitle">Ask settings</div>
              <div className="sideMeta">
                Ask uses timeline text (and optionally observations) in the selected scope. Screenshots are not used
                for Ask.
              </div>

              <div className="field">
                <div className="label">Scope</div>
                <select
                  className="input"
                  value={askScopePreset}
                  disabled={askLoading}
                  onChange={(e) => {
                    const v = e.target.value as any
                    setAskScopePreset(v)
                    if (v === 'last30') setAskUseObservations(false)
                  }}
                >
                  <option value="day">Selected day ({dayKey})</option>
                  <option value="today">Today</option>
                  <option value="yesterday">Yesterday</option>
                  <option value="last7">Last 7 days</option>
                  <option value="last30">Last 30 days</option>
                </select>
              </div>

              <div className="row">
                <label className="pill">
                  <input
                    type="checkbox"
                    checked={askUseObservations}
                    onChange={(e) => setAskUseObservations(e.target.checked)}
                  />
                  Use observations
                </label>
              </div>

              <div className="row">
                <label className="pill">
                  <input
                    type="checkbox"
                    checked={askIncludeReview}
                    onChange={(e) => setAskIncludeReview(e.target.checked)}
                  />
                  Include review ratings
                </label>
              </div>

              <div className="row">
                <button
                  className="btn"
                  disabled={askLoading || askMessages.length === 0}
                  onClick={() => {
                    setAskMessages([])
                    setAskFollowUps([])
                    setAskError(null)
                    setAskInput('')
                  }}
                >
                  Clear chat
                </button>
              </div>

              <div className="block">
                <div className="sideTitle">Gemini</div>
                <div className="sideMeta">
                  Key: {hasGeminiKey === null ? '...' : hasGeminiKey ? 'configured' : 'missing'}
                </div>
                <div className="row">
                  <input
                    className="input"
                    type="password"
                    value={geminiKeyInput}
                    placeholder="AIza..."
                    onChange={(e) => setGeminiKeyInput(e.target.value)}
                  />
                  <button className="btn" onClick={() => void onSaveGeminiKey()}>
                    Save
                  </button>
                </div>
              </div>

              <div className="block">
                <div className="sideTitle">Capture</div>
                <div className="sideMeta">{statusLine}</div>
                <div className="row">
                  <button className="btn btn-accent" onClick={onToggleRecording}>
                    {recording ? 'Stop recording' : 'Start recording'}
                  </button>
                </div>
              </div>
            </div>
          ) : view === 'dashboard' ? (
            <div className="sidePanel">
              <div className="sideTitle">Dashboard</div>
              <div className="sideMeta">Activity stats and trends for a selectable range.</div>

              <div className="block">
                <div className="sideTitle">Capture</div>
                <div className="sideMeta">{statusLine}</div>
                <div className="row">
                  <button className="btn btn-accent" onClick={onToggleRecording}>
                    {recording ? 'Stop recording' : 'Start recording'}
                  </button>
                </div>
                {systemPaused ? (
                  <div className="row">
                    <div className="pill">System paused (sleep/lock)</div>
                  </div>
                ) : null}
                {lastError ? (
                  <div className="row">
                    <div className="mono error">Last capture error: {lastError}</div>
                  </div>
                ) : null}
              </div>

              <div className="block">
                <div className="sideTitle">Gemini</div>
                <div className="sideMeta">
                  Key: {hasGeminiKey === null ? '...' : hasGeminiKey ? 'configured' : 'missing'}
                </div>
                <div className="row">
                  <input
                    className="input"
                    type="password"
                    value={geminiKeyInput}
                    placeholder="AIza..."
                    onChange={(e) => setGeminiKeyInput(e.target.value)}
                  />
                  <button className="btn" onClick={() => void onSaveGeminiKey()}>
                    Save
                  </button>
                </div>
              </div>
            </div>
          ) : selectedCard ? (
            <div className="sidePanel">
              <div className="sideTitle">{selectedCard.title}</div>
              <div className="sideMeta">
                {formatClockAscii(selectedCard.startTs)} - {formatClockAscii(selectedCard.endTs)}
              </div>

              {selectedVideoUrl ? (
                <div className="block">
                  <div className="label">Timelapse</div>
                  <video className="video" controls src={selectedVideoUrl} />
                </div>
              ) : null}

              <div className="field">
                <div className="label">Category</div>
                <select
                  className="input"
                  value={selectedCard.category}
                  disabled={selectedCard.category === 'System'}
                  onChange={(e) => {
                    const category = e.target.value
                    setCards((prev) =>
                      prev.map((x) => (x.id === selectedCard.id ? { ...x, category } : x))
                    )
                    void window.chrona.updateTimelineCardCategory({
                      cardId: selectedCard.id,
                      category,
                      subcategory: selectedCard.subcategory
                    })
                  }}
                >
                  {['Work', 'Personal', 'Distraction', 'Idle', 'System'].map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <div className="label">Subcategory</div>
                <input
                  className="input"
                  value={selectedCard.subcategory ?? ''}
                  disabled={selectedCard.category === 'System'}
                  onChange={(e) => {
                    const subcategory = e.target.value || null
                    setCards((prev) =>
                      prev.map((x) => (x.id === selectedCard.id ? { ...x, subcategory } : x))
                    )
                    void window.chrona.updateTimelineCardCategory({
                      cardId: selectedCard.id,
                      category: selectedCard.category,
                      subcategory
                    })
                  }}
                />
              </div>

              {selectedCard.summary ? (
                <div className="block">
                  <div className="label">Summary</div>
                  <div className="text">{selectedCard.summary}</div>
                </div>
              ) : null}

              {selectedCard.detailedSummary ? (
                <div className="block">
                  <div className="label">Details</div>
                  <div className="text">{selectedCard.detailedSummary}</div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="sidePanel">
              <div className="sideTitle">Capture</div>

              <div className="row">
                <button className="btn btn-accent" onClick={onToggleRecording}>
                  {recording ? 'Stop recording' : 'Start recording'}
                </button>
                <div className="mono">{statusLine}</div>
              </div>

              <div className="row">
                <label className="label">
                  Interval (seconds)
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={interval ?? ''}
                    onChange={(e) => setInterval(Number(e.target.value))}
                  />
                </label>
              </div>

              <div className="row">
                <button className="btn" onClick={onSaveInterval}>
                  Save
                </button>
                <button className="btn" onClick={() => void window.chrona.openRecordingsFolder()}>
                  Open recordings
                </button>
              </div>

              <div className="row">
                <label className="label">
                  Capture display
                  <select
                    className="input"
                    value={selectedDisplayId ?? 'auto'}
                    onChange={(e) => void onSelectDisplay(e.target.value)}
                  >
                    <option value="auto">Auto (cursor)</option>
                    {displays.map((d) => (
                      <option key={d.id} value={d.id}>
                        Display {d.id} ({d.bounds.width}x{d.bounds.height} @ {d.scaleFactor}x)
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {systemPaused ? (
                <div className="row">
                  <div className="pill">System paused (sleep/lock)</div>
                </div>
              ) : null}

              {lastError ? (
                <div className="row">
                  <div className="mono error">Last capture error: {lastError}</div>
                </div>
              ) : null}

              <div className="row">
                <button className="btn" onClick={() => void onRunAnalysisTick()}>
                  Run analysis tick
                </button>
                <div className="mono">{analysisLine || '...'}</div>
              </div>

              <div className="block">
                <div className="sideTitle">Storage</div>
                <div className="sideMeta">
                  {storageUsage
                    ? `Recordings: ${formatBytes(storageUsage.recordingsBytes)} / ${formatBytes(storageUsage.recordingsLimitBytes)} · Timelapses: ${formatBytes(storageUsage.timelapsesBytes)} / ${formatBytes(storageUsage.timelapsesLimitBytes)}`
                    : 'Loading...'}
                </div>

                <div className="row">
                  <label className="label">
                    Recordings limit (GB)
                    <input
                      className="input"
                      type="number"
                      min={1}
                      step={1}
                      value={limitRecordingsGb}
                      onChange={(e) => setLimitRecordingsGb(e.target.value)}
                    />
                  </label>
                </div>

                <div className="row">
                  <label className="label">
                    Timelapses limit (GB)
                    <input
                      className="input"
                      type="number"
                      min={1}
                      step={1}
                      value={limitTimelapsesGb}
                      onChange={(e) => setLimitTimelapsesGb(e.target.value)}
                    />
                  </label>
                </div>

                <div className="row">
                  <button className="btn" onClick={() => void onSaveStorageLimits()}>
                    Save limits
                  </button>
                  <button className="btn" onClick={() => void onPurgeNow()}>
                    Purge now
                  </button>
                </div>

                <div className="row">
                  <label className="pill">
                    <input
                      type="checkbox"
                      checked={timelapsesEnabled}
                      onChange={(e) => void onToggleTimelapsesEnabled(e.target.checked)}
                    />
                    Generate timelapses
                  </label>
                </div>

                <div className="row">
                  <label className="pill">
                    <input
                      type="checkbox"
                      checked={autoStartEnabled}
                      onChange={(e) => void onToggleAutoStartEnabled(e.target.checked)}
                    />
                    Launch at login
                  </label>
                </div>
              </div>

              <div className="row">
                <div className="mono">
                  Gemini key: {hasGeminiKey === null ? '...' : hasGeminiKey ? 'configured' : 'missing'}
                </div>
              </div>

              <div className="row">
                <label className="label">
                  Set Gemini API key
                  <input
                    className="input"
                    type="password"
                    value={geminiKeyInput}
                    placeholder="AIza..."
                    onChange={(e) => setGeminiKeyInput(e.target.value)}
                  />
                </label>
                <button className="btn" onClick={() => void onSaveGeminiKey()}>
                  Save key
                </button>
              </div>
            </div>
          )}
        </aside>
      </main>
    </div>
  )

  function getAskScope(): { startTs: number; endTs: number; label: string } {
    const nowDayKey = dayKeyFromUnixSeconds(Math.floor(Date.now() / 1000))
    if (askScopePreset === 'today') {
      const w = dayWindowForDayKey(nowDayKey)
      return { startTs: w.startTs, endTs: w.endTs, label: `Today (${nowDayKey})` }
    }

    if (askScopePreset === 'yesterday') {
      const y = addDaysToDayKey(nowDayKey, -1)
      const w = dayWindowForDayKey(y)
      return { startTs: w.startTs, endTs: w.endTs, label: `Yesterday (${y})` }
    }

    if (askScopePreset === 'last7') {
      const end = dayWindowForDayKey(nowDayKey).endTs
      const startKey = addDaysToDayKey(nowDayKey, -6)
      const start = dayWindowForDayKey(startKey).startTs
      return { startTs: start, endTs: end, label: 'Last 7 days' }
    }

    if (askScopePreset === 'last30') {
      const end = dayWindowForDayKey(nowDayKey).endTs
      const startKey = addDaysToDayKey(nowDayKey, -29)
      const start = dayWindowForDayKey(startKey).startTs
      return { startTs: start, endTs: end, label: 'Last 30 days' }
    }

    const w = dayWindowForDayKey(dayKey)
    return { startTs: w.startTs, endTs: w.endTs, label: `Day (${dayKey})` }
  }

  async function onRunAsk(text: string) {
    const q = String(text ?? '').trim()
    if (!q) return

    const { startTs, endTs, label } = getAskScope()
    setAskError(null)
    setAskFollowUps([])

    const userMsgId = `u:${Date.now()}:${Math.random().toString(16).slice(2)}`
    setAskMessages((prev) => [...prev, { id: userMsgId, role: 'user', content: q }])
    setAskInput('')
    setAskLoading(true)

    try {
      const res = await window.chrona.askChrona({
        question: q,
        scope: { startTs, endTs },
        options: {
          useObservations: askUseObservations,
          includeReview: askIncludeReview
        }
      })

      const assistantMsgId = `a:${Date.now()}:${Math.random().toString(16).slice(2)}`
      const scopeLine = `Scope: ${label}`
      const content = `${res.answerMarkdown}\n\n${scopeLine}`
      setAskMessages((prev) => [
        ...prev,
        {
          id: assistantMsgId,
          role: 'assistant',
          content,
          sources: res.sources
        }
      ])
      setAskFollowUps(res.followUps ?? [])
    } catch (e) {
      setAskError(e instanceof Error ? e.message : String(e))
    } finally {
      setAskLoading(false)
    }
  }

  function jumpToCard(s: AskSourceRef) {
    pendingJumpRef.current = { dayKey: s.dayKey, cardId: s.cardId }
    setView('timeline')
    setDayKey(s.dayKey)
  }
}

function addDaysToDayKey(dayKey: string, deltaDays: number): string {
  const base = new Date(dayKey + 'T00:00:00')
  base.setDate(base.getDate() + deltaDays)
  return dayKeyFromUnixSeconds(Math.floor(base.getTime() / 1000) + 4 * 60 * 60)
}

function formatCaptureStatus(state: {
  desiredRecordingEnabled: boolean
  isSystemPaused: boolean
  lastCaptureTs: number | null
  resolvedDisplayId: string | null
}) {
  const base = state.isSystemPaused
    ? 'System paused'
    : state.desiredRecordingEnabled
      ? 'Recording'
      : 'Idle'

  const parts: string[] = [base]
  if (state.resolvedDisplayId) parts.push(`display=${state.resolvedDisplayId}`)
  if (state.lastCaptureTs) parts.push(`last=${new Date(state.lastCaptureTs * 1000).toLocaleTimeString()}`)
  return parts.join(' · ')
}

function clampNumber(n: number, min: number, max: number): number {
  if (n < min) return min
  if (n > max) return max
  return n
}

function clampTimelinePxPerHour(pxPerHour: number): number {
  const n = Number(pxPerHour)
  if (!Number.isFinite(n)) return TIMELINE_ZOOM_DEFAULT_PX_PER_HOUR
  return clampNumber(Math.round(n), TIMELINE_ZOOM_MIN_PX_PER_HOUR, TIMELINE_ZOOM_MAX_PX_PER_HOUR)
}

function getTimelineMetrics(pxPerHourRaw: number): TimelineMetrics {
  const pxPerHour = clampTimelinePxPerHour(pxPerHourRaw)
  const contentHeightPx = HOURS_IN_TIMELINE * pxPerHour
  return {
    contentHeightPx,
    gridHeightPx: contentHeightPx + TIMELINE_GRID_PADDING_PX * 2
  }
}

function timeToYpx(ts: number, windowStartTs: number, windowEndTs: number, metrics: TimelineMetrics): number {
  const total = windowEndTs - windowStartTs
  if (total <= 0) return TIMELINE_GRID_PADDING_PX
  const t = clampNumber(ts, windowStartTs, windowEndTs)
  const progress = (t - windowStartTs) / total
  return TIMELINE_GRID_PADDING_PX + progress * metrics.contentHeightPx
}

function cardLayout(
  c: TimelineCardDTO,
  windowStartTs: number,
  windowEndTs: number,
  metrics: TimelineMetrics
) {
  const total = windowEndTs - windowStartTs
  if (total <= 0) {
    return {
      style: { top: '0px', height: `${TIMELINE_MIN_CARD_HEIGHT_PX}px` },
      heightPx: TIMELINE_MIN_CARD_HEIGHT_PX,
      sizeClass: 'card--tiny'
    }
  }

  const start = clampNumber(c.startTs, windowStartTs, windowEndTs)
  const end = clampNumber(c.endTs, windowStartTs, windowEndTs)
  const clampedEnd = Math.max(end, start)

  const top = TIMELINE_GRID_PADDING_PX + ((start - windowStartTs) / total) * metrics.contentHeightPx
  const height = ((clampedEnd - start) / total) * metrics.contentHeightPx
  const heightPx = Math.max(TIMELINE_MIN_CARD_HEIGHT_PX, height)
  const sizeClass =
    heightPx <= CARD_TINY_MAX_HEIGHT_PX
      ? 'card--tiny'
      : heightPx <= CARD_SMALL_MAX_HEIGHT_PX
        ? 'card--small'
        : ''

  return {
    style: {
      top: `${top}px`,
      height: `${heightPx}px`
    },
    heightPx,
    sizeClass
  }
}

function resolveOverlapsForDisplay(cards: TimelineCardDTO[]): TimelineCardDTO[] {
  return [...cards]
    .filter((c) => c.endTs > c.startTs)
    .sort((a, b) => a.startTs - b.startTs)
}

function renderTimeTicks(windowStartTs: number, pxPerHourRaw: number) {
  const pxPerHour = clampTimelinePxPerHour(pxPerHourRaw)

  const minutesStep =
    pxPerHour >= 220 ? 15
    : pxPerHour >= 140 ? 30
    : 60

  const ticks: any[] = []
  const totalMinutes = HOURS_IN_TIMELINE * 60

  for (let m = 0; m <= totalMinutes; m += minutesStep) {
    const isHour = m % 60 === 0
    const shouldLabel = isHour || (minutesStep >= 30 && pxPerHour >= 240 && m % 30 === 0)

    const ts = windowStartTs + m * 60
    const y = TIMELINE_GRID_PADDING_PX + (m / 60) * pxPerHour

    ticks.push(
      <div
        key={m}
        className={`tick ${isHour ? 'major' : 'minor'}`}
        style={{ top: `${y}px` }}
      >
        {shouldLabel ? <div className="tickLabel">{formatClockAscii(ts)}</div> : null}
      </div>
    )
  }

  return ticks
}

function renderReviewList(
  cards: TimelineCardDTO[],
  coverage: Record<number, number>,
  onRate: (card: TimelineCardDTO, rating: 'focus' | 'neutral' | 'distracted') => void
) {
  const rows = cards
    .filter((c) => c.category !== 'System')
    .map((card) => ({ card, coverage: coverage[card.id] ?? 0 }))
    .filter((x) => x.coverage < 0.8)
    .sort((a, b) => a.card.startTs - b.card.startTs)

  if (rows.length === 0) {
    return (
      <div className="reviewEmpty">
        <div className="sideTitle">Nothing to review</div>
        <div className="sideMeta">All non-system cards are at least 80% covered.</div>
      </div>
    )
  }

  return (
    <div className="reviewWrap">
      <div className="reviewHeader">
        <div className="sideTitle">Review</div>
        <div className="sideMeta">Rate cards until coverage reaches 80%.</div>
      </div>

      {rows.map(({ card, coverage }) => (
        <div key={card.id} className="reviewRow">
          <div className="reviewRowMain">
            <div className="reviewRowTitle">{card.title}</div>
            <div className="reviewRowMeta">
              {formatClockAscii(card.startTs)} - {formatClockAscii(card.endTs)} · {card.category}
              {` · ${(coverage * 100).toFixed(0)}% covered`}
            </div>
          </div>
          <div className="reviewRowActions">
            <button className="btn" onClick={() => onRate(card, 'focus')}>
              Focus
            </button>
            <button className="btn" onClick={() => onRate(card, 'neutral')}>
              Neutral
            </button>
            <button className="btn" onClick={() => onRate(card, 'distracted')}>
              Distracted
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
