import { ipcMain } from 'electron'
import type { IpcContract } from '../shared/ipc'
import { SettingsStore } from './settings'
import type { CaptureService } from './capture/capture'
import type { StorageService } from './storage/storage'
import { app, shell } from 'electron'
import type { AnalysisService } from './analysis/analysis'
import { getGeminiApiKey, setGeminiApiKey } from './gemini/keychain'
import { AIService } from './ai/ai'
import { clearLocalBearerToken, getLocalBearerToken, setLocalBearerToken } from './ai/localKeychain'
import { clipboard, dialog } from 'electron'
import {
  formatDayForClipboard,
  formatJournalDayForClipboard,
  formatJournalRangeMarkdown,
  formatRangeMarkdown
} from '../shared/export'
import { dayKeyFromUnixSeconds } from '../shared/time'
import { dayWindowForDayKey } from '../shared/time'
import { coverageByCardId } from '../shared/review'
import {
  buildTimelineExportRowsForDay,
  formatLocalDateTimeAscii,
  formatTimelineRowsCsv
} from '../shared/timelineExport'
import type { RetentionService } from './retention/retention'
import { toChronaMediaUrl } from './mediaProtocol'
import { applyAutoStart } from './autostart'
import type { Logger } from './logger'
import type { AskService } from './ask/ask'
import type { DashboardService } from './dashboard/dashboard'
import type { JournalService } from './journal/journal'
import { buildTimelineXlsxBuffer } from './export/timelineXlsx'
import type { CategoriesService } from './categories/categories'
import type { SyncService } from './sync/sync'
import type { BlurService } from './blur/blur'
import { applyDemoCardVisibility, effectiveNowTs } from '../shared/demo'
import { computeDashboardStats } from '../shared/stats'

type Handler<K extends keyof IpcContract> = (
  req: IpcContract[K]['req']
) => Promise<IpcContract[K]['res']> | IpcContract[K]['res']

