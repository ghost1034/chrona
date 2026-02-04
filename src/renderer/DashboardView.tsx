import { useEffect, useMemo, useState } from 'react'
import type { DashboardStatsDTO } from '../shared/dashboard'
import { dayKeyFromUnixSeconds, dayWindowForDayKey } from '../shared/time'

type Preset = 'day' | 'today' | 'yesterday' | 'last7' | 'last30' | 'custom'

const CATEGORY_COLORS: Record<string, string> = {
  Work: 'rgba(59, 212, 178, 0.9)',
  Personal: 'rgba(99, 169, 255, 0.9)',
  Distraction: 'rgba(255, 122, 24, 0.9)',
  Idle: 'rgba(190, 200, 212, 0.55)',
  System: 'rgba(255, 180, 168, 0.75)',
  Untracked: 'rgba(255, 255, 255, 0.08)'
}

const CATEGORY_ORDER = ['Work', 'Personal', 'Distraction', 'Idle', 'System', 'Untracked']

export function DashboardView(props: {
  selectedDayKey: string
  onJumpToDay: (dayKey: string) => void
}) {
  const [preset, setPreset] = useState<Preset>('day')
  const [includeSystem, setIncludeSystem] = useState<boolean>(false)
  const [customStartDayKey, setCustomStartDayKey] = useState<string>(props.selectedDayKey)
  const [customEndDayKey, setCustomEndDayKey] = useState<string>(props.selectedDayKey)

  const [stats, setStats] = useState<DashboardStatsDTO | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const scope = useMemo(() => {
    const nowDayKey = dayKeyFromUnixSeconds(Math.floor(Date.now() / 1000))

    if (preset === 'today') return dayWindowForDayKey(nowDayKey)
    if (preset === 'yesterday') return dayWindowForDayKey(addDaysToDayKey(nowDayKey, -1))
    if (preset === 'last7') {
      const end = dayWindowForDayKey(nowDayKey).endTs
      const startKey = addDaysToDayKey(nowDayKey, -6)
      const start = dayWindowForDayKey(startKey).startTs
      return { startTs: start, endTs: end }
    }
    if (preset === 'last30') {
      const end = dayWindowForDayKey(nowDayKey).endTs
      const startKey = addDaysToDayKey(nowDayKey, -29)
      const start = dayWindowForDayKey(startKey).startTs
      return { startTs: start, endTs: end }
    }
    if (preset === 'custom') {
      const a = dayWindowForDayKey(customStartDayKey).startTs
      const b = dayWindowForDayKey(customEndDayKey).endTs
      return { startTs: Math.min(a, b), endTs: Math.max(a, b) }
    }
    return dayWindowForDayKey(props.selectedDayKey)
  }, [preset, props.selectedDayKey, customStartDayKey, customEndDayKey])

  const scopeDayKeys = useMemo(
    () => enumerateDayKeysForScope(scope.startTs, scope.endTs),
    [scope.startTs, scope.endTs]
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    void (async () => {
      try {
        const res = await window.chrona.getDashboardStats(
          { startTs: scope.startTs, endTs: scope.endTs },
          { includeSystem }
        )
        if (cancelled) return
        setStats(res)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setStats(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [scope.startTs, scope.endTs, includeSystem])

  useEffect(() => {
    const daySet = new Set(scopeDayKeys)
    const unsub = window.chrona.onTimelineUpdated((p) => {
      if (!daySet.has(p.dayKey)) return
      void window.chrona
        .getDashboardStats({ startTs: scope.startTs, endTs: scope.endTs }, { includeSystem })
        .then((res) => setStats(res))
        .catch(() => {
          // ignore
        })
    })
    return () => unsub()
  }, [scope.startTs, scope.endTs, includeSystem, scopeDayKeys.join('|')])

  const trackedSeconds = stats?.trackedSeconds ?? 0
  const untrackedSeconds = stats?.untrackedSeconds ?? 0

  const categoryRows = useMemo(() => {
    if (!stats) return []
    const base = [...stats.byCategorySeconds]

    const includeUntracked = {
      category: 'Untracked',
      seconds: stats.untrackedSeconds
    }

    const rows = [...base, includeUntracked].filter((r) => r.seconds > 0)
    rows.sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a.category)
      const ib = CATEGORY_ORDER.indexOf(b.category)
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1
        if (ib === -1) return -1
        return ia - ib
      }
      return b.seconds - a.seconds
    })
    return rows
  }, [stats])

  return (
    <div className="dashboardWrap">
      <div className="dashboardHeader">
        <div className="dashboardTitle">Dashboard</div>
        <div className="dashboardMeta">
          {loading ? 'Loading…' : error ? `Error: ${error}` : stats ? scopeLabel(preset, props.selectedDayKey, customStartDayKey, customEndDayKey) : '—'}
        </div>
      </div>

      <div className="dashboardControls">
        <div className="field">
          <div className="label">Range</div>
          <select className="input" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            <option value="day">Selected day ({props.selectedDayKey})</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="last7">Last 7 days</option>
            <option value="last30">Last 30 days</option>
            <option value="custom">Custom</option>
          </select>
        </div>

        {preset === 'custom' ? (
          <div className="row" style={{ paddingTop: 0 }}>
            <label className="label">
              Start
              <input
                className="input"
                type="date"
                value={customStartDayKey}
                onChange={(e) => setCustomStartDayKey(e.target.value)}
              />
            </label>
            <label className="label">
              End
              <input
                className="input"
                type="date"
                value={customEndDayKey}
                onChange={(e) => setCustomEndDayKey(e.target.value)}
              />
            </label>
          </div>
        ) : null}

        <div className="row" style={{ paddingTop: 0 }}>
          <label className="pill">
            <input
              type="checkbox"
              checked={includeSystem}
              onChange={(e) => setIncludeSystem(e.target.checked)}
            />
            Include System cards
          </label>
        </div>
      </div>

      {stats ? (
        <div className="kpiGrid">
          <div className="kpi">
            <div className="kpiLabel">Tracked</div>
            <div className="kpiValue">{formatDuration(trackedSeconds)}</div>
          </div>
          <div className="kpi">
            <div className="kpiLabel">Untracked</div>
            <div className="kpiValue">{formatDuration(untrackedSeconds)}</div>
          </div>
          <div className="kpi">
            <div className="kpiLabel">Review coverage</div>
            <div className="kpiValue">{(stats.review.coverageFraction * 100).toFixed(0)}%</div>
          </div>
          <div className="kpi">
            <div className="kpiLabel">Longest Work block</div>
            <div className="kpiValue">{formatDuration(stats.blocks.longestWorkBlockSeconds)}</div>
          </div>
        </div>
      ) : null}

      {stats ? (
        <div className="dashboardGrid">
          <div className="panel">
            <div className="panelTitle">Category breakdown</div>
            <div className="categoryList">
              {categoryRows.map((r) => {
                const denom = stats.windowSeconds > 0 ? stats.windowSeconds : 1
                const pct = (r.seconds / denom) * 100
                const color = CATEGORY_COLORS[r.category] ?? 'rgba(255, 255, 255, 0.14)'
                return (
                  <div key={r.category} className="categoryRow">
                    <div className="categoryLeft">
                      <span className="dot" style={{ background: color }} />
                      <span className="categoryName">{r.category}</span>
                    </div>
                    <div className="categoryBar">
                      <div className="categoryBarFill" style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <div className="categoryRight">
                      <span className="mono">{formatDuration(r.seconds)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="panel">
            <div className="panelTitle">Daily totals</div>
            <div className="dayBars">
              <DailyStackedBars perDay={stats.perDay} onJumpToDay={props.onJumpToDay} />
            </div>
          </div>

          <div className="panel">
            <div className="panelTitle">Review</div>
            <div className="reviewStats">
              <div className="reviewPills">
                <span className="pill">Focus {formatDuration(stats.review.focusSeconds)}</span>
                <span className="pill">Neutral {formatDuration(stats.review.neutralSeconds)}</span>
                <span className="pill">Distracted {formatDuration(stats.review.distractedSeconds)}</span>
              </div>
              <div className="sideMeta">
                Covered {formatDuration(stats.review.coveredSeconds)} of {formatDuration(stats.review.trackedNonSystemSeconds)} tracked (non-System)
              </div>
              <div className="sideMeta">Unreviewed cards: {stats.review.unreviewedCardCount}</div>
            </div>
          </div>

          <div className="panel">
            <div className="panelTitle">Top titles</div>
            <div className="topList">
              {stats.byTitleSeconds.slice(0, 12).map((t) => (
                <div key={`${t.category}:${t.title}`} className="topRow">
                  <div className="topTitle">
                    <span className="dot" style={{ background: CATEGORY_COLORS[t.category] ?? 'rgba(255,255,255,0.14)' }} />
                    <span>{t.title}</span>
                  </div>
                  <div className="mono">{formatDuration(t.seconds)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="dashboardEmpty">
          <div className="sideTitle">No dashboard data</div>
          <div className="sideMeta">Generate timeline cards first (run capture + analysis) or choose a different range.</div>
        </div>
      )}
    </div>
  )
}

function DailyStackedBars(props: {
  perDay: DashboardStatsDTO['perDay']
  onJumpToDay: (dayKey: string) => void
}) {
  const max = Math.max(1, ...props.perDay.map((d) => d.trackedSeconds))
  const categories = collectCategories(props.perDay)
  const ordered = [...categories].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a)
    const ib = CATEGORY_ORDER.indexOf(b)
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1
      if (ib === -1) return -1
      return ia - ib
    }
    return a.localeCompare(b)
  })

  return (
    <div className="dayBarsWrap">
      {props.perDay.map((d) => {
        const total = d.trackedSeconds
        const scale = (total / max) * 100
        return (
          <button
            key={d.dayKey}
            className="dayBarRow"
            onClick={() => props.onJumpToDay(d.dayKey)}
            title="Open this day in Timeline"
          >
            <div className="dayBarLabel mono">{d.dayKey}</div>
            <div className="dayBarTrack">
              <div className="dayBarFill" style={{ width: `${scale}%` }}>
                {ordered
                  .filter((c) => (d.byCategorySeconds[c] ?? 0) > 0)
                  .map((c) => {
                    const seconds = d.byCategorySeconds[c] ?? 0
                    const pct = total > 0 ? (seconds / total) * 100 : 0
                    const color = CATEGORY_COLORS[c] ?? 'rgba(255,255,255,0.14)'
                    return (
                      <div
                        key={c}
                        className="dayBarSeg"
                        style={{ width: `${pct}%`, background: color }}
                        title={`${c}: ${formatDuration(seconds)}`}
                      />
                    )
                  })}
              </div>
            </div>
            <div className="dayBarMeta mono">{formatDuration(total)}</div>
          </button>
        )
      })}
    </div>
  )
}

function collectCategories(perDay: DashboardStatsDTO['perDay']): Set<string> {
  const set = new Set<string>()
  for (const d of perDay) {
    for (const k of Object.keys(d.byCategorySeconds)) set.add(k)
  }
  return set
}

function addDaysToDayKey(dayKey: string, deltaDays: number): string {
  const base = new Date(dayKey + 'T00:00:00')
  base.setDate(base.getDate() + deltaDays)
  return dayKeyFromUnixSeconds(Math.floor(base.getTime() / 1000) + 4 * 60 * 60)
}

function enumerateDayKeysForScope(startTs: number, endTs: number): string[] {
  const startKey = dayKeyFromUnixSeconds(startTs)
  const endKey = dayKeyFromUnixSeconds(Math.max(startTs, endTs - 1))

  const startDate = new Date(startKey + 'T00:00:00')
  const endDate = new Date(endKey + 'T00:00:00')
  const out: string[] = []
  const d = new Date(startDate)
  while (d.getTime() <= endDate.getTime()) {
    out.push(dayKeyFromUnixSeconds(Math.floor(d.getTime() / 1000) + 4 * 60 * 60))
    d.setDate(d.getDate() + 1)
  }
  return out
}

function scopeLabel(preset: Preset, selectedDayKey: string, customStart: string, customEnd: string): string {
  if (preset === 'day') return `Selected day (${selectedDayKey})`
  if (preset === 'today') return 'Today'
  if (preset === 'yesterday') return 'Yesterday'
  if (preset === 'last7') return 'Last 7 days'
  if (preset === 'last30') return 'Last 30 days'
  return `Custom (${customStart} to ${customEnd})`
}

function formatDuration(totalSecondsRaw: number): string {
  const totalSeconds = Math.max(0, Math.floor(totalSecondsRaw))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  if (h <= 0) return `${m}m`
  if (m <= 0) return `${h}h`
  return `${h}h ${m}m`
}
