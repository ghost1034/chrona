import type { JournalDraftDTO } from '../../shared/journal'
import { dayWindowForDayKey } from '../../shared/time'
import type { Logger } from '../logger'
import { GeminiService } from '../gemini/gemini'
import type { StorageService } from '../storage/storage'
import type { ReviewRating } from '../storage/storage'
import type { SettingsStore } from '../settings'
import { buildJournalDraftSchema } from '../gemini/schemas'

export class JournalService {
  private readonly storage: StorageService
  private readonly log: Logger
  private readonly gemini: GeminiService
  private readonly settings: SettingsStore

  constructor(opts: { storage: StorageService; log: Logger; settings: SettingsStore }) {
    this.storage = opts.storage
    this.log = opts.log
    this.settings = opts.settings
    this.gemini = new GeminiService({ storage: opts.storage, log: opts.log, settings: opts.settings })
  }

  async draftWithGemini(opts: {
    dayKey: string
    options?: {
      includeObservations?: boolean
      includeReview?: boolean
    }
  }): Promise<JournalDraftDTO> {
    const dayKey = String(opts.dayKey ?? '').trim()
    if (!dayKey) throw new Error('dayKey is required')

    const win = dayWindowForDayKey(dayKey)
    const includeObservations = opts.options?.includeObservations ?? true
    const includeReview = opts.options?.includeReview ?? true

    const cardsRaw = await this.storage.fetchCardsInRange({
      startTs: win.startTs,
      endTs: win.endTs,
      includeSystem: false
    })

    const cards = (cardsRaw as any[])
      .map((c) => ({
        id: Number(c.id),
        startTs: Number(c.start_ts),
        endTs: Number(c.end_ts),
        title: String(c.title ?? ''),
        category: String(c.category ?? ''),
        subcategory: c.subcategory ?? null,
        summary: c.summary ?? null,
        detailedSummary: c.detailed_summary ?? null,
        metadata: c.metadata ?? null
      }))
      .filter((c) => Number.isFinite(c.id) && c.endTs > c.startTs)
      .sort((a, b) => a.startTs - b.startTs)

    const aggregates = computeAggregates({
      startTs: win.startTs,
      endTs: win.endTs,
      cards
    })

    const reviewSegments = includeReview
      ? await this.storage.fetchReviewSegmentsInRange({ startTs: win.startTs, endTs: win.endTs })
      : []
    const reviewTotals = includeReview
      ? computeReviewTotals(win.startTs, win.endTs, reviewSegments)
      : null

    const observations = includeObservations
      ? await this.storage.fetchObservationsInRange({ startTs: win.startTs, endTs: win.endTs })
      : []
    const observationsForPrompt = includeObservations
      ? sampleObservations(
          observations.map((o) => ({
            startTs: o.startTs,
            endTs: o.endTs,
            observation: o.observation
          })),
          160
        )
      : []

    const callGroupId = `journal:${dayKey}:${Date.now()}`
    const settings = await this.settings.getAll()
    const prompt = buildDraftPrompt({
      dayKey,
      windowStartTs: win.startTs,
      windowEndTs: win.endTs,
      cards,
      aggregates,
      reviewTotals,
      observations: observationsForPrompt,
      preamble: settings.promptPreambleJournalDraft
    })

    const rawText = await this.gemini.generateJsonOnly({
      operation: 'journal_draft',
      callGroupId,
      prompt,
      batchId: null,
      mockJson: JSON.stringify({
        intentions: 'Mock intentions: pick 1-2 priorities for the day.',
        notes: 'Mock notes: keep a few bullet notes about what happened.',
        reflections: 'Mock reflections: what went well, what to improve next time.',
        summary: 'Mock summary: a short recap of the day.'
      }),
      responseJsonSchema: buildJournalDraftSchema()
    })

    let parsed: JournalDraftDTO
    try {
      parsed = parseDraftJson({ jsonText: rawText })
      await this.storage.insertLLMCall({
        batchId: null,
        callGroupId,
        attempt: 1,
        provider: 'gemini',
        model: null,
        operation: 'journal_draft_parse',
        status: 'success',
        requestMethod: null,
        requestUrl: null,
        requestBody: null,
        responseBody: null
      })
    } catch (e) {
      await this.storage.insertLLMCall({
        batchId: null,
        callGroupId,
        attempt: 1,
        provider: 'gemini',
        model: null,
        operation: 'journal_draft_parse',
        status: 'failure',
        errorDomain: 'parse',
        errorMessage: e instanceof Error ? e.message : String(e),
        responseBody: null
      })
      throw e
    }

    this.log.info('journal.drafted', {
      dayKey,
      includeObservations,
      includeReview,
      cards: cards.length,
      observations: observationsForPrompt.length
    })

    return parsed
  }
}

