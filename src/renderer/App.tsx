import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TimelineCardDTO } from '../shared/timeline'
import { dayKeyFromUnixSeconds, dayWindowForDayKey, formatClockAscii } from '../shared/time'
import { formatBytes } from '../shared/format'

type DisplayInfo = { id: string; bounds: { width: number; height: number }; scaleFactor: number }

const HOURS_IN_TIMELINE = 24
const TIMELINE_GRID_PADDING_PX = 16
const TIMELINE_ZOOM_DEFAULT_PX_PER_HOUR = 100
const TIMELINE_ZOOM_MIN_PX_PER_HOUR = 50
const TIMELINE_ZOOM_MAX_PX_PER_HOUR = 3200
const TIMELINE_MIN_CARD_HEIGHT_PX = 12

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
  const [view, setView] = useState<'timeline' | 'review'>('timeline')
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

  useEffect(() => {
    void (async () => {
      const state = await window.dayflow.getCaptureState()
      setInterval(state.intervalSeconds)
      setRecording(state.desiredRecordingEnabled)
      setSystemPaused(state.isSystemPaused)
      setLastError(state.lastError)
      setSelectedDisplayId(state.selectedDisplayId)
      setStatusLine(formatCaptureStatus(state))

      setDisplays(await window.dayflow.listDisplays())
      setHasGeminiKey((await window.dayflow.hasGeminiApiKey()).hasApiKey)

      const settings = await window.dayflow.getSettings()
      setTimelapsesEnabled(!!settings.timelapsesEnabled)
      setTimelinePxPerHour(
        clampTimelinePxPerHour(settings.timelinePxPerHour ?? TIMELINE_ZOOM_DEFAULT_PX_PER_HOUR)
      )
      setAutoStartEnabled((await window.dayflow.getAutoStartEnabled()).enabled)

      const usage = await window.dayflow.getStorageUsage()
      setStorageUsage(usage)
      setLimitRecordingsGb(String(Math.round(usage.recordingsLimitBytes / (1024 * 1024 * 1024))))
      setLimitTimelapsesGb(String(Math.round(usage.timelapsesLimitBytes / (1024 * 1024 * 1024))))
    })()

    const unsubState = window.dayflow.onRecordingStateChanged((state) => {
      setInterval(state.intervalSeconds)
      setRecording(state.desiredRecordingEnabled)
      setSystemPaused(state.isSystemPaused)
      setLastError(state.lastError)
      setSelectedDisplayId(state.selectedDisplayId)
      setStatusLine(formatCaptureStatus(state))
    })

    const unsubErr = window.dayflow.onCaptureError((err) => {
      setLastError(err.message)
    })

    const unsubAnalysis = window.dayflow.onAnalysisBatchUpdated((p) => {
      setAnalysisLine(`batch ${p.batchId}: ${p.status}${p.reason ? ` (${p.reason})` : ''}`)
    })

    const unsubUsage = window.dayflow.onStorageUsageUpdated((u) => {
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
        const res = await window.dayflow.resolveFileUrl(selectedCard.videoSummaryUrl)
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
    if (!didInitTimelineZoomRef.current) {
      didInitTimelineZoomRef.current = true
      return
    }

    if (saveTimelineZoomTimeoutRef.current !== null) {
      window.clearTimeout(saveTimelineZoomTimeoutRef.current)
    }

    saveTimelineZoomTimeoutRef.current = window.setTimeout(() => {
      void window.dayflow.updateSettings({ timelinePxPerHour })
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
    const unsub = window.dayflow.onTimelineUpdated((p) => {
      if (p.dayKey !== dayKey) return
      void refreshDay(dayKey, true)
    })
    return () => unsub()
  }, [dayKey])

  async function refreshDay(k: string, preserveSelection: boolean) {
    const day = await window.dayflow.getTimelineDay(k)
    const nextCards = resolveOverlapsForDisplay(day.cards)
    setCards(nextCards)

    setSelectedCardId((prev) => {
      if (!preserveSelection) return null
      if (prev === null) return null
      return nextCards.some((c) => c.id === prev) ? prev : null
    })
  }

  async function refreshReview(k: string) {
    const res = await window.dayflow.getReviewDay(k)
    setReviewCoverage(res.coverageByCardId)
  }

  async function onSaveInterval() {
    if (interval === null || !Number.isFinite(interval) || interval <= 0) return
    const next = await window.dayflow.setCaptureInterval(interval)
    setInterval(next.intervalSeconds)
  }

  async function onSelectDisplay(id: string) {
    const displayId = id === 'auto' ? null : id
    setSelectedDisplayId(displayId)
    await window.dayflow.setSelectedDisplay(displayId)
  }

  async function onRunAnalysisTick() {
    const res = await window.dayflow.runAnalysisTick()
    setAnalysisLine(`tick: created=${res.createdBatchIds.length} unprocessed=${res.unprocessedCount}`)
  }

  async function onSaveGeminiKey() {
    if (!geminiKeyInput.trim()) return
    await window.dayflow.setGeminiApiKey(geminiKeyInput)
    setGeminiKeyInput('')
    setHasGeminiKey((await window.dayflow.hasGeminiApiKey()).hasApiKey)
  }

  async function onSaveStorageLimits() {
    const recGb = Number(limitRecordingsGb)
    const tlGb = Number(limitTimelapsesGb)
    if (!Number.isFinite(recGb) || recGb <= 0) return
    if (!Number.isFinite(tlGb) || tlGb <= 0) return

    await window.dayflow.updateSettings({
      storageLimitRecordingsBytes: Math.floor(recGb * 1024 * 1024 * 1024),
      storageLimitTimelapsesBytes: Math.floor(tlGb * 1024 * 1024 * 1024)
    })
    const usage = await window.dayflow.getStorageUsage()
    setStorageUsage(usage)
  }

  async function onToggleTimelapsesEnabled(enabled: boolean) {
    setTimelapsesEnabled(enabled)
    await window.dayflow.updateSettings({ timelapsesEnabled: enabled })
  }

  async function onToggleAutoStartEnabled(enabled: boolean) {
    const res = await window.dayflow.setAutoStartEnabled(enabled)
    setAutoStartEnabled(res.enabled)
  }

  async function onPurgeNow() {
    const res = await window.dayflow.purgeStorageNow()
    setAnalysisLine(
      `purge: screenshots=${res.deletedScreenshotCount} timelapses=${res.deletedTimelapseCount} freed=${formatBytes(res.freedRecordingsBytes + res.freedTimelapsesBytes)}`
    )
    const usage = await window.dayflow.getStorageUsage()
    setStorageUsage(usage)
  }

  async function onToggleRecording() {
    const next = await window.dayflow.setRecordingEnabled(!recording)
    setRecording(next.desiredRecordingEnabled)
    setSystemPaused(next.isSystemPaused)
    setStatusLine(formatCaptureStatus(next))
  }

  async function onCopyDay() {
    await window.dayflow.copyDayToClipboard(dayKey)
  }

  async function onExportDay() {
    await window.dayflow.saveMarkdownRange(dayKey, dayKey)
  }

  async function onApplyRating(card: TimelineCardDTO, rating: 'focus' | 'neutral' | 'distracted') {
    await window.dayflow.applyReviewRating(card.startTs, card.endTs, rating)
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
          <div className="wordmark">Dayflow</div>
          <div className="tagline">Timeline · {dayKey}</div>
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
                {renderHourTicks(windowInfo.startTs, timelinePxPerHour)}
                {nowYpx !== null ? <div className="nowLine" style={{ top: `${nowYpx}px` }} /> : null}

                {cards.map((c) => (
                  <div
                    key={c.id}
                    className={`card ${selectedCardId === c.id ? 'selected' : ''} ${c.category === 'System' ? 'system' : ''}`}
                    style={cardStyle(c, windowInfo.startTs, windowInfo.endTs, timelineMetrics)}
                    onClick={() => setSelectedCardId(c.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="cardTitle">{c.title}</div>
                    <div className="cardMeta">
                      {formatClockAscii(c.startTs)} - {formatClockAscii(c.endTs)} · {c.category}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : (
          <section className="timeline">
            <div className="timelineScroll">
              <div className="reviewList">
                {renderReviewList(cards, reviewCoverage, (card, rating) => void onApplyRating(card, rating))}
              </div>
            </div>
          </section>
        )}

        <aside className="side">
          {selectedCard ? (
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
                    void window.dayflow.updateTimelineCardCategory({
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
                    void window.dayflow.updateTimelineCardCategory({
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
                <button className="btn" onClick={onSaveInterval}>
                  Save
                </button>
                <button className="btn" onClick={() => void window.dayflow.openRecordingsFolder()}>
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

function cardStyle(
  c: TimelineCardDTO,
  windowStartTs: number,
  windowEndTs: number,
  metrics: TimelineMetrics
) {
  const total = windowEndTs - windowStartTs
  if (total <= 0) return { top: '0px', height: `${TIMELINE_MIN_CARD_HEIGHT_PX}px` }

  const start = clampNumber(c.startTs, windowStartTs, windowEndTs)
  const end = clampNumber(c.endTs, windowStartTs, windowEndTs)
  const clampedEnd = Math.max(end, start)

  const top = TIMELINE_GRID_PADDING_PX + ((start - windowStartTs) / total) * metrics.contentHeightPx
  const height = ((clampedEnd - start) / total) * metrics.contentHeightPx

  return {
    top: `${top}px`,
    height: `${Math.max(TIMELINE_MIN_CARD_HEIGHT_PX, height)}px`
  }
}

function resolveOverlapsForDisplay(cards: TimelineCardDTO[]): TimelineCardDTO[] {
  const sorted = [...cards].sort((a, b) => a.startTs - b.startTs)
  const out: TimelineCardDTO[] = []

  for (const c of sorted) {
    if (out.length === 0) {
      out.push(c)
      continue
    }

    const prev = out[out.length - 1]
    if (c.startTs >= prev.endTs) {
      out.push(c)
      continue
    }

    const prevDur = prev.endTs - prev.startTs
    const curDur = c.endTs - c.startTs

    if (curDur <= prevDur) {
      out[out.length - 1] = { ...prev, endTs: Math.max(prev.startTs, c.startTs) }
      out.push(c)
    } else {
      const trimmedCurStart = Math.min(c.endTs, prev.endTs)
      if (c.endTs > trimmedCurStart) out.push({ ...c, startTs: trimmedCurStart })
    }
  }

  return out.filter((c) => c.endTs > c.startTs)
}

function renderHourTicks(windowStartTs: number, pxPerHourRaw: number) {
  const pxPerHour = clampTimelinePxPerHour(pxPerHourRaw)
  const ticks: any[] = []
  for (let i = 0; i <= HOURS_IN_TIMELINE; i++) {
    const ts = windowStartTs + i * 3600
    const y = TIMELINE_GRID_PADDING_PX + i * pxPerHour
    ticks.push(
      <div key={i} className="tick" style={{ top: `${y}px` }}>
        <div className="tickLabel">{formatClockAscii(ts)}</div>
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
