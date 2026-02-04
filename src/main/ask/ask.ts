import { dayKeyFromUnixSeconds } from '../../shared/time'
import type { AskRunRequest, AskRunResponse, AskSourceRef } from '../../shared/ask'
import type { Logger } from '../logger'
import type { StorageService } from '../storage/storage'
import { GeminiService } from '../gemini/gemini'
import { stripCodeFences } from '../gemini/cards'
import type { ReviewRating } from '../storage/storage'
import type { SettingsStore } from '../settings'

type TimelineCardLite = {
  id: number
  startTs: number
  endTs: number
  dayKey: string
  title: string
  summary: string | null
  detailedSummary: string | null
  category: string
  subcategory: string | null
}

export class AskService {
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

  async run(req: AskRunRequest): Promise<AskRunResponse> {
    const question = String(req.question ?? '').trim()
    if (!question) throw new Error('Question is required')
    if (question.length > 4000) throw new Error('Question is too long')

    const scopeStartTs = Math.floor(Number(req.scope?.startTs))
    const scopeEndTs = Math.floor(Number(req.scope?.endTs))
    if (!Number.isFinite(scopeStartTs) || !Number.isFinite(scopeEndTs)) {
      throw new Error('Invalid scope')
    }
    if (scopeEndTs <= scopeStartTs) throw new Error('Scope end must be > start')

    const options = req.options ?? {}
    const includeReview = options.includeReview ?? true
    const useObservations = options.useObservations ?? true

    const allCardsRaw = await this.storage.fetchCardsInRange({
      startTs: scopeStartTs,
      endTs: scopeEndTs,
      includeSystem: true
    })

    const allCards: TimelineCardLite[] = allCardsRaw
      .map((r: any) => mapCardRow(r))
      .filter((c) => c.endTs > c.startTs)
      .sort((a, b) => a.startTs - b.startTs)

    const selectedCards = selectCardsForPrompt(allCards, question)
    const cardsById = new Map<number, TimelineCardLite>()
    for (const c of allCards) cardsById.set(c.id, c)

    const aggregates = computeAggregates({ cards: allCards, scopeStartTs, scopeEndTs })

    const review = includeReview
      ? await this.storage.fetchReviewSegmentsInRange({ startTs: scopeStartTs, endTs: scopeEndTs })
      : []
    const reviewTotals = includeReview ? computeReviewTotals(scopeStartTs, scopeEndTs, review) : null

    const observations = useObservations
      ? await this.storage.fetchObservationsInRange({ startTs: scopeStartTs, endTs: scopeEndTs })
      : []

    const observationsForPrompt = useObservations
      ? sampleObservations(
          observations.map((o) => ({ startTs: o.startTs, endTs: o.endTs, observation: o.observation })),
          200
        )
      : []

    const callGroupId = `ask:${Date.now()}`

    const prompt = buildAskPrompt({
      question,
      scopeStartTs,
      scopeEndTs,
      cards: selectedCards,
      aggregates,
      reviewTotals,
      observations: observationsForPrompt,
      preamble: (await this.settings.getAll()).promptPreambleAsk
    })

    const rawText = await this.gemini.generateJsonOnly({
      operation: 'ask',
      callGroupId,
      prompt,
      batchId: null,
      mockJson: JSON.stringify({
        answerMarkdown:
          'Mock Ask Chrona response. Set a Gemini API key to enable real answers.\n\nScope is provided, but no model call was made.',
        sources: [],
        followUps: ['What did I spend the most time on?', 'How much time was Distraction?']
      })
    })

    const extracted = stripCodeFences(rawText)

    let parsed: { answerMarkdown: string; sourceCardIds: number[]; followUps: string[] }
    try {
      parsed = parseAskResponse({ jsonText: extracted })
      await this.storage.insertLLMCall({
        batchId: null,
        callGroupId,
        attempt: 1,
        provider: 'gemini',
        model: null,
        operation: 'ask_parse',
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
        operation: 'ask_parse',
        status: 'failure',
        errorDomain: 'parse',
        errorMessage: e instanceof Error ? e.message : String(e),
        responseBody: null
      })
      throw e
    }

    const sourcesDetailed: AskSourceRef[] = []
    for (const cardId of parsed.sourceCardIds) {
      const c = cardsById.get(cardId)
      if (!c) continue
      sourcesDetailed.push({
        type: 'card',
        cardId: c.id,
        dayKey: c.dayKey,
        startTs: c.startTs,
        endTs: c.endTs,
        title: c.title,
        category: c.category,
        subcategory: c.subcategory
      })
    }

    // De-dupe sources while preserving order.
    const seen = new Set<number>()
    const sources = sourcesDetailed.filter((s) => {
      if (seen.has(s.cardId)) return false
      seen.add(s.cardId)
      return true
    })

    return {
      answerMarkdown: parsed.answerMarkdown,
      sources,
      followUps: parsed.followUps
    }
  }
}