function buildDraftPrompt(opts: {
  dayKey: string
  windowStartTs: number
  windowEndTs: number
  cards: any[]
  aggregates: any
  reviewTotals: any | null
  observations: Array<{ startTs: number; endTs: number; observation: string }>
  preamble?: string
}): string {
  return [
    'Return valid JSON only. Do not include Markdown code fences.',
    opts.preamble && opts.preamble.trim() ? `\nUser instructions:\n${opts.preamble.trim()}\n` : '',
    '',
    'You are writing a structured daily journal entry for the user.',
    'Stay grounded in the evidence provided. Do not invent meetings, people, or outcomes.',
    'If evidence is thin, keep sections short and say what is unknown.',
    '',
    `DayKey: ${opts.dayKey}`,
    `Window (unix seconds): [${opts.windowStartTs}, ${opts.windowEndTs}]`,
    '',
    'Evidence:',
    '- timelineCards: activities with titles/categories and optional summaries',
    '- aggregates: precomputed totals; use these for quantitative statements',
    '- reviewTotals: optional focus/neutral/distracted totals',
    '- observations: optional detailed descriptions; may be sampled and incomplete',
    '',
    'timelineCards JSON:',
    JSON.stringify(opts.cards),
    '',
    'aggregates JSON:',
    JSON.stringify(opts.aggregates),
    '',
    'reviewTotals JSON:',
    JSON.stringify(opts.reviewTotals),
    '',
    'observations JSON:',
    JSON.stringify(opts.observations),
    '',
    'Output format (JSON):',
    '{"intentions":"...","notes":"...","reflections":"...","summary":"..."}',
    '',
    'Writing guidance:',
    '- intentions: 1-4 bullets, forward-looking and realistic',
    '- notes: short bullets about what happened (avoid timecodes)',
    '- reflections: what went well / what was hard / one improvement',
    '- summary: 2-5 bullets or a short paragraph',
    '- Keep tone practical and concise; avoid therapy-speak.',
    '- Do not include any keys besides intentions, notes, reflections, summary.'
  ].join('\n')
}

function parseDraftJson(opts: { jsonText: string }): JournalDraftDTO {
  let parsed: any
  try {
    parsed = JSON.parse(opts.jsonText)
  } catch {
    throw new Error('Journal draft was not valid JSON')
  }

  const intentions = normalizeRequiredString(parsed?.intentions)
  const notes = normalizeRequiredString(parsed?.notes)
  const reflections = normalizeRequiredString(parsed?.reflections)
  const summary = normalizeRequiredString(parsed?.summary)

  return {
    intentions: clampText(intentions, 8000),
    notes: clampText(notes, 8000),
    reflections: clampText(reflections, 8000),
    summary: clampText(summary, 8000)
  }
}

function normalizeRequiredString(v: unknown): string {
  if (typeof v !== 'string') throw new Error('Journal draft missing required string fields')
  const s = v.replace(/\r\n/g, '\n').trim()
  return s
}

function clampText(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max)
}

function sampleObservations(
  observations: Array<{ startTs: number; endTs: number; observation: string }>,
  max: number
) {
  if (observations.length <= max) return observations
  const out: Array<{ startTs: number; endTs: number; observation: string }> = []
  const step = observations.length / max
  for (let i = 0; i < max; i++) {
    const idx = Math.min(observations.length - 1, Math.floor(i * step))
    out.push(observations[idx])
  }
  return out
}

function overlapSeconds(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart)
  const end = Math.min(aEnd, bEnd)
  return Math.max(0, end - start)
}

function computeAggregates(opts: {
  startTs: number
  endTs: number
  cards: Array<{ startTs: number; endTs: number; category: string; title: string; subcategory: any }>
}) {
  const byCategory: Record<string, number> = {}
  const byTitle: Record<string, number> = {}
  const bySubcategory: Record<string, number> = {}

  for (const c of opts.cards) {
    const dur = overlapSeconds(opts.startTs, opts.endTs, c.startTs, c.endTs)
    if (dur <= 0) continue

    byCategory[c.category] = (byCategory[c.category] ?? 0) + dur
    byTitle[c.title] = (byTitle[c.title] ?? 0) + dur
    if (c.subcategory) bySubcategory[String(c.subcategory)] = (bySubcategory[String(c.subcategory)] ?? 0) + dur
  }

  return {
    windowStartTs: opts.startTs,
    windowEndTs: opts.endTs,
    totalSeconds: Math.max(0, opts.endTs - opts.startTs),
    byCategorySeconds: sortTop(byCategory, 20),
    byTitleSeconds: sortTop(byTitle, 30),
    bySubcategorySeconds: sortTop(bySubcategory, 30)
  }
}

function sortTop(obj: Record<string, number>, max: number) {
  return Object.entries(obj)
    .filter(([, v]) => Number.isFinite(v) && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k, v]) => ({ key: k, seconds: Math.floor(v) }))
}

function computeReviewTotals(
  scopeStartTs: number,
  scopeEndTs: number,
  segments: Array<{ startTs: number; endTs: number; rating: ReviewRating }>
) {
  const totals: Record<ReviewRating, number> = {
    focus: 0,
    neutral: 0,
    distracted: 0
  }

  for (const s of segments) {
    const dur = overlapSeconds(scopeStartTs, scopeEndTs, s.startTs, s.endTs)
    if (dur <= 0) continue
    totals[s.rating] += dur
  }

  return {
    focusSeconds: Math.floor(totals.focus),
    neutralSeconds: Math.floor(totals.neutral),
    distractedSeconds: Math.floor(totals.distracted)
  }
}
