import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  TimelineCardDTO,
  TimelineSearchFiltersDTO,
  TimelineSearchHitDTO,
  TimelineSearchRequestDTO
} from '../shared/timeline'
import { getCategoryColor } from '../shared/categoryColors'
import { dayKeyFromUnixSeconds, dayWindowForDayKey, formatClockAscii } from '../shared/time'
import { formatBytes } from '../shared/format'
import { parseAppSitesFromMetadata } from '../shared/metadata'
import type { ObservationDTO } from '../shared/observations'
import type { AskSourceRef } from '../shared/ask'
import type { JournalDraftDTO, JournalEntryDTO, JournalEntryPatch } from '../shared/journal'
import type { SetupStatus } from '../shared/ipc'
import type { CategoryDefinition, SubcategoryDefinition } from '../shared/categories'
import { DashboardView } from './DashboardView'
import { SettingsView } from './SettingsView'
import { OnboardingView } from './OnboardingView'
import { Markdown } from './Markdown'

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

  const [analysisCheckIntervalSeconds, setAnalysisCheckIntervalSeconds] = useState<string>('60')
  const [analysisLookbackSeconds, setAnalysisLookbackSeconds] = useState<string>('86400')
  const [analysisBatchTargetMinutes, setAnalysisBatchTargetMinutes] = useState<string>('30')
  const [analysisBatchMaxGapMinutes, setAnalysisBatchMaxGapMinutes] = useState<string>('5')
  const [analysisMinBatchMinutes, setAnalysisMinBatchMinutes] = useState<string>('5')
  const [analysisCardWindowMinutes, setAnalysisCardWindowMinutes] = useState<string>('60')

  const [hasGeminiKey, setHasGeminiKey] = useState<boolean | null>(null)
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null)
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean>(true)
  const [geminiKeyInput, setGeminiKeyInput] = useState<string>('')
  const [timelapsesEnabled, setTimelapsesEnabled] = useState<boolean>(false)
  const [autoStartEnabled, setAutoStartEnabled] = useState<boolean>(false)

  const [timelapseFps, setTimelapseFps] = useState<number>(2)

  const [geminiModel, setGeminiModel] = useState<string>('gemini-2.5-flash')
  const [geminiRequestTimeoutMs, setGeminiRequestTimeoutMs] = useState<number>(60_000)
  const [geminiMaxAttempts, setGeminiMaxAttempts] = useState<number>(3)
  const [geminiLogBodies, setGeminiLogBodies] = useState<boolean>(false)

  const [promptPreambleTranscribe, setPromptPreambleTranscribe] = useState<string>('')
  const [promptPreambleCards, setPromptPreambleCards] = useState<string>('')
  const [promptPreambleAsk, setPromptPreambleAsk] = useState<string>('')
  const [promptPreambleJournalDraft, setPromptPreambleJournalDraft] = useState<string>('')

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

  const [categoryDefs, setCategoryDefs] = useState<CategoryDefinition[]>([])
  const [subcategoryDefs, setSubcategoryDefs] = useState<SubcategoryDefinition[]>([])

  const [exportDialogOpen, setExportDialogOpen] = useState<boolean>(false)
  const [exportFormat, setExportFormat] = useState<'md' | 'csv' | 'xlsx'>('xlsx')
  const [exportStartDayKey, setExportStartDayKey] = useState<string>(dayKey)
  const [exportEndDayKey, setExportEndDayKey] = useState<string>(dayKey)
  const [exportIncludeSystem, setExportIncludeSystem] = useState<boolean>(true)
  const [exportIncludeReviewCoverage, setExportIncludeReviewCoverage] = useState<boolean>(false)
  const [exportLine, setExportLine] = useState<string>('')

  const [timelineSearchQuery, setTimelineSearchQuery] = useState<string>('')
  const [timelineSearchScopePreset, setTimelineSearchScopePreset] = useState<
    'day' | 'today' | 'yesterday' | 'last7' | 'last30' | 'all'
  >('day')
  const [timelineFilters, setTimelineFilters] = useState<TimelineSearchFiltersDTO>({
    includeSystem: true,
    onlyErrors: false,
    hasVideo: false,
    hasDetails: false,
    categories: []
  })
  const [timelineSearchLoading, setTimelineSearchLoading] = useState<boolean>(false)
  const [timelineSearchError, setTimelineSearchError] = useState<string | null>(null)
  const [timelineSearchHits, setTimelineSearchHits] = useState<TimelineSearchHitDTO[]>([])
  const [timelineSearchHasMore, setTimelineSearchHasMore] = useState<boolean>(false)
  const [timelineSearchOffset, setTimelineSearchOffset] = useState<number>(0)
  const timelineSearchInputRef = useRef<HTMLInputElement | null>(null)
  const timelineSearchReqKeyRef = useRef<string>('')
  const timelineSearchRunIdRef = useRef<number>(0)
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [view, setView] = useState<
    'timeline' | 'review' | 'ask' | 'dashboard' | 'journal' | 'settings' | 'onboarding'
  >(
    'timeline'
  )
  const [reviewCoverage, setReviewCoverage] = useState<Record<number, number>>({})

  const [timelinePxPerHour, setTimelinePxPerHour] = useState<number>(TIMELINE_ZOOM_DEFAULT_PX_PER_HOUR)
  const timelineScrollRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollToTsRef = useRef<number | null>(null)
  const didInitTimelineZoomRef = useRef<boolean>(false)
  const saveTimelineZoomTimeoutRef = useRef<number | null>(null)
  const selectedCard = useMemo(
    () => cards.find((c) => c.id === selectedCardId) ?? null,
    [cards, selectedCardId]
  )

  const selectedCardSites = useMemo(
    () => parseAppSitesFromMetadata(selectedCard?.metadata ?? null),
    [selectedCard?.metadata]
  )
  const selectedCardSiteList = useMemo(() => {
    const out: string[] = []
    if (selectedCardSites.primary) out.push(selectedCardSites.primary)
    if (selectedCardSites.secondary) out.push(selectedCardSites.secondary)
    return Array.from(new Set(out))
  }, [selectedCardSites.primary, selectedCardSites.secondary])

  const categoryNamesOrdered = useMemo(() => {
    const sorted = [...categoryDefs].sort((a, b) => (Number(a.order ?? 0) || 0) - (Number(b.order ?? 0) || 0))
    return sorted.map((c) => c.name)
  }, [categoryDefs])

  const categoryIdByName = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of categoryDefs) m.set(c.name, c.id)
    return m
  }, [categoryDefs])

  const categoryColorsByName = useMemo(() => {
    const out: Record<string, string> = {}
    for (const c of categoryDefs) out[c.name] = c.color
    return out
  }, [categoryDefs])

  const subcategorySuggestionsForSelected = useMemo(() => {
    const catName = selectedCard?.category ?? ''
    const catId = categoryIdByName.get(catName) ?? null
    if (!catId) return []

    const items = subcategoryDefs
      .filter((s) => s.categoryId === catId)
      .sort((a, b) => (Number(a.order ?? 0) || 0) - (Number(b.order ?? 0) || 0))
      .map((s) => s.name)
    return Array.from(new Set(items))
  }, [subcategoryDefs, selectedCard?.category, categoryIdByName])

  const [selectedVideoUrl, setSelectedVideoUrl] = useState<string | null>(null)

  const [selectedCardObservations, setSelectedCardObservations] = useState<ObservationDTO[]>([])
  const [selectedCardObservationsLoading, setSelectedCardObservationsLoading] = useState<boolean>(false)
  const [selectedCardObservationsError, setSelectedCardObservationsError] = useState<string | null>(null)

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

  const dayKeyRef = useRef<string>(dayKey)
  useEffect(() => {
    dayKeyRef.current = dayKey
  }, [dayKey])

  const viewRef = useRef<typeof view>(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])

  const refreshSetupStatus = useCallback(async () => {
    try {
      const st = await window.chrona.getSetupStatus()
      setSetupStatus(st)
      setHasGeminiKey(st.hasGeminiKey)
    } catch {
      // ignore
    }
  }, [])

  const refreshCategoryLibrary = useCallback(async () => {
    try {
      const lib = await window.chrona.getCategoryLibrary()
      setCategoryDefs(Array.isArray(lib.categories) ? lib.categories : [])
      setSubcategoryDefs(Array.isArray(lib.subcategories) ? lib.subcategories : [])
    } catch {
      // ignore
    }
  }, [])

  const [journalEntry, setJournalEntry] = useState<JournalEntryDTO | null>(null)
  const [journalLoading, setJournalLoading] = useState<boolean>(false)
  const [journalSaveLine, setJournalSaveLine] = useState<string>('')
  const [journalForm, setJournalForm] = useState<{
    intentions: string
    notes: string
    reflections: string
    summary: string
    status: 'draft' | 'complete'
  }>({ intentions: '', notes: '', reflections: '', summary: '', status: 'draft' })
  const pendingJournalPatchRef = useRef<JournalEntryPatch>({})
  const journalSaveTimeoutRef = useRef<number | null>(null)

  const [journalDraftLoading, setJournalDraftLoading] = useState<boolean>(false)
  const [journalDraftError, setJournalDraftError] = useState<string | null>(null)
  const [journalDraft, setJournalDraft] = useState<JournalDraftDTO | null>(null)
  const [journalDraftIncludeObservations, setJournalDraftIncludeObservations] = useState<boolean>(true)
  const [journalDraftIncludeReview, setJournalDraftIncludeReview] = useState<boolean>(true)
  const [journalDraftApplyMode, setJournalDraftApplyMode] = useState<'fillEmpty' | 'append' | 'replace'>('fillEmpty')
  const [journalExportStartDayKey, setJournalExportStartDayKey] = useState<string>(dayKey)
  const [journalExportEndDayKey, setJournalExportEndDayKey] = useState<string>(dayKey)

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
      await refreshSetupStatus()

      const settings = await window.chrona.getSettings()
      setCategoryDefs(Array.isArray((settings as any).categories) ? ((settings as any).categories as any) : [])
      setSubcategoryDefs(
        Array.isArray((settings as any).subcategories) ? ((settings as any).subcategories as any) : []
      )
      // Normalize via main-process validators (best-effort).
      void refreshCategoryLibrary()
      setTimelapsesEnabled(!!settings.timelapsesEnabled)
      setTimelapseFps(Number(settings.timelapseFps ?? 2) || 2)
      setTimelinePxPerHour(
        clampTimelinePxPerHour(settings.timelinePxPerHour ?? TIMELINE_ZOOM_DEFAULT_PX_PER_HOUR)
      )

      setAnalysisCheckIntervalSeconds(String(Math.floor(Number((settings as any).analysisCheckIntervalSeconds ?? 60))))
      setAnalysisLookbackSeconds(String(Math.floor(Number((settings as any).analysisLookbackSeconds ?? 24 * 60 * 60))))
      setAnalysisBatchTargetMinutes(
        String(Math.round(Number((settings as any).analysisBatchTargetDurationSec ?? 30 * 60) / 60))
      )
      setAnalysisBatchMaxGapMinutes(
        String(Math.round(Number((settings as any).analysisBatchMaxGapSec ?? 5 * 60) / 60))
      )
      setAnalysisMinBatchMinutes(
        String(Math.round(Number((settings as any).analysisMinBatchDurationSec ?? 5 * 60) / 60))
      )
      setAnalysisCardWindowMinutes(
        String(Math.round(Number((settings as any).analysisCardWindowLookbackSec ?? 60 * 60) / 60))
      )

      setGeminiModel(String((settings as any).geminiModel ?? 'gemini-2.5-flash'))
      setGeminiRequestTimeoutMs(Number((settings as any).geminiRequestTimeoutMs ?? 60_000) || 60_000)
      setGeminiMaxAttempts(Number((settings as any).geminiMaxAttempts ?? 3) || 3)
      setGeminiLogBodies(!!(settings as any).geminiLogBodies)

      setPromptPreambleTranscribe(String((settings as any).promptPreambleTranscribe ?? ''))
      setPromptPreambleCards(String((settings as any).promptPreambleCards ?? ''))
      setPromptPreambleAsk(String((settings as any).promptPreambleAsk ?? ''))
      setPromptPreambleJournalDraft(String((settings as any).promptPreambleJournalDraft ?? ''))
      setAutoStartEnabled((await window.chrona.getAutoStartEnabled()).enabled)

      setOnboardingCompleted(!!(settings as any).onboardingCompleted)
      if (!(settings as any).onboardingCompleted) {
        setView('onboarding')
      }

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

    const unsubNav = window.chrona.onNavigate((p) => {
      const v = String((p as any)?.view ?? '')
      if (v === 'settings') setView('settings')
      if (v === 'onboarding') setView('onboarding')
    })

    return () => {
      unsubState()
      unsubErr()
      unsubAnalysis()
      unsubUsage()
      unsubNav()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key !== ',') return
      const el = document.activeElement
      const tag = (el && (el as any).tagName ? String((el as any).tagName).toLowerCase() : '')
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      e.preventDefault()
      setView('settings')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (viewRef.current !== 'timeline') return
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() !== 'f') return

      const el = document.activeElement
      const tag = (el && (el as any).tagName ? String((el as any).tagName).toLowerCase() : '')
      if (tag === 'textarea') return

      e.preventDefault()
      const input = timelineSearchInputRef.current
      if (!input) return
      input.focus()
      input.select()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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
    let cancelled = false

    setSelectedCardObservations([])
    setSelectedCardObservationsError(null)
    setSelectedCardObservationsLoading(false)

    if (selectedCardId === null) return

    setSelectedCardObservationsLoading(true)
    void (async () => {
      try {
        const res = await window.chrona.getTimelineCardObservations(selectedCardId)
        if (cancelled) return
        setSelectedCardObservations(Array.isArray(res.observations) ? res.observations : [])
      } catch (e) {
        if (cancelled) return
        setSelectedCardObservationsError(e instanceof Error ? e.message : String(e))
      } finally {
        if (cancelled) return
        setSelectedCardObservationsLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [selectedCardId])

  useEffect(() => {
    void refreshDay(dayKey, false)
  }, [dayKey])

  useEffect(() => {
    if (view !== 'journal') return
    void (async () => {
      const k = dayKey
      if (journalSaveTimeoutRef.current !== null) {
        window.clearTimeout(journalSaveTimeoutRef.current)
        journalSaveTimeoutRef.current = null
      }
      pendingJournalPatchRef.current = {}
      setJournalLoading(true)
      setJournalDraft(null)
      setJournalDraftError(null)
      setJournalSaveLine('')
      setJournalExportStartDayKey(k)
      setJournalExportEndDayKey(k)
      try {
        const res = await window.chrona.getJournalDay(k)
        if (dayKeyRef.current !== k || viewRef.current !== 'journal') return
        setJournalEntry(res.entry)
        setJournalForm({
          intentions: res.entry?.intentions ?? '',
          notes: res.entry?.notes ?? '',
          reflections: res.entry?.reflections ?? '',
          summary: res.entry?.summary ?? '',
          status: res.entry?.status ?? 'draft'
        })
      } finally {
        if (dayKeyRef.current === k && viewRef.current === 'journal') setJournalLoading(false)
      }
    })()
  }, [view, dayKey])

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

  useEffect(() => {
    if (view !== 'timeline') return
    if (timelineSearchScopePreset === 'day') {
      setTimelineSearchLoading(false)
      setTimelineSearchError(null)
      setTimelineSearchHits([])
      setTimelineSearchHasMore(false)
      setTimelineSearchOffset(0)
      timelineSearchReqKeyRef.current = ''
      return
    }

    const q = timelineSearchQuery.trim()
    const hasMeaningfulFilters = !!(
      (timelineFilters.categories && timelineFilters.categories.length > 0) ||
      timelineFilters.onlyErrors ||
      timelineFilters.hasVideo ||
      timelineFilters.hasDetails
    )

    if (q.length < 2 && !hasMeaningfulFilters) {
      setTimelineSearchLoading(false)
      setTimelineSearchError(null)
      setTimelineSearchHits([])
      setTimelineSearchHasMore(false)
      setTimelineSearchOffset(0)
      timelineSearchReqKeyRef.current = ''
      return
    }

    const runId = (timelineSearchRunIdRef.current += 1)
    setTimelineSearchLoading(true)
    setTimelineSearchError(null)

    const scope = getTimelineSearchScope(timelineSearchScopePreset, dayKey)
    const limit = 200
    const req: TimelineSearchRequestDTO = {
      query: q,
      scope,
      filters: timelineFilters,
      limit,
      offset: 0
    }

    const reqKey = JSON.stringify({
      scopePreset: timelineSearchScopePreset,
      dayKey,
      q,
      filters: timelineFilters,
      limit
    })
    timelineSearchReqKeyRef.current = reqKey

    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await window.chrona.searchTimeline(req)
          if (timelineSearchRunIdRef.current !== runId) return
          if (timelineSearchReqKeyRef.current !== reqKey) return
          setTimelineSearchHits(res.hits)
          setTimelineSearchHasMore(res.hasMore)
          setTimelineSearchOffset(res.offset + res.limit)
        } catch (e) {
          if (timelineSearchRunIdRef.current !== runId) return
          setTimelineSearchHits([])
          setTimelineSearchHasMore(false)
          setTimelineSearchOffset(0)
          setTimelineSearchError(e instanceof Error ? e.message : String(e))
        } finally {
          if (timelineSearchRunIdRef.current === runId) setTimelineSearchLoading(false)
        }
      })()
    }, 200)

    return () => window.clearTimeout(t)
  }, [
    view,
    timelineSearchScopePreset,
    timelineSearchQuery,
    timelineFilters,
    dayKey
  ])

  useEffect(() => {
    if (view !== 'timeline') return
    if (timelineSearchScopePreset === 'day') return
    setSelectedCardId(null)
  }, [view, timelineSearchScopePreset])

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

  function jumpToTimelineCard(c: TimelineCardDTO) {
    pendingJumpRef.current = { dayKey: c.dayKey, cardId: c.id }
    setTimelineSearchScopePreset('day')
    setView('timeline')
    setDayKey(c.dayKey)
  }

  async function loadMoreTimelineSearch() {
    if (viewRef.current !== 'timeline') return
    if (timelineSearchScopePreset === 'day') return
    if (!timelineSearchHasMore) return

    const q = timelineSearchQuery.trim()
    const hasMeaningfulFilters = !!(
      (timelineFilters.categories && timelineFilters.categories.length > 0) ||
      timelineFilters.onlyErrors ||
      timelineFilters.hasVideo ||
      timelineFilters.hasDetails
    )
    if (q.length < 2 && !hasMeaningfulFilters) return

    const reqKey = timelineSearchReqKeyRef.current
    if (!reqKey) return

    setTimelineSearchLoading(true)
    setTimelineSearchError(null)
    try {
      const scope = getTimelineSearchScope(timelineSearchScopePreset, dayKeyRef.current)
      const limit = 200
      const req: TimelineSearchRequestDTO = {
        query: q,
        scope,
        filters: timelineFilters,
        limit,
        offset: timelineSearchOffset
      }
      const res = await window.chrona.searchTimeline(req)
      if (timelineSearchReqKeyRef.current !== reqKey) return

      setTimelineSearchHits((prev) => [...prev, ...res.hits])
      setTimelineSearchHasMore(res.hasMore)
      setTimelineSearchOffset(res.offset + res.limit)
    } catch (e) {
      setTimelineSearchError(e instanceof Error ? e.message : String(e))
    } finally {
      setTimelineSearchLoading(false)
    }
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

  function onApplyAnalysisPreset(presetId: string) {
    switch (presetId) {
      case 'balanced':
        setAnalysisCheckIntervalSeconds('60')
        setAnalysisLookbackSeconds(String(24 * 60 * 60))
        setAnalysisBatchTargetMinutes('30')
        setAnalysisBatchMaxGapMinutes('5')
        setAnalysisMinBatchMinutes('5')
        setAnalysisCardWindowMinutes('60')
        return
      case 'faster':
        setAnalysisCheckIntervalSeconds('30')
        setAnalysisLookbackSeconds(String(24 * 60 * 60))
        setAnalysisBatchTargetMinutes('15')
        setAnalysisBatchMaxGapMinutes('2')
        setAnalysisMinBatchMinutes('3')
        setAnalysisCardWindowMinutes('45')
        return
      case 'low_resource':
        setAnalysisCheckIntervalSeconds('120')
        setAnalysisLookbackSeconds(String(12 * 60 * 60))
        setAnalysisBatchTargetMinutes('45')
        setAnalysisBatchMaxGapMinutes('7')
        setAnalysisMinBatchMinutes('5')
        setAnalysisCardWindowMinutes('90')
        return
      case 'catch_up':
        setAnalysisCheckIntervalSeconds('60')
        setAnalysisLookbackSeconds(String(72 * 60 * 60))
        setAnalysisBatchTargetMinutes('30')
        setAnalysisBatchMaxGapMinutes('10')
        setAnalysisMinBatchMinutes('5')
        setAnalysisCardWindowMinutes('60')
        return
    }
  }

  async function onSaveAnalysisConfig() {
    const checkIntervalSec = Math.floor(Number(analysisCheckIntervalSeconds))
    const lookbackSec = Math.floor(Number(analysisLookbackSeconds))
    const targetDurationSec = Math.floor(Number(analysisBatchTargetMinutes) * 60)
    const maxGapSec = Math.floor(Number(analysisBatchMaxGapMinutes) * 60)
    const minBatchDurationSec = Math.floor(Number(analysisMinBatchMinutes) * 60)
    const windowLookbackSec = Math.floor(Number(analysisCardWindowMinutes) * 60)

    if (!Number.isFinite(checkIntervalSec) || checkIntervalSec <= 0) return
    if (!Number.isFinite(lookbackSec) || lookbackSec <= 0) return
    if (!Number.isFinite(targetDurationSec) || targetDurationSec <= 0) return
    if (!Number.isFinite(maxGapSec) || maxGapSec <= 0) return
    if (!Number.isFinite(minBatchDurationSec) || minBatchDurationSec <= 0) return
    if (!Number.isFinite(windowLookbackSec) || windowLookbackSec <= 0) return

    await window.chrona.updateSettings({
      analysisCheckIntervalSeconds: checkIntervalSec as any,
      analysisLookbackSeconds: lookbackSec as any,
      analysisBatchTargetDurationSec: targetDurationSec as any,
      analysisBatchMaxGapSec: maxGapSec as any,
      analysisMinBatchDurationSec: minBatchDurationSec as any,
      analysisCardWindowLookbackSec: windowLookbackSec as any
    } as any)
  }

  async function onSaveGeminiKey() {
    if (!geminiKeyInput.trim()) return
    await window.chrona.setGeminiApiKey(geminiKeyInput)
    setGeminiKeyInput('')
    await refreshSetupStatus()
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

  async function onSaveTimelapseFps() {
    const fps = Math.max(1, Math.floor(Number(timelapseFps)))
    if (!Number.isFinite(fps) || fps <= 0) return
    setTimelapseFps(fps)
    await window.chrona.updateSettings({ timelapseFps: fps })
  }

  async function onSaveGeminiRuntime() {
    const timeoutMs = Math.max(1000, Math.floor(Number(geminiRequestTimeoutMs)))
    const attempts = Math.max(1, Math.floor(Number(geminiMaxAttempts)))
    const model = String(geminiModel || '').trim() || 'gemini-2.5-flash'
    setGeminiModel(model)
    setGeminiRequestTimeoutMs(timeoutMs)
    setGeminiMaxAttempts(attempts)
    await window.chrona.updateSettings({
      geminiModel: model as any,
      geminiRequestTimeoutMs: timeoutMs as any,
      geminiMaxAttempts: attempts as any,
      geminiLogBodies: !!geminiLogBodies as any
    } as any)
  }

  async function onSavePromptPreambles() {
    await window.chrona.updateSettings({
      promptPreambleTranscribe: promptPreambleTranscribe as any,
      promptPreambleCards: promptPreambleCards as any,
      promptPreambleAsk: promptPreambleAsk as any,
      promptPreambleJournalDraft: promptPreambleJournalDraft as any
    } as any)
  }

  async function onCreateCategory(input: { name: string; color: string; description: string }) {
    await window.chrona.createCategory(input)
    await refreshCategoryLibrary()
  }

  async function onUpdateCategory(input: {
    id: string
    patch: Partial<{ name: string; color: string; description: string }>
  }) {
    await window.chrona.updateCategory(input as any)
    await refreshCategoryLibrary()
  }

  async function onDeleteCategory(input: { id: string; reassignToCategoryId: string }) {
    await window.chrona.deleteCategory(input)
    await refreshCategoryLibrary()
    void refreshDay(dayKeyRef.current, true)
  }

  async function onCreateSubcategory(input: {
    categoryId: string
    name: string
    color: string
    description: string
  }) {
    await window.chrona.createSubcategory(input as any)
    await refreshCategoryLibrary()
  }

  async function onUpdateSubcategory(input: {
    id: string
    patch: Partial<{ name: string; color: string; description: string }>
  }) {
    await window.chrona.updateSubcategory(input as any)
    await refreshCategoryLibrary()
  }

  async function onDeleteSubcategory(input:
    | { id: string; mode: 'clear' }
    | { id: string; mode: 'reassign'; reassignToSubcategoryId: string }) {
    await window.chrona.deleteSubcategory(input as any)
    await refreshCategoryLibrary()
    void refreshDay(dayKeyRef.current, true)
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
    try {
      const next = await window.chrona.setRecordingEnabled(!recording)
      setRecording(next.desiredRecordingEnabled)
      setSystemPaused(next.isSystemPaused)
      setStatusLine(formatCaptureStatus(next))
      await refreshSetupStatus()
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e))
      await refreshSetupStatus()
    }
  }

  async function onStartRecording() {
    if (recording) return
    try {
      const next = await window.chrona.setRecordingEnabled(true)
      setRecording(next.desiredRecordingEnabled)
      setSystemPaused(next.isSystemPaused)
      setStatusLine(formatCaptureStatus(next))
      await refreshSetupStatus()
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e))
      await refreshSetupStatus()
    }
  }

  async function markOnboardingComplete() {
    await window.chrona.updateSettings({ onboardingCompleted: true, onboardingVersion: 1 } as any)
    setOnboardingCompleted(true)
  }

  async function onCopyDay() {
    await window.chrona.copyDayToClipboard(dayKey)
  }

  function openTimelineExportDialog() {
    setExportStartDayKey(dayKey)
    setExportEndDayKey(dayKey)
    setExportLine('')
    setExportDialogOpen(true)
  }

  async function runTimelineExport() {
    const start = exportStartDayKey
    const end = exportEndDayKey
    if (!start || !end) {
      setExportLine('Export failed: start/end date required')
      return
    }

    const a = start <= end ? start : end
    const b = start <= end ? end : start

    setExportLine('Exporting…')
    try {
      if (exportFormat === 'md') {
        await window.chrona.saveMarkdownRange(a, b)
      } else if (exportFormat === 'csv') {
        await window.chrona.saveCsvRange(a, b, {
          includeSystem: exportIncludeSystem,
          includeReviewCoverage: exportIncludeReviewCoverage
        })
      } else {
        await window.chrona.saveXlsxRange(a, b, {
          includeSystem: exportIncludeSystem,
          includeReviewCoverage: exportIncludeReviewCoverage
        })
      }
      setExportLine('Export complete')
      setExportDialogOpen(false)
    } catch (e) {
      setExportLine(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function scheduleJournalSave(dayKeyForSave: string, patch: JournalEntryPatch) {
    pendingJournalPatchRef.current = { ...pendingJournalPatchRef.current, ...patch }
    setJournalSaveLine('Saving…')

    if (journalSaveTimeoutRef.current !== null) {
      window.clearTimeout(journalSaveTimeoutRef.current)
    }

    journalSaveTimeoutRef.current = window.setTimeout(() => {
      const k = dayKeyForSave
      const toSend = pendingJournalPatchRef.current
      pendingJournalPatchRef.current = {}

      void (async () => {
        try {
          const res = await window.chrona.upsertJournalEntry(k, toSend)
          if (dayKeyRef.current !== k) return
          setJournalEntry(res.entry)
          setJournalSaveLine(`Saved · ${new Date().toLocaleTimeString()}`)
        } catch (e) {
          if (dayKeyRef.current !== k) return
          setJournalSaveLine(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    }, 800)
  }

  function updateJournalField<K extends keyof typeof journalForm>(key: K, value: (typeof journalForm)[K]) {
    setJournalForm((prev) => ({ ...prev, [key]: value }))
    const patch: JournalEntryPatch = { [key]: value } as any
    scheduleJournalSave(dayKey, patch)
  }

  async function onJournalCopyDay() {
    await window.chrona.copyJournalDayToClipboard(dayKey)
  }

  async function onJournalExportRange(start: string, end: string) {
    await window.chrona.saveJournalMarkdownRange(start, end)
  }

  async function onJournalDelete() {
    const ok = window.confirm('Delete this journal entry? This cannot be undone.')
    if (!ok) return
    await window.chrona.deleteJournalEntry(dayKey)
    setJournalEntry(null)
    setJournalForm({ intentions: '', notes: '', reflections: '', summary: '', status: 'draft' })
    setJournalDraft(null)
    setJournalDraftError(null)
    setJournalSaveLine('Deleted')
  }

  async function onJournalDraftWithGemini() {
    const k = dayKey
    setJournalDraftLoading(true)
    setJournalDraftError(null)
    setJournalDraft(null)
    try {
      const res = await window.chrona.draftJournalWithGemini(k, {
        includeObservations: journalDraftIncludeObservations,
        includeReview: journalDraftIncludeReview
      })
      if (dayKeyRef.current !== k) return
      setJournalDraft(res.draft)
    } catch (e) {
      setJournalDraftError(e instanceof Error ? e.message : String(e))
    } finally {
      setJournalDraftLoading(false)
    }
  }

  function applyJournalDraft(mode: 'fillEmpty' | 'append' | 'replace') {
    if (!journalDraft) return

    const next: JournalEntryPatch = {}
    const applyField = (key: 'intentions' | 'notes' | 'reflections' | 'summary') => {
      const draftText = (journalDraft as any)[key] as string
      const current = (journalForm as any)[key] as string
      const curTrim = String(current ?? '').trim()
      const draftTrim = String(draftText ?? '').trim()
      if (!draftTrim) return

      if (mode === 'fillEmpty') {
        if (curTrim) return
        ;(next as any)[key] = draftTrim
        return
      }
      if (mode === 'replace') {
        ;(next as any)[key] = draftTrim
        return
      }
      // append
      if (!curTrim) {
        ;(next as any)[key] = draftTrim
        return
      }
      ;(next as any)[key] = `${current.replace(/\s*$/g, '')}\n\n${draftTrim}`
    }

    applyField('intentions')
    applyField('notes')
    applyField('reflections')
    applyField('summary')

    if (Object.keys(next).length === 0) return
    setJournalForm((prev) => ({
      ...prev,
      intentions: Object.prototype.hasOwnProperty.call(next, 'intentions') ? (next.intentions as any) : prev.intentions,
      notes: Object.prototype.hasOwnProperty.call(next, 'notes') ? (next.notes as any) : prev.notes,
      reflections: Object.prototype.hasOwnProperty.call(next, 'reflections')
        ? (next.reflections as any)
        : prev.reflections,
      summary: Object.prototype.hasOwnProperty.call(next, 'summary') ? (next.summary as any) : prev.summary
    }))
    scheduleJournalSave(dayKey, next)
    setJournalSaveLine('Draft applied')
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

  function onNow() {
    const ts = Math.floor(Date.now() / 1000)
    const k = dayKeyFromUnixSeconds(ts)
    pendingScrollToTsRef.current = ts
    setTimelineSearchScopePreset('day')
    setView('timeline')
    setDayKey(k)

    // If we're already on the correct day and mounted, scroll immediately.
    requestAnimationFrame(() => {
      const scroller = timelineScrollRef.current
      if (!scroller) return
      if (viewRef.current !== 'timeline') return
      if (dayKeyRef.current !== k) return

      const windowInfo = dayWindowForDayKey(k)
      const y = timeToYpx(ts, windowInfo.startTs, windowInfo.endTs, timelineMetrics)
      const anchorFrac = 0.35
      const targetTop = Math.round(y - scroller.clientHeight * anchorFrac)
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      const top = clampNumber(targetTop, 0, maxTop)
      scroller.scrollTo({ top, behavior: 'smooth' })
      pendingScrollToTsRef.current = null
    })
  }

  const timelineMetrics = useMemo(() => getTimelineMetrics(timelinePxPerHour), [timelinePxPerHour])

  useEffect(() => {
    if (pendingScrollToTsRef.current === null) return
    if (view !== 'timeline') return
    if (timelineSearchScopePreset !== 'day') return

    const ts = pendingScrollToTsRef.current
    if (dayKeyFromUnixSeconds(ts) !== dayKey) return

    const scroller = timelineScrollRef.current
    if (!scroller) return

    const windowInfo = dayWindowForDayKey(dayKey)
    if (ts < windowInfo.startTs || ts > windowInfo.endTs) return

    const y = timeToYpx(ts, windowInfo.startTs, windowInfo.endTs, timelineMetrics)
    const anchorFrac = 0.35
    const targetTop = Math.round(y - scroller.clientHeight * anchorFrac)
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const top = clampNumber(targetTop, 0, maxTop)

    scroller.scrollTo({ top, behavior: 'smooth' })
    pendingScrollToTsRef.current = null
  }, [dayKey, timelineMetrics, timelineSearchScopePreset, view])

  const visibleDayCards = useMemo(() => {
    if (timelineSearchScopePreset !== 'day') return cards
    return applyTimelineClientFilters(cards, timelineSearchQuery, timelineFilters)
  }, [cards, timelineSearchQuery, timelineFilters, timelineSearchScopePreset])

  useEffect(() => {
    if (view !== 'timeline') return
    if (timelineSearchScopePreset !== 'day') return
    if (selectedCardId === null) return
    if (!visibleDayCards.some((c) => c.id === selectedCardId)) {
      setSelectedCardId(null)
    }
  }, [view, timelineSearchScopePreset, visibleDayCards, selectedCardId])

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
              {view === 'onboarding'
                ? 'Setup'
                : view === 'ask'
                  ? 'Ask Chrona'
                  : view === 'review'
                    ? 'Review'
                    : view === 'dashboard'
                      ? 'Dashboard'
                      : view === 'journal'
                        ? `Journal · ${dayKey}`
                        : `Timeline · ${dayKey}`}
            </div>
          </div>

        <div className="toolbar">
          <button
            className={`btn ${view === 'onboarding' ? 'btn-accent' : ''}`}
            onClick={() => setView('onboarding')}
          >
            Setup
          </button>
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
          <button
            className={`btn ${view === 'journal' ? 'btn-accent' : ''}`}
            onClick={() => setView('journal')}
          >
            Journal
          </button>
          <button
            className={`btn ${view === 'settings' ? 'btn-accent' : ''}`}
            onClick={() => setView('settings')}
          >
            Settings
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
           <button className="btn" onClick={onNow}>
             Now
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
          <button className="btn" onClick={() => void (view === 'journal' ? onJournalCopyDay() : onCopyDay())}>
            {view === 'journal' ? 'Copy Journal' : 'Copy Timeline'}
          </button>
          <button
            className="btn"
            onClick={() => void (view === 'journal' ? onJournalExportRange(dayKey, dayKey) : openTimelineExportDialog())}
          >
            {view === 'journal' ? 'Export Journal' : 'Export Timeline'}
          </button>
        </div>
      </header>

      {exportDialogOpen && view !== 'journal' ? (
        <div
          className="modalOverlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setExportDialogOpen(false)
          }}
        >
          <div className="modal">
            <div className="modalTitle">Export timeline</div>
            <div className="modalMeta">Choose a date range and file format.</div>

            <div className="row">
              <label className="label">
                Start
                <input
                  className="input"
                  type="date"
                  value={exportStartDayKey}
                  onChange={(e) => setExportStartDayKey(e.target.value)}
                />
              </label>
              <label className="label">
                End
                <input
                  className="input"
                  type="date"
                  value={exportEndDayKey}
                  onChange={(e) => setExportEndDayKey(e.target.value)}
                />
              </label>
            </div>

            <div className="row">
              <label className="label">
                Format
                <select className="input" value={exportFormat} onChange={(e) => setExportFormat(e.target.value as any)}>
                  <option value="xlsx">Excel (.xlsx)</option>
                  <option value="csv">CSV (.csv)</option>
                  <option value="md">Markdown (.md)</option>
                </select>
              </label>
            </div>

            <div className="row">
              <label className="pill">
                <input
                  type="checkbox"
                  checked={exportIncludeSystem}
                  onChange={(e) => setExportIncludeSystem(e.target.checked)}
                />
                Include System cards
              </label>
              <label className="pill">
                <input
                  type="checkbox"
                  checked={exportIncludeReviewCoverage}
                  onChange={(e) => setExportIncludeReviewCoverage(e.target.checked)}
                />
                Include review coverage
              </label>
            </div>

            {exportLine ? (
              <div className="row">
                <div className="mono">{exportLine}</div>
              </div>
            ) : null}

            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setExportDialogOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-accent" onClick={() => void runTimelineExport()}>
                Export
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {setupStatus?.platform === 'darwin' && setupStatus.captureAccess.status === 'denied' ? (
        <div className="setupBanner">
          <div className="setupBannerLeft">
            <div className="setupBannerTitle">Screen capture permission required</div>
            <div className="setupBannerMeta">
              macOS Screen Recording permission is missing. Recording is disabled until you enable it.
            </div>
          </div>
          <button className="btn btn-accent" onClick={() => setView('onboarding')}>
            Finish setup
          </button>
        </div>
      ) : null}

      {setupStatus && !setupStatus.hasGeminiKey ? (
        <div className="setupBanner">
          <div className="setupBannerLeft">
            <div className="setupBannerTitle">Gemini API key missing</div>
            <div className="setupBannerMeta">Recording works, but analysis will stay pending until a key is configured.</div>
          </div>
          <button className="btn" onClick={() => setView('onboarding')}>
            Add key
          </button>
        </div>
      ) : null}

      <main className="layout">
        {view === 'onboarding' ? (
          <section className="timeline">
            <div className="timelineScroll">
              <OnboardingView
                setupStatus={setupStatus}
                onboardingCompleted={onboardingCompleted}
                onRefreshSetupStatus={refreshSetupStatus}
                onMarkCompleted={markOnboardingComplete}
                onStartRecording={onStartRecording}
                onGoToTimeline={() => setView('timeline')}
              />
            </div>
          </section>
        ) : view === 'timeline' ? (
          <section className="timeline">
            <div className="timelineControls">
              <div className="timelineControlsRow">
                <div className="field" style={{ minWidth: 260, flex: 1 }}>
                  <div className="label">Search</div>
                  <input
                    ref={timelineSearchInputRef}
                    className="input"
                    placeholder="Search timeline…"
                    value={timelineSearchQuery}
                    onChange={(e) => setTimelineSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setTimelineSearchQuery('')
                        ;(e.currentTarget as any).blur?.()
                      }
                    }}
                  />
                </div>

                <div className="field" style={{ minWidth: 180 }}>
                  <div className="label">Scope</div>
                  <select
                    className="input"
                    value={timelineSearchScopePreset}
                    onChange={(e) => setTimelineSearchScopePreset(e.target.value as any)}
                  >
                    <option value="day">Selected day</option>
                    <option value="today">Today</option>
                    <option value="yesterday">Yesterday</option>
                    <option value="last7">Last 7 days</option>
                    <option value="last30">Last 30 days</option>
                    <option value="all">All time</option>
                  </select>
                </div>

                <div className="row" style={{ alignSelf: 'end' }}>
                  <button
                    className="btn"
                    onClick={() => {
                      setTimelineSearchQuery('')
                      setTimelineFilters({
                        includeSystem: true,
                        onlyErrors: false,
                        hasVideo: false,
                        hasDetails: false,
                        categories: []
                      })
                    }}
                  >
                    Clear
                  </button>
                </div>

                <div className="row" style={{ alignSelf: 'end', flexWrap: 'wrap' }}>
                  <label className="pill">
                    <input
                      type="checkbox"
                      checked={!!timelineFilters.includeSystem}
                      disabled={!!timelineFilters.onlyErrors}
                      onChange={(e) =>
                        setTimelineFilters((prev) => ({
                          ...prev,
                          includeSystem: e.target.checked
                        }))
                      }
                    />
                    Include System
                  </label>
                  <label className="pill">
                    <input
                      type="checkbox"
                      checked={!!timelineFilters.onlyErrors}
                      onChange={(e) =>
                        setTimelineFilters((prev) => ({
                          ...prev,
                          onlyErrors: e.target.checked,
                          includeSystem: e.target.checked ? true : prev.includeSystem
                        }))
                      }
                    />
                    Only errors
                  </label>
                  <label className="pill">
                    <input
                      type="checkbox"
                      checked={!!timelineFilters.hasVideo}
                      onChange={(e) =>
                        setTimelineFilters((prev) => ({
                          ...prev,
                          hasVideo: e.target.checked
                        }))
                      }
                    />
                    Has video
                  </label>
                  <label className="pill">
                    <input
                      type="checkbox"
                      checked={!!timelineFilters.hasDetails}
                      onChange={(e) =>
                        setTimelineFilters((prev) => ({
                          ...prev,
                          hasDetails: e.target.checked
                        }))
                      }
                    />
                    Has details
                  </label>
                </div>
              </div>

              <div className="timelineControlsRow">
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  {[...categoryNamesOrdered, 'System'].map((cat) => {
                    const active = (timelineFilters.categories ?? []).includes(cat)
                    return (
                      <button
                        key={cat}
                        className={`chip ${active ? 'chip-active' : ''}`}
                        onClick={() => {
                          setTimelineFilters((prev) => {
                            const cur = new Set(prev.categories ?? [])
                            if (cur.has(cat)) cur.delete(cat)
                            else cur.add(cat)
                            const nextCats = [...cur]
                            const includeSystem =
                              prev.onlyErrors || prev.includeSystem || nextCats.includes('System')
                            return {
                              ...prev,
                              includeSystem,
                              categories: nextCats
                            }
                          })
                        }}
                        type="button"
                      >
                        {cat}
                      </button>
                    )
                  })}
                </div>
              </div>

              {timelineSearchScopePreset !== 'day' ? (
                <div className="timelineControlsMeta">
                  {timelineSearchLoading
                    ? 'Searching…'
                    : timelineSearchError
                      ? `Search error: ${timelineSearchError}`
                      : `${timelineSearchHits.length} result${timelineSearchHits.length === 1 ? '' : 's'}`}
                </div>
              ) : timelineSearchQuery.trim() || (timelineFilters.categories ?? []).length > 0 || timelineFilters.hasVideo || timelineFilters.hasDetails || timelineFilters.onlyErrors ? (
                <div className="timelineControlsMeta">
                  Showing {visibleDayCards.length} card{visibleDayCards.length === 1 ? '' : 's'}
                </div>
              ) : null}
            </div>

            <div className="timelineScroll" ref={timelineScrollRef}>
              {timelineSearchScopePreset !== 'day' ? (
                <div className="searchResults">
                  {timelineSearchError ? <div className="mono error">{timelineSearchError}</div> : null}

                  {!timelineSearchLoading && timelineSearchHits.length === 0 && !timelineSearchError ? (
                    <div className="reviewEmpty">
                      <div className="sideTitle">No results</div>
                      <div className="sideMeta">
                        Type at least 2 characters, or use filters (errors/video/details/categories).
                      </div>
                    </div>
                  ) : null}

                  {timelineSearchHits.map((h) => {
                    const c = h.card
                    return (
                      <button
                        key={`${c.dayKey}:${c.id}`}
                        className="searchHit"
                        onClick={() => jumpToTimelineCard(c)}
                      >
                        <div className="searchHitTop">
                          <div className="searchHitTitle">{c.title}</div>
                          <div className="searchHitMeta">
                            {c.dayKey} · {formatClockAscii(c.startTs)} - {formatClockAscii(c.endTs)} · {c.category}
                          </div>
                        </div>
                        {h.snippet || c.summary ? (
                          <div className="searchHitSnippet">{h.snippet ?? c.summary}</div>
                        ) : null}
                      </button>
                    )
                  })}

                  {timelineSearchHasMore && !timelineSearchLoading ? (
                    <div className="row" style={{ padding: '12px 16px' }}>
                      <button className="btn" onClick={() => void loadMoreTimelineSearch()}>
                        Load more
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="timelineGrid" style={{ height: `${timelineMetrics.gridHeightPx}px` }}>
                  {renderTimeTicks(windowInfo.startTs, timelinePxPerHour)}
                  {nowYpx !== null ? <div className="nowLine" style={{ top: `${nowYpx}px` }} /> : null}

                   {visibleDayCards.map((c) => {
                     const layout = cardLayout(c, windowInfo.startTs, windowInfo.endTs, timelineMetrics)
                     return (
                       <div
                         key={c.id}
                         className={`card ${layout.sizeClass} ${selectedCardId === c.id ? 'selected' : ''} ${c.category === 'System' ? 'system' : ''}`}
                          style={{
                            ...layout.style,
                            ['--catColor' as any]: getCategoryColor(c.category, categoryColorsByName)
                          }}
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
              )}
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
                      <div className={`askMsgBody ${m.role === 'assistant' ? 'md' : 'plain'}`}>
                        {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
                      </div>
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
        ) : view === 'journal' ? (
          <section className="timeline">
            <div className="timelineScroll">
              <div className="journalWrap">
                <div className="journalHeader">
                  <div>
                    <div className="sideTitle">Journal</div>
                    <div className="sideMeta">
                      Structured daily entry for {dayKey} (4 AM to 4 AM). {journalSaveLine ? journalSaveLine : ''}
                    </div>
                  </div>

                  <div className="journalHeaderRight">
                    <div className="pill">Status: {journalForm.status}</div>
                    <button className="btn" disabled={journalLoading} onClick={() => void onJournalDelete()}>
                      Delete
                    </button>
                  </div>
                </div>

                {journalLoading ? <div className="mono">Loading…</div> : null}

                <div className="journalField">
                  <div className="label">Intentions</div>
                  <textarea
                    className="input journalTextarea"
                    rows={6}
                    value={journalForm.intentions}
                    onChange={(e) => updateJournalField('intentions', e.target.value)}
                    placeholder="What do you want to accomplish?"
                  />
                </div>

                <div className="journalField">
                  <div className="label">Notes</div>
                  <textarea
                    className="input journalTextarea"
                    rows={10}
                    value={journalForm.notes}
                    onChange={(e) => updateJournalField('notes', e.target.value)}
                    placeholder="Key events, decisions, or context."
                  />
                </div>

                <div className="journalField">
                  <div className="label">Reflections</div>
                  <textarea
                    className="input journalTextarea"
                    rows={10}
                    value={journalForm.reflections}
                    onChange={(e) => updateJournalField('reflections', e.target.value)}
                    placeholder="What went well? What was hard? One improvement for next time."
                  />
                </div>

                <div className="journalField">
                  <div className="label">Summary</div>
                  <textarea
                    className="input journalTextarea"
                    rows={8}
                    value={journalForm.summary}
                    onChange={(e) => updateJournalField('summary', e.target.value)}
                    placeholder="Short recap of the day."
                  />
                </div>
              </div>
            </div>
          </section>
        ) : view === 'settings' ? (
          <section className="timeline">
            <div className="timelineScroll">
                <SettingsView
                  statusLine={statusLine}
                  recording={recording}
                  systemPaused={systemPaused}
                  lastError={lastError}
                  onToggleRecording={onToggleRecording}
                  interval={interval}
                  setInterval={setInterval}
                  onSaveInterval={onSaveInterval}
                  displays={displays}
                  selectedDisplayId={selectedDisplayId}
                  onSelectDisplay={onSelectDisplay}
                  analysisLine={analysisLine}
                  onRunAnalysisTick={onRunAnalysisTick}
                  analysisCheckIntervalSeconds={analysisCheckIntervalSeconds}
                  setAnalysisCheckIntervalSeconds={setAnalysisCheckIntervalSeconds}
                  analysisLookbackSeconds={analysisLookbackSeconds}
                  setAnalysisLookbackSeconds={setAnalysisLookbackSeconds}
                  analysisBatchTargetMinutes={analysisBatchTargetMinutes}
                  setAnalysisBatchTargetMinutes={setAnalysisBatchTargetMinutes}
                  analysisBatchMaxGapMinutes={analysisBatchMaxGapMinutes}
                  setAnalysisBatchMaxGapMinutes={setAnalysisBatchMaxGapMinutes}
                  analysisMinBatchMinutes={analysisMinBatchMinutes}
                  setAnalysisMinBatchMinutes={setAnalysisMinBatchMinutes}
                  analysisCardWindowMinutes={analysisCardWindowMinutes}
                  setAnalysisCardWindowMinutes={setAnalysisCardWindowMinutes}
                  onApplyAnalysisPreset={onApplyAnalysisPreset}
                  onSaveAnalysisConfig={onSaveAnalysisConfig}
                  storageUsage={storageUsage}
                  limitRecordingsGb={limitRecordingsGb}
                  setLimitRecordingsGb={setLimitRecordingsGb}
                  limitTimelapsesGb={limitTimelapsesGb}
                  setLimitTimelapsesGb={setLimitTimelapsesGb}
                  onSaveStorageLimits={onSaveStorageLimits}
                  onPurgeNow={onPurgeNow}
                  timelapsesEnabled={timelapsesEnabled}
                  onToggleTimelapsesEnabled={onToggleTimelapsesEnabled}
                  timelapseFps={timelapseFps}
                  setTimelapseFps={setTimelapseFps}
                  onSaveTimelapseFps={onSaveTimelapseFps}
                  autoStartEnabled={autoStartEnabled}
                  onToggleAutoStartEnabled={onToggleAutoStartEnabled}
                  hasGeminiKey={hasGeminiKey}
                  geminiKeyInput={geminiKeyInput}
                  setGeminiKeyInput={setGeminiKeyInput}
                  onSaveGeminiKey={onSaveGeminiKey}
                  geminiModel={geminiModel}
                  setGeminiModel={setGeminiModel}
                  geminiRequestTimeoutMs={geminiRequestTimeoutMs}
                  setGeminiRequestTimeoutMs={setGeminiRequestTimeoutMs}
                  geminiMaxAttempts={geminiMaxAttempts}
                  setGeminiMaxAttempts={setGeminiMaxAttempts}
                  geminiLogBodies={geminiLogBodies}
                  setGeminiLogBodies={setGeminiLogBodies}
                  onSaveGeminiRuntime={onSaveGeminiRuntime}
                  promptPreambleTranscribe={promptPreambleTranscribe}
                  setPromptPreambleTranscribe={setPromptPreambleTranscribe}
                  promptPreambleCards={promptPreambleCards}
                  setPromptPreambleCards={setPromptPreambleCards}
                  promptPreambleAsk={promptPreambleAsk}
                  setPromptPreambleAsk={setPromptPreambleAsk}
                  promptPreambleJournalDraft={promptPreambleJournalDraft}
                  setPromptPreambleJournalDraft={setPromptPreambleJournalDraft}
                  onSavePromptPreambles={onSavePromptPreambles}

                  categories={categoryDefs}
                  subcategories={subcategoryDefs}
                  onRefreshCategories={refreshCategoryLibrary}
                  onCreateCategory={onCreateCategory}
                  onUpdateCategory={onUpdateCategory}
                  onDeleteCategory={onDeleteCategory}
                  onCreateSubcategory={onCreateSubcategory}
                  onUpdateSubcategory={onUpdateSubcategory}
                  onDeleteSubcategory={onDeleteSubcategory}
                />
            </div>
          </section>
        ) : (
          <section className="timeline">
            <div className="timelineScroll">
              <DashboardView
                selectedDayKey={dayKey}
                categories={categoryDefs}
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
          {view === 'onboarding' ? (
            <div className="sidePanel">
              <div className="sideTitle">Setup status</div>
              <div className="sideMeta">
                Gemini key: {setupStatus ? (setupStatus.hasGeminiKey ? 'configured' : 'missing') : '...'}
                {setupStatus?.platform === 'darwin'
                  ? ` · Capture: ${setupStatus.captureAccess.status === 'granted' ? 'granted' : 'missing'}`
                  : ''}
              </div>

              <div className="row">
                <button className="btn" onClick={() => void refreshSetupStatus()}>
                  Refresh
                </button>
                <button className="btn" onClick={() => setView('timeline')}>
                  Go to Timeline
                </button>
              </div>
            </div>
          ) : view === 'ask' ? (
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
                <div className="sideTitle">System</div>
                <div className="sideMeta">
                  Gemini key: {hasGeminiKey === null ? '...' : hasGeminiKey ? 'configured' : 'missing'} · Capture:
                  {recording ? ' recording' : ' idle'}
                </div>
                <div className="row">
                  <button className="btn" onClick={() => setView('settings')}>
                    Open Settings
                  </button>
                </div>
              </div>
            </div>
          ) : view === 'dashboard' ? (
            <div className="sidePanel">
              <div className="sideTitle">Dashboard</div>
              <div className="sideMeta">Activity stats and trends for a selectable range.</div>

              <div className="block">
                <div className="sideTitle">Quick capture</div>
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
                <div className="sideTitle">Settings</div>
                <div className="sideMeta">
                  Gemini key: {hasGeminiKey === null ? '...' : hasGeminiKey ? 'configured' : 'missing'}
                </div>
                <div className="row">
                  <button className="btn" onClick={() => setView('settings')}>
                    Open Settings
                  </button>
                </div>
              </div>
            </div>
          ) : view === 'journal' ? (
            <div className="sidePanel">
              <div className="sideTitle">Journal tools</div>
              <div className="sideMeta">Draft with Gemini uses timeline text (and optionally observations).</div>

              <div className="field">
                <div className="label">Status</div>
                <select
                  className="input"
                  value={journalForm.status}
                  onChange={(e) => updateJournalField('status', e.target.value as any)}
                >
                  <option value="draft">Draft</option>
                  <option value="complete">Complete</option>
                </select>
              </div>

              <div className="block">
                <div className="sideTitle">Gemini draft</div>
                <div className="sideMeta">
                  Key: {hasGeminiKey === null ? '...' : hasGeminiKey ? 'configured' : 'missing'}
                </div>

                <div className="row">
                  <label className="pill">
                    <input
                      type="checkbox"
                      checked={journalDraftIncludeObservations}
                      onChange={(e) => setJournalDraftIncludeObservations(e.target.checked)}
                    />
                    Use observations
                  </label>
                </div>

                <div className="row">
                  <label className="pill">
                    <input
                      type="checkbox"
                      checked={journalDraftIncludeReview}
                      onChange={(e) => setJournalDraftIncludeReview(e.target.checked)}
                    />
                    Include review ratings
                  </label>
                </div>

                <div className="field">
                  <div className="label">Apply mode</div>
                  <select
                    className="input"
                    value={journalDraftApplyMode}
                    onChange={(e) => setJournalDraftApplyMode(e.target.value as any)}
                  >
                    <option value="fillEmpty">Fill empty fields</option>
                    <option value="append">Append to existing</option>
                    <option value="replace">Replace existing</option>
                  </select>
                </div>

                <div className="row">
                  <button
                    className="btn btn-accent"
                    disabled={journalDraftLoading}
                    onClick={() => void onJournalDraftWithGemini()}
                  >
                    {journalDraftLoading ? 'Drafting…' : 'Draft with Gemini'}
                  </button>
                  <button
                    className="btn"
                    disabled={!journalDraft}
                    onClick={() => applyJournalDraft(journalDraftApplyMode)}
                  >
                    Apply draft
                  </button>
                </div>

                {journalDraftError ? <div className="mono error">Draft error: {journalDraftError}</div> : null}

                {journalDraft ? (
                  <div className="journalDraftPreview">
                    <div className="label">Draft preview</div>
                    <div className="journalDraftGrid">
                      <div className="journalDraftCell">
                        <div className="mono">Intentions</div>
                        <Markdown className="text md" text={journalDraft.intentions} />
                      </div>
                      <div className="journalDraftCell">
                        <div className="mono">Notes</div>
                        <Markdown className="text md" text={journalDraft.notes} />
                      </div>
                      <div className="journalDraftCell">
                        <div className="mono">Reflections</div>
                        <Markdown className="text md" text={journalDraft.reflections} />
                      </div>
                      <div className="journalDraftCell">
                        <div className="mono">Summary</div>
                        <Markdown className="text md" text={journalDraft.summary} />
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="block">
                <div className="sideTitle">Export range</div>
                <div className="row">
                  <label className="label">
                    Start
                    <input
                      className="input"
                      type="date"
                      value={journalExportStartDayKey}
                      onChange={(e) => setJournalExportStartDayKey(e.target.value)}
                    />
                  </label>
                </div>
                <div className="row">
                  <label className="label">
                    End
                    <input
                      className="input"
                      type="date"
                      value={journalExportEndDayKey}
                      onChange={(e) => setJournalExportEndDayKey(e.target.value)}
                    />
                  </label>
                </div>
                <div className="row">
                  <button
                    className="btn"
                    onClick={() => void onJournalExportRange(journalExportStartDayKey, journalExportEndDayKey)}
                  >
                    Export
                  </button>
                  <button className="btn" onClick={() => void onJournalCopyDay()}>
                    Copy day
                  </button>
                </div>
              </div>

              <div className="block">
                <div className="sideTitle">Settings</div>
                <div className="sideMeta">
                  Gemini key: {hasGeminiKey === null ? '...' : hasGeminiKey ? 'configured' : 'missing'}
                </div>
                <div className="row">
                  <button className="btn" onClick={() => setView('settings')}>
                    Open Settings
                  </button>
                </div>
              </div>

              {journalSaveLine ? (
                <div className="row">
                  <div className="mono">{journalSaveLine}</div>
                </div>
              ) : null}
            </div>
          ) : selectedCard ? (
            <div className="sidePanel">
              <div className="sideTitle">{selectedCard.title}</div>
              <div className="sideMeta">
                {formatClockAscii(selectedCard.startTs)} - {formatClockAscii(selectedCard.endTs)}
              </div>

              {selectedCardSiteList.length > 0 ? (
                <div className="block">
                  <div className="label">Sites</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
                    {selectedCardSiteList.map((s) => (
                      <span key={s} className="pill">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

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
                  {selectedCard.category === 'System' ? (
                    <option value="System">System</option>
                  ) : (
                    [...categoryNamesOrdered,
                      selectedCard.category &&
                      !categoryNamesOrdered.includes(selectedCard.category) &&
                      selectedCard.category !== 'System'
                        ? selectedCard.category
                        : null
                    ]
                      .filter(Boolean)
                      .map((cat) => (
                        <option key={String(cat)} value={String(cat)}>
                          {String(cat)}
                        </option>
                      ))
                  )}
                </select>
              </div>

              <div className="field">
                <div className="label">Subcategory</div>
                <input
                  className="input"
                  value={selectedCard.subcategory ?? ''}
                  disabled={selectedCard.category === 'System'}
                  list={selectedCard.category === 'System' ? undefined : 'chrona-subcategory-suggestions'}
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
                {selectedCard.category !== 'System' && subcategorySuggestionsForSelected.length > 0 ? (
                  <datalist id="chrona-subcategory-suggestions">
                    {subcategorySuggestionsForSelected.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                ) : null}
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

              <div className="block">
                <div className="label">
                  Observations
                  {selectedCardObservationsLoading ? ' (loading...)' : ` (${selectedCardObservations.length})`}
                </div>
                {selectedCardObservationsError ? (
                  <div className="mono error">Failed to load observations: {selectedCardObservationsError}</div>
                ) : null}
                {!selectedCardObservationsLoading && !selectedCardObservationsError &&
                selectedCardObservations.length === 0 ? (
                  <div className="sideMeta">No observations for this interval.</div>
                ) : null}
                {selectedCardObservations.length > 0 ? (
                  <div className="obsList">
                    {selectedCardObservations.map((o, idx) => (
                      <div key={`${o.startTs}:${o.endTs}:${idx}`} className="obsItem">
                        <div className="obsTime mono">
                          {formatClockAscii(o.startTs)} - {formatClockAscii(o.endTs)}
                        </div>
                        <div className="obsText">{o.observation}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="sidePanel">
              <div className="sideTitle">Quick capture</div>
              <div className="sideMeta">{statusLine}</div>

              <div className="row">
                <button className="btn btn-accent" onClick={onToggleRecording}>
                  {recording ? 'Stop recording' : 'Start recording'}
                </button>
                <button className="btn" onClick={() => setView('settings')}>
                  Settings
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

function getTimelineSearchScope(
  preset: 'day' | 'today' | 'yesterday' | 'last7' | 'last30' | 'all',
  selectedDayKey: string
): { startTs: number; endTs: number } {
  const nowDayKey = dayKeyFromUnixSeconds(Math.floor(Date.now() / 1000))

  if (preset === 'today') return dayWindowForDayKey(nowDayKey)
  if (preset === 'yesterday') return dayWindowForDayKey(addDaysToDayKey(nowDayKey, -1))

  if (preset === 'last7') {
    const endTs = dayWindowForDayKey(nowDayKey).endTs
    const startKey = addDaysToDayKey(nowDayKey, -6)
    const startTs = dayWindowForDayKey(startKey).startTs
    return { startTs, endTs }
  }

  if (preset === 'last30') {
    const endTs = dayWindowForDayKey(nowDayKey).endTs
    const startKey = addDaysToDayKey(nowDayKey, -29)
    const startTs = dayWindowForDayKey(startKey).startTs
    return { startTs, endTs }
  }

  if (preset === 'all') {
    const endTs = dayWindowForDayKey(nowDayKey).endTs
    return { startTs: 0, endTs }
  }

  return dayWindowForDayKey(selectedDayKey)
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

function applyTimelineClientFilters(
  cards: TimelineCardDTO[],
  queryRaw: string,
  filters: TimelineSearchFiltersDTO
): TimelineCardDTO[] {
  const q = String(queryRaw ?? '').trim().toLowerCase()
  const tokens = q ? q.split(/\s+/g).filter(Boolean) : []

  const includeSystem = filters.includeSystem ?? true
  const onlyErrors = !!filters.onlyErrors
  const hasVideo = !!filters.hasVideo
  const hasDetails = !!filters.hasDetails
  const categories = Array.isArray(filters.categories) ? filters.categories : []
  const catSet = new Set(categories)

  const out: TimelineCardDTO[] = []
  for (const c of cards) {
    if (onlyErrors) {
      if (c.category !== 'System') continue
      if (!(c.subcategory === 'Error' || c.title === 'Processing failed')) continue
    } else {
      if (!includeSystem && c.category === 'System') continue
      if (catSet.size > 0 && !catSet.has(c.category)) continue
    }

    if (hasVideo) {
      const v = String(c.videoSummaryUrl ?? '').trim()
      if (!v) continue
    }

    if (hasDetails) {
      const d = String(c.detailedSummary ?? '').trim()
      if (!d) continue
    }

    if (tokens.length > 0) {
      const hay = buildCardSearchHaystack(c)
      let ok = true
      for (const t of tokens) {
        if (!hay.includes(t)) {
          ok = false
          break
        }
      }
      if (!ok) continue
    }

    out.push(c)
  }

  out.sort((a, b) => a.startTs - b.startTs)
  return out
}

function buildCardSearchHaystack(c: TimelineCardDTO): string {
  const parts: string[] = []
  parts.push(String(c.title ?? ''))
  parts.push(String(c.summary ?? ''))
  parts.push(String(c.detailedSummary ?? ''))
  parts.push(String(c.category ?? ''))
  parts.push(String(c.subcategory ?? ''))

  const sites = parseAppSitesFromMetadata(c.metadata)
  if (sites.primary) parts.push(String(sites.primary))
  if (sites.secondary) parts.push(String(sites.secondary))

  return parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
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