function mapCardRow(r: any): TimelineCardLite {
  const id = Number(r.id)
  const startTs = Number(r.start_ts)
  const endTs = Number(r.end_ts)
  return {
    id,
    startTs,
    endTs,
    dayKey: String(r.day ?? dayKeyFromUnixSeconds(startTs)),
    title: String(r.title ?? ''),
    summary: r.summary ?? null,
    detailedSummary: r.detailed_summary ?? null,
    category: String(r.category ?? ''),
    subcategory: r.subcategory ?? null
  }
}

function tokenizeQuestion(question: string): string[] {
  const q = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const stop = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'to',
    'of',
    'in',
    'on',
    'for',
    'with',
    'about',
    'did',
    'do',
    'i',
    'my',
    'me',
    'was',
    'were',
    'how',
    'what',
    'when',
    'where',
    'why',
    'show',
    'tell'
  ])

  const out: string[] = []
  for (const t of q) {
    if (t.length < 3) continue
    if (stop.has(t)) continue
    out.push(t)
    if (out.length >= 12) break
  }
  return out
}

function selectCardsForPrompt(cards: TimelineCardLite[], question: string): TimelineCardLite[] {
  const MAX = 200
  if (cards.length <= MAX) return cards

  const tokens = tokenizeQuestion(question)
  const tokenSet = new Set(tokens)

  const scored = cards.map((c) => {
    const dur = Math.max(0, c.endTs - c.startTs)
    let score = dur
    if (tokenSet.size > 0) {
      const hay = `${c.title} ${c.summary ?? ''} ${c.detailedSummary ?? ''}`.toLowerCase()
      for (const t of tokenSet) {
        if (hay.includes(t)) score += 10_000
      }
    }
    // Prefer non-system cards.
    if (c.category === 'System') score -= 2_000
    return { c, score }
  })

  scored.sort((a, b) => b.score - a.score)
  const picked: TimelineCardLite[] = []
  const seen = new Set<number>()

  // Top scored.
  for (const s of scored) {
    if (picked.length >= 150) break
    if (seen.has(s.c.id)) continue
    seen.add(s.c.id)
    picked.push(s.c)
  }

  // Add latest cards for recency coverage.
  const latest = [...cards].sort((a, b) => b.startTs - a.startTs)
  for (const c of latest) {
    if (picked.length >= MAX) break
    if (seen.has(c.id)) continue
    seen.add(c.id)
    picked.push(c)
  }

  picked.sort((a, b) => a.startTs - b.startTs)
  return picked.slice(0, MAX)
}

