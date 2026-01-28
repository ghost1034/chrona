import { useEffect, useMemo, useState } from 'react'
import type { TimelineCardDTO } from '../shared/timeline'
import { dayKeyFromUnixSeconds, dayWindowForDayKey, formatClockAscii } from '../shared/time'
import { formatBytes } from '../shared/format'

type DisplayInfo = { id: string; bounds: { width: number; height: number }; scaleFactor: number }

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
  const selectedCard = useMemo(
    () => cards.find((c) => c.id === selectedCardId) ?? null,
    [cards, selectedCardId]
  )

  const [selectedVideoUrl, setSelectedVideoUrl] = useState<string | null>(null)

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

    setSelectedCardId((prev) => {
      if (!preserveSelection) return null
      if (prev === null) return null
      return nextCards.some((c) => c.id === prev) ? prev : null
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

  const windowInfo = dayWindowForDayKey(dayKey)
  const isToday = dayKey === dayKeyFromUnixSeconds(Math.floor(Date.now() / 1000))
  const nowTs = Math.floor(Date.now() / 1000)
  const nowPct = isToday
    ? ((nowTs - windowInfo.startTs) / (windowInfo.endTs - windowInfo.startTs)) * 100
    : null

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="wordmark">Chrona</div>
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
            <div className="timelineScroll">
              <div className="timelineGrid">
                {renderHourTicks(windowInfo.startTs)}
                {nowPct !== null && nowPct >= 0 && nowPct <= 100 ? (
                  <div className="nowLine" style={{ top: `${nowPct}%` }} />
                ) : null}

                {cards.map((c) => (
                  <div
                    key={c.id}
                    className={`card ${selectedCardId === c.id ? 'selected' : ''} ${c.category === 'System' ? 'system' : ''}`}
                    style={cardStyle(c, windowInfo.startTs, windowInfo.endTs)}
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

function cardStyle(c: TimelineCardDTO, windowStartTs: number, windowEndTs: number) {
  const total = windowEndTs - windowStartTs
  const start = clamp(c.startTs, windowStartTs, windowEndTs)
  const end = clamp(c.endTs, windowStartTs, windowEndTs)
  const top = ((start - windowStartTs) / total) * 100
  const height = ((Math.max(end, start) - start) / total) * 100
  return {
    top: `${top}%`,
    height: `${Math.max(0.4, height)}%`
  }
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min
  if (n > max) return max
  return n
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

function renderHourTicks(windowStartTs: number) {
  const ticks: any[] = []
  for (let i = 0; i <= 24; i++) {
    const ts = windowStartTs + i * 3600
    const y = (i / 24) * 100
    ticks.push(
      <div key={i} className="tick" style={{ top: `${y}%` }}>
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