export function registerIpc(opts: {
  settings: SettingsStore
  capture: CaptureService
  storage: StorageService
  analysis: AnalysisService
  retention: RetentionService
  ask: AskService
  dashboard: DashboardService
  journal: JournalService
  categories: CategoriesService
  sync: SyncService
  blur: BlurService
  log: Logger
}) {
  const ai = new AIService({ storage: opts.storage, log: opts.log, settings: opts.settings })

  handle('app:ping', async () => {
    const settings = await opts.settings.getAll()
    return {
      ok: true,
      nowTs: effectiveNowTs(Math.floor(Date.now() / 1000), settings.demoTimeOffsetSeconds)
    }
  })

  handle('app:getAutoStart', async () => {
    const s = await opts.settings.getAll()
    return { enabled: !!s.autoStartEnabled }
  })

  handle('app:setAutoStart', async (req) => {
    const enabled = !!req.enabled
    await opts.settings.update({ autoStartEnabled: enabled })
    applyAutoStart(enabled, opts.log)
    // Use Electron's actual state if available.
    try {
      const st = app.getLoginItemSettings()
      return { enabled: st.openAtLogin }
    } catch {
      return { enabled }
    }
  })

  handle('app:openGeminiKeyPage', async () => {
    await shell.openExternal('https://aistudio.google.com/app/apikey')
    return { ok: true }
  })

  handle('app:openMacScreenRecordingSettings', async () => {
    if (process.platform !== 'darwin') return { ok: true }

    // Best-effort. The exact deep link has changed across macOS versions.
    const urls = [
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenRecording'
    ]

    for (const u of urls) {
      try {
        await shell.openExternal(u)
        break
      } catch {
        // try next
      }
    }

    return { ok: true }
  })

  handle('app:relaunch', async () => {
    app.relaunch()
    app.exit(0)
    return { ok: true }
  })

  handle('setup:getStatus', async () => {
    const k = await getGeminiApiKey()
    const localToken = await getLocalBearerToken()
    const providerStatus = await ai.getProviderStatus()
    const captureAccess =
      process.platform === 'darwin'
        ? await opts.capture.probeAccess()
        : { status: 'not_applicable' as const, message: null }
    return {
      platform: process.platform,
      hasGeminiKey: !!k,
      hasLocalToken: !!localToken,
      aiProvider: providerStatus.provider,
      aiConfigured: providerStatus.configured,
      captureAccess
    }
  })
  handle('settings:getAll', async () => opts.settings.getAll())
  handle('settings:update', async (patch) => {
    const next = await opts.settings.update(patch ?? {})

    // Only reschedule analysis loop when interval changes.
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'analysisCheckIntervalSeconds')) {
      opts.analysis.rescheduleFromSettings()
    }

    if (patch && Object.prototype.hasOwnProperty.call(patch, 'syncIntervalSeconds')) {
      opts.sync.rescheduleFromSettings()
    }

    if (
      patch &&
      ['aiProvider', 'localBaseUrl', 'localVisionModel', 'localTextModel'].some((key) =>
        Object.prototype.hasOwnProperty.call(patch, key)
      )
    ) {
      opts.analysis.retryPendingFromSettings()
    }

    return next
  })

  handle('categories:getAll', async () => opts.categories.getAll())

  handle('categories:create', async (req) => {
    const category = await opts.categories.createCategory({
      name: req.name,
      color: req.color,
      description: req.description
    })
    return { category }
  })

  handle('categories:update', async (req) => {
    const category = await opts.categories.updateCategory({ id: req.id, patch: req.patch ?? {} })
    return { category }
  })

  handle('categories:delete', async (req) => {
    await opts.categories.deleteCategory({ id: req.id, reassignToCategoryId: req.reassignToCategoryId })
    return { ok: true }
  })

  handle('subcategories:create', async (req) => {
    const subcategory = await opts.categories.createSubcategory({
      categoryId: req.categoryId,
      name: req.name,
      color: req.color,
      description: req.description
    })
    return { subcategory }
  })

  handle('subcategories:update', async (req) => {
    const subcategory = await opts.categories.updateSubcategory({ id: req.id, patch: req.patch ?? {} })
    return { subcategory }
  })

  handle('subcategories:delete', async (req) => {
    await opts.categories.deleteSubcategory(req as any)
    return { ok: true }
  })

  handle('capture:getState', async () => opts.capture.getState())
  handle('capture:setEnabled', async (req) => opts.capture.setEnabled(req.enabled))
  handle('capture:setInterval', async (req) => opts.capture.setIntervalSeconds(req.intervalSeconds))
  handle('capture:setSelectedDisplay', async (req) => opts.capture.setSelectedDisplay(req.displayId))
  handle('capture:listDisplays', async () => opts.capture.listDisplays())
  handle('capture:probeAccess', async () => opts.capture.probeAccess())

  handle('debug:openRecordingsFolder', async () => {
    const p = opts.storage.resolveRelPath('recordings')
    await shell.openPath(p)
    return { ok: true }
  })

  // Phase 5 debug helpers
  handle('analysis:runTick', async () => opts.analysis.runTickNow())
  handle('analysis:getRecentBatches', async (req) =>
    opts.storage.fetchRecentBatches(req?.limit ?? 25)
  )

  handle('gemini:setApiKey', async (req) => {
    await setGeminiApiKey(req.apiKey)
    opts.analysis.retryPendingFromSettings()
    return { ok: true }
  })
  handle('gemini:hasApiKey', async () => {
    const k = await getGeminiApiKey()
    return { hasApiKey: !!k }
  })

  handle('gemini:testApiKey', async (req) => {
    const res = await ai.gemini.testApiKey({ apiKeyOverride: req.apiKey ?? null })
    return res
  })

  handle('ai:getProviderStatus', async () => ai.getProviderStatus())
  handle('local:setToken', async (req) => {
    await setLocalBearerToken(req.token)
    opts.analysis.retryPendingFromSettings()
    return { ok: true }
  })
  handle('local:clearToken', async () => {
    await clearLocalBearerToken()
    opts.analysis.retryPendingFromSettings()
    return { ok: true }
  })
  handle('local:discoverModels', async (req) => ({
    models: await ai.local.discoverModels({ baseUrl: req.baseUrl, token: req.token })
  }))
  handle('local:testConnection', async (req) => ai.local.testConnection(req))

  handle('timeline:getDay', async (req) => {
    const settings = await opts.settings.getAll()
    const cards = applyDemoCardVisibility(
      await opts.storage.fetchCardsForDay(req.dayKey),
      settings.demoCardsHidden
    )
    return {
      dayKey: req.dayKey,
      cards: cards.map(mapCardRow)
    }
  })

  handle('timeline:getCardObservations', async (req) => {
    const cardId = Math.floor(Number(req.cardId))
    if (!Number.isFinite(cardId) || cardId <= 0) throw new Error('Invalid cardId')
    if ((await opts.settings.getAll()).demoCardsHidden) {
      return { cardId, observations: [] }
    }

    const card = await opts.storage.fetchTimelineCardById(cardId)
    if (!card) return { cardId, observations: [] }

    const observations = await opts.storage.fetchObservationsInRange({
      startTs: card.startTs,
      endTs: card.endTs
    })

    return {
      cardId,
      observations: observations.map((o) => ({
        startTs: o.startTs,
        endTs: o.endTs,
        observation: o.observation,
        metadata: o.metadata ?? null,
        llmModel: o.llmModel ?? null
      }))
    }
  })

  handle('timeline:search', async (req) => {
    if ((await opts.settings.getAll()).demoCardsHidden) {
      return {
        hits: [],
        limit: Math.max(1, Math.floor(Number(req.limit)) || 50),
        offset: Math.max(0, Math.floor(Number(req.offset)) || 0),
        hasMore: false
      }
    }
    const res = await opts.storage.searchTimelineCards(req)
    return {
      hits: res.hits.map((h) => ({
        card: mapCardRow(h.cardRow),
        rank: h.rank ?? null,
        snippet: h.snippet ?? null
      })),
      limit: res.limit,
      offset: res.offset,
      hasMore: res.hasMore
    }
  })

  handle('timeline:updateCardCategory', async (req) => {
    await opts.storage.updateCardCategory({
      cardId: req.cardId,
      category: req.category,
      subcategory: req.subcategory ?? null
    })
    // In-place edits don't bump any timestamp on timeline_cards — tell the
    // sync engine directly so the change syncs without waiting an hour.
    opts.sync.notifyCardEdited(req.cardId)
    return { ok: true }
  })

  handle('timeline:copyDayToClipboard', async (req) => {
    const settings = await opts.settings.getAll()
    const cards = applyDemoCardVisibility(
      (await opts.storage.fetchCardsForDay(req.dayKey)).map(mapCardRow),
      settings.demoCardsHidden
    )
    const text = formatDayForClipboard({ dayKey: req.dayKey, cards })
    clipboard.writeText(text)
    return { ok: true }
  })

  handle('timeline:saveMarkdownRange', async (req) => {
    const hidden = (await opts.settings.getAll()).demoCardsHidden
    const days = await loadDayRange(opts.storage, req.startDayKey, req.endDayKey, hidden)
    const markdown = formatRangeMarkdown({
      startDayKey: req.startDayKey,
      endDayKey: req.endDayKey,
      days
    })

    const defaultName = `chrona-${req.startDayKey}_to_${req.endDayKey}.md`
    const res = await dialog.showSaveDialog({
      title: 'Export timeline as Markdown',
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return { ok: true, filePath: null }
    await import('node:fs/promises').then((fs) => fs.writeFile(res.filePath!, markdown, 'utf8'))
    return { ok: true, filePath: res.filePath }
  })

  handle('timeline:saveCsvRange', async (req) => {
    const hidden = (await opts.settings.getAll()).demoCardsHidden
    const days = await loadDayRange(opts.storage, req.startDayKey, req.endDayKey, hidden)
    const includeReviewCoverage = !!req.options?.includeReviewCoverage

    const rows = [] as ReturnType<typeof buildTimelineExportRowsForDay>
    for (const d of days) {
      let coverage: Record<number, number> | null = null
      if (includeReviewCoverage) {
        const win = dayWindowForDayKey(d.dayKey)
        const segments = await opts.storage.fetchReviewSegmentsInRange({
          startTs: win.startTs,
          endTs: win.endTs
        })
        coverage = coverageByCardId({ cards: d.cards as any, segments, ignoreSystem: true })
      }

      rows.push(
        ...buildTimelineExportRowsForDay({
          dayKey: d.dayKey,
          cards: d.cards as any,
          options: req.options,
          coverageByCardId: coverage
        })
      )
    }

    const csv = formatTimelineRowsCsv({ rows })
    const defaultName = `chrona-timeline-${req.startDayKey}_to_${req.endDayKey}.csv`
    const res = await dialog.showSaveDialog({
      title: 'Export timeline as CSV',
      defaultPath: defaultName,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return { ok: true, filePath: null }
    await import('node:fs/promises').then((fs) => fs.writeFile(res.filePath!, csv, 'utf8'))
    return { ok: true, filePath: res.filePath }
  })

  handle('timeline:saveXlsxRange', async (req) => {
    const settings = await opts.settings.getAll()
    const days = await loadDayRange(
      opts.storage,
      req.startDayKey,
      req.endDayKey,
      settings.demoCardsHidden
    )
    const includeReviewCoverage = !!req.options?.includeReviewCoverage

    const rows = [] as ReturnType<typeof buildTimelineExportRowsForDay>
    for (const d of days) {
      let coverage: Record<number, number> | null = null
      if (includeReviewCoverage) {
        const win = dayWindowForDayKey(d.dayKey)
        const segments = await opts.storage.fetchReviewSegmentsInRange({
          startTs: win.startTs,
          endTs: win.endTs
        })
        coverage = coverageByCardId({ cards: d.cards as any, segments, ignoreSystem: true })
      }

      rows.push(
        ...buildTimelineExportRowsForDay({
          dayKey: d.dayKey,
          cards: d.cards as any,
          options: req.options,
          coverageByCardId: coverage
        })
      )
    }

    let tz = 'local'
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
    } catch {
      // ignore
    }
    const generatedAtLocal = formatLocalDateTimeAscii(
      effectiveNowTs(Math.floor(Date.now() / 1000), settings.demoTimeOffsetSeconds)
    )

    const buf = await buildTimelineXlsxBuffer({
      rows,
      meta: {
        startDayKey: req.startDayKey,
        endDayKey: req.endDayKey,
        generatedAtLocal,
        timezone: tz
      }
    })

    const defaultName = `chrona-timeline-${req.startDayKey}_to_${req.endDayKey}.xlsx`
    const res = await dialog.showSaveDialog({
      title: 'Export timeline as Excel',
      defaultPath: defaultName,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    })
    if (res.canceled || !res.filePath) return { ok: true, filePath: null }
    await import('node:fs/promises').then((fs) => fs.writeFile(res.filePath!, buf))
    return { ok: true, filePath: res.filePath }
  })

  handle('journal:getDay', async (req) => {
    const entry = await opts.storage.getJournalEntry(req.dayKey)
    return { dayKey: req.dayKey, entry }
  })

  handle('journal:upsert', async (req) => {
    const entry = await opts.storage.upsertJournalEntry({ dayKey: req.dayKey, patch: req.patch ?? {} })
    return { entry }
  })

  handle('journal:delete', async (req) => {
    await opts.storage.deleteJournalEntry(req.dayKey)
    return { ok: true }
  })

  handle('journal:draftWithAI', async (req) => {
    const draft = await opts.journal.draftWithAI({ dayKey: req.dayKey, options: req.options })
    return { draft }
  })

  handle('journal:copyDayToClipboard', async (req) => {
    const entry = await opts.storage.getJournalEntry(req.dayKey)
    const text = formatJournalDayForClipboard({ dayKey: req.dayKey, entry })
    clipboard.writeText(text)
    return { ok: true }
  })

  handle('journal:saveMarkdownRange', async (req) => {
    const entries = await opts.storage.listJournalEntriesInRange({
      startDayKey: req.startDayKey,
      endDayKey: req.endDayKey
    })
    const markdown = formatJournalRangeMarkdown({
      startDayKey: req.startDayKey,
      endDayKey: req.endDayKey,
      entries
    })

    const defaultName = `chrona-journal-${req.startDayKey}_to_${req.endDayKey}.md`
    const res = await dialog.showSaveDialog({
      title: 'Export journal as Markdown',
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return { ok: true, filePath: null }
    await import('node:fs/promises').then((fs) => fs.writeFile(res.filePath!, markdown, 'utf8'))
    return { ok: true, filePath: res.filePath }
  })

  handle('review:getDay', async (req) => {
    const hidden = (await opts.settings.getAll()).demoCardsHidden
    const cards = applyDemoCardVisibility(
      (await opts.storage.fetchCardsForDay(req.dayKey)).map(mapCardRow),
      hidden
    )
    const win = dayWindowForDayKey(req.dayKey)
    const segments = hidden
      ? []
      : await opts.storage.fetchReviewSegmentsInRange({
          startTs: win.startTs,
          endTs: win.endTs
        })
    const coverage = coverageByCardId({ cards, segments, ignoreSystem: true })

    return {
      dayKey: req.dayKey,
      segments,
      coverageByCardId: coverage
    }
  })

  handle('review:applyRating', async (req) => {
    await opts.storage.applyReviewRatingSegment({
      startTs: req.startTs,
      endTs: req.endTs,
      rating: req.rating
    })
    return { ok: true }
  })

  handle('storage:getUsage', async () => opts.retention.getUsage())
  handle('storage:purgeNow', async () => {
    const res = await opts.retention.purgeNow()
    const usage = await opts.retention.getUsage()
    return {
      ok: true,
      deletedScreenshotCount: res.deletedScreenshotCount,
      deletedTimelapseCount: res.deletedTimelapseCount,
      freedRecordingsBytes: res.freedRecordingsBytes,
      freedTimelapsesBytes: res.freedTimelapsesBytes,
      recordingsBytes: usage.recordingsBytes,
      timelapsesBytes: usage.timelapsesBytes
    }
  })

  handle('storage:resolveFileUrl', async (req) => {
    const path = await import('node:path')
    const userData = opts.storage.getUserDataPath()
    const abs = path.resolve(userData, req.relPath)
    const rel = path.relative(userData, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Invalid relPath')
    }
    // Avoid returning file:// URLs to the renderer. Chromium blocks http(s) -> file:// loads
    // (common during dev when using Vite), which breaks <video> playback.
    return { fileUrl: toChronaMediaUrl(rel) }
  })

  handle('ask:run', async (req) => {
    if ((await opts.settings.getAll()).demoCardsHidden) {
      return {
        answerMarkdown: 'No timeline cards were found in the selected scope.',
        sources: [],
        followUps: []
      }
    }
    return opts.ask.run(req)
  })

  handle('dashboard:get', async (req) => {
    const startTs = Math.floor(Number(req.scope?.startTs))
    const endTs = Math.floor(Number(req.scope?.endTs))
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
      throw new Error('Invalid dashboard scope')
    }

    if ((await opts.settings.getAll()).demoCardsHidden) {
      return computeDashboardStats({
        scopeStartTs: startTs,
        scopeEndTs: endTs,
        cards: [],
        reviewSegments: [],
        includeSystem: !!req.options?.includeSystem
      })
    }

    return opts.dashboard.getStats({
      scopeStartTs: startTs,
      scopeEndTs: endTs,
      includeSystem: !!req.options?.includeSystem
    })
  })

  handle('sync:getStatus', async () => opts.sync.getStatus())
  handle('sync:pair', async (req) =>
    opts.sync.pair({ code: req.code, endpoint: req.endpoint })
  )
  handle('sync:unpair', async () => opts.sync.unpair())
  handle('sync:runNow', async () => opts.sync.runNow())
  handle('sync:setEnabled', async (req) => opts.sync.setEnabled(!!req.enabled))

  handle('blur:listRegions', async () => ({ regions: await opts.blur.listRegions() }))
  handle('blur:addRegion', async (req) => ({ region: await opts.blur.addRegion(req) }))
  handle('blur:removeRegion', async (req) => {
    await opts.blur.removeRegion(req.id)
    return { ok: true }
  })
  handle('blur:openOverlay', async () => {
    await opts.blur.openOverlays()
    return { ok: true }
  })
  handle('blur:closeOverlay', async () => {
    opts.blur.closeOverlays()
    return { ok: true }
  })
  handle('blur:setHotkey', async (req) => opts.blur.setHotkey(req.accelerator))
}

function mapCardRow(r: any) {
  return {
    id: Number(r.id),
    batchId: r.batch_id === null || r.batch_id === undefined ? null : Number(r.batch_id),
    startTs: Number(r.start_ts),
    endTs: Number(r.end_ts),
    dayKey: String(r.day),
    title: String(r.title),
    summary: r.summary ?? null,
    detailedSummary: r.detailed_summary ?? null,
    category: String(r.category),
    subcategory: r.subcategory ?? null,
    metadata: r.metadata ?? null,
    videoSummaryUrl: r.video_summary_url ?? null
  }
}

async function loadDayRange(
  storage: StorageService,
  startDayKey: string,
  endDayKey: string,
  cardsHidden = false
) {
  const start = parseDayKey(startDayKey)
  const end = parseDayKey(endDayKey)
  if (!start || !end) throw new Error('Invalid dayKey')
  if (start.getTime() > end.getTime()) throw new Error('startDayKey must be <= endDayKey')

  const days: Array<{ dayKey: string; cards: any[] }> = []
  const d = new Date(start)
  while (d.getTime() <= end.getTime()) {
    const dayKey = dayKeyFromUnixSeconds(Math.floor(d.getTime() / 1000) + 4 * 60 * 60)
    const cards = applyDemoCardVisibility(
      (await storage.fetchCardsForDay(dayKey)).map(mapCardRow),
      cardsHidden
    )
    days.push({ dayKey, cards })
    d.setDate(d.getDate() + 1)
  }
  return days
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

function handle<K extends keyof IpcContract>(channel: K, fn: Handler<K>) {
  ipcMain.handle(channel, async (_event, req: IpcContract[K]['req']) => fn(req))
}
