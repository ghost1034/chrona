import { ipcMain } from 'electron'
import type { IpcContract } from '../shared/ipc'
import { SettingsStore } from './settings'
import type { CaptureService } from './capture/capture'
import type { StorageService } from './storage/storage'
import { shell } from 'electron'
import type { AnalysisService } from './analysis/analysis'
import { getGeminiApiKey, setGeminiApiKey } from './gemini/keychain'
import { clipboard, dialog } from 'electron'
import { formatDayForClipboard, formatRangeMarkdown } from '../shared/export'
import { dayKeyFromUnixSeconds } from '../shared/time'
import { dayWindowForDayKey } from '../shared/time'
import { coverageByCardId } from '../shared/review'
import type { RetentionService } from './retention/retention'
import { pathToFileURL } from 'node:url'

type Handler<K extends keyof IpcContract> = (
  req: IpcContract[K]['req']
) => Promise<IpcContract[K]['res']> | IpcContract[K]['res']

export function registerIpc(opts: {
  settings: SettingsStore
  capture: CaptureService
  storage: StorageService
  analysis: AnalysisService
  retention: RetentionService
}) {
  handle('app:ping', async () => ({ ok: true, nowTs: Math.floor(Date.now() / 1000) }))
  handle('settings:getAll', async () => opts.settings.getAll())
  handle('settings:update', async (patch) => opts.settings.update(patch ?? {}))

  handle('capture:getState', async () => opts.capture.getState())
  handle('capture:setEnabled', async (req) => opts.capture.setEnabled(req.enabled))
  handle('capture:setInterval', async (req) => opts.capture.setIntervalSeconds(req.intervalSeconds))
  handle('capture:setSelectedDisplay', async (req) => opts.capture.setSelectedDisplay(req.displayId))
  handle('capture:listDisplays', async () => opts.capture.listDisplays())

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
    return { ok: true }
  })
  handle('gemini:hasApiKey', async () => {
    const k = await getGeminiApiKey()
    return { hasApiKey: !!k }
  })

  handle('timeline:getDay', async (req) => {
    const cards = await opts.storage.fetchCardsForDay(req.dayKey)
    return {
      dayKey: req.dayKey,
      cards: cards.map(mapCardRow)
    }
  })

  handle('timeline:updateCardCategory', async (req) => {
    await opts.storage.updateCardCategory({
      cardId: req.cardId,
      category: req.category,
      subcategory: req.subcategory ?? null
    })
    return { ok: true }
  })

  handle('timeline:copyDayToClipboard', async (req) => {
    const cards = (await opts.storage.fetchCardsForDay(req.dayKey)).map(mapCardRow)
    const text = formatDayForClipboard({ dayKey: req.dayKey, cards })
    clipboard.writeText(text)
    return { ok: true }
  })

  handle('timeline:saveMarkdownRange', async (req) => {
    const days = await loadDayRange(opts.storage, req.startDayKey, req.endDayKey)
    const markdown = formatRangeMarkdown({
      startDayKey: req.startDayKey,
      endDayKey: req.endDayKey,
      days
    })

    const defaultName = `dayflow-${req.startDayKey}_to_${req.endDayKey}.md`
    const res = await dialog.showSaveDialog({
      title: 'Export timeline as Markdown',
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return { ok: true, filePath: null }
    await import('node:fs/promises').then((fs) => fs.writeFile(res.filePath!, markdown, 'utf8'))
    return { ok: true, filePath: res.filePath }
  })

  handle('review:getDay', async (req) => {
    const cards = (await opts.storage.fetchCardsForDay(req.dayKey)).map(mapCardRow)
    const win = dayWindowForDayKey(req.dayKey)
    const segments = await opts.storage.fetchReviewSegmentsInRange({
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
    return { fileUrl: pathToFileURL(abs).toString() }
  })
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

async function loadDayRange(storage: StorageService, startDayKey: string, endDayKey: string) {
  const start = parseDayKey(startDayKey)
  const end = parseDayKey(endDayKey)
  if (!start || !end) throw new Error('Invalid dayKey')
  if (start.getTime() > end.getTime()) throw new Error('startDayKey must be <= endDayKey')

  const days: Array<{ dayKey: string; cards: any[] }> = []
  const d = new Date(start)
  while (d.getTime() <= end.getTime()) {
    const dayKey = dayKeyFromUnixSeconds(Math.floor(d.getTime() / 1000) + 4 * 60 * 60)
    const cards = (await storage.fetchCardsForDay(dayKey)).map(mapCardRow)
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