function computeAggregates(opts: { cards: TimelineCardLite[]; scopeStartTs: number; scopeEndTs: number }) {
  const byCategory: Record<string, number> = {}
  const byTitle: Record<string, number> = {}
  const bySubcategory: Record<string, number> = {}

  for (const c of opts.cards) {
    const dur = overlapSeconds(opts.scopeStartTs, opts.scopeEndTs, c.startTs, c.endTs)
    if (dur <= 0) continue

    byCategory[c.category] = (byCategory[c.category] ?? 0) + dur
    byTitle[c.title] = (byTitle[c.title] ?? 0) + dur
    if (c.subcategory) bySubcategory[c.subcategory] = (bySubcategory[c.subcategory] ?? 0) + dur
  }

  return {
    scopeStartTs: opts.scopeStartTs,
    scopeEndTs: opts.scopeEndTs,
    totalSeconds: Math.max(0, opts.scopeEndTs - opts.scopeStartTs),
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

function overlapSeconds(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart)
  const end = Math.min(aEnd, bEnd)
  return Math.max(0, end - start)
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

function buildAskPrompt(opts: {
  question: string
  scopeStartTs: number
  scopeEndTs: number
  cards: TimelineCardLite[]
  aggregates: any
  reviewTotals: any | null
  observations: Array<{ startTs: number; endTs: number; observation: string }>
  preamble?: string
}): string {
  return [
    'Return valid JSON only. Do not include Markdown code fences.',
    opts.preamble && opts.preamble.trim() ? `\nUser instructions:\n${opts.preamble.trim()}\n` : '',
    '',
    'You are Chrona. You answer questions about how the user spent time based on evidence provided below.',
    'You must stay grounded in the evidence. If the evidence is insufficient, say so and suggest what scope to change.',
    '',
    `Question: ${opts.question}`,
    `Scope (unix seconds): [${opts.scopeStartTs}, ${opts.scopeEndTs}]`,
    '',
    'Evidence:',
    '- timelineCards: items have {id,startTs,endTs,dayKey,title,category,subcategory,summary,detailedSummary}',
    '- aggregates: precomputed totals; use these for quantitative answers instead of doing your own math',
    '- reviewTotals: optional totals from review segments',
    '- observations: optional detailed descriptions; may be incomplete or sampled',
    '',
    'timelineCards JSON:',
    JSON.stringify(
      opts.cards.map((c) => ({
        id: c.id,
        startTs: c.startTs,
        endTs: c.endTs,
        dayKey: c.dayKey,
        title: c.title,
        category: c.category,
        subcategory: c.subcategory,
        summary: c.summary,
        detailedSummary: c.detailedSummary
      }))
    ),
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
    '{"answerMarkdown":"...","sources":[{"type":"card","cardId":123}],"followUps":["..."]}',
    '',
    'Rules:',
    '- sources must reference only cardId values present in timelineCards.',
    '- If you make a claim about a time period or activity, include at least one supporting source cardId.',
    '- Prefer concise bullets for summaries; use a table only if it helps.',
    '- Do not include any keys besides answerMarkdown, sources, followUps.'
  ].join('\n')
}

function parseAskResponse(opts: { jsonText: string }): {
  answerMarkdown: string
  sourceCardIds: number[]
  followUps: string[]
} {
  let parsed: any
  try {
    parsed = JSON.parse(opts.jsonText)
  } catch {
    throw new Error('Ask response was not valid JSON')
  }

  const answerMarkdown = typeof parsed?.answerMarkdown === 'string' ? parsed.answerMarkdown : null
  if (!answerMarkdown) throw new Error('Ask response missing answerMarkdown')

  const sourcesRaw = parsed?.sources
  const sourceCardIds: number[] = Array.isArray(sourcesRaw)
    ? sourcesRaw
        .map((s: any) => ({
          type: String(s?.type ?? 'card') === 'card' ? ('card' as const) : null,
          cardId: Number(s?.cardId)
        }))
        .filter((s: any) => s.type === 'card' && Number.isFinite(s.cardId) && s.cardId > 0)
        .map((s: any) => s.cardId)
    : []

  const followUpsRaw = parsed?.followUps
  const followUps: string[] = Array.isArray(followUpsRaw)
    ? followUpsRaw.map((x: any) => String(x ?? '').trim()).filter(Boolean).slice(0, 6)
    : []

  return { answerMarkdown: answerMarkdown.trim(), sourceCardIds, followUps }
}
