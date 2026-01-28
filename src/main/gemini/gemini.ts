import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getGeminiApiKey } from './keychain'
import type { Logger } from '../logger'
import type { StorageService } from '../storage/storage'
import { buildCompressedTimelineVideo } from './video'
import { parseAndExpandTranscriptionJson } from './transcription'
import { parseAndValidateCardsJson, stripCodeFences } from './cards'

export type GeminiConfig = {
  model: string
  requestTimeoutMs: number
  maxAttempts: number
  logBodies: boolean
}

export class GeminiService {
  private readonly storage: StorageService
  private readonly log: Logger
  private readonly cfg: GeminiConfig

  constructor(opts: { storage: StorageService; log: Logger; cfg?: Partial<GeminiConfig> }) {
    this.storage = opts.storage
    this.log = opts.log
    this.cfg = {
      model: 'gemini-1.5-flash',
      requestTimeoutMs: 60_000,
      maxAttempts: 3,
      logBodies: false,
      ...opts.cfg
    }
  }

  async transcribeBatch(opts: {
    batchId: number
    batchStartTs: number
    batchEndTs: number
    screenshotRelPaths: string[]
    screenshotIntervalSeconds: number
  }): Promise<{ observationsInserted: number }>{
    const apiKey = await getGeminiApiKey()
    if (!apiKey && !process.env.DAYFLOW_GEMINI_MOCK) {
      throw new Error('Missing Gemini API key (set DAYFLOW_GEMINI_API_KEY or store via keychain)')
    }

    if (process.env.DAYFLOW_GEMINI_MOCK) {
      const mockJson = JSON.stringify({
        observations: [
          {
            start: '00:00',
            end: '00:06',
            observation: 'Mock transcription: user is working in apps on screen.'
          }
        ]
      })

      const parsed = parseAndExpandTranscriptionJson({
        jsonText: mockJson,
        batchStartTs: opts.batchStartTs,
        batchEndTs: opts.batchEndTs,
        screenshotIntervalSeconds: opts.screenshotIntervalSeconds,
        llmModel: 'mock'
      })

      await this.storage.insertObservations(opts.batchId, parsed.observations)
      return { observationsInserted: parsed.observations.length }
    }

    const absJpegs = opts.screenshotRelPaths.map((p) => this.storage.resolveRelPath(p))
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dayflow-gemini-'))
    const videoPath = path.join(tmpDir, `batch-${opts.batchId}.mp4`)

    try {
      await buildCompressedTimelineVideo({
        inputJpegPaths: absJpegs,
        outMp4Path: videoPath,
        targetHeight: 540
      })

      const videoBytes = await fs.readFile(videoPath)
      const videoBase64 = videoBytes.toString('base64')
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.cfg.model}:generateContent?key=${encodeURIComponent(
        apiKey!
      )}`

      const prompt = buildTranscriptionPrompt({
        screenshotIntervalSeconds: opts.screenshotIntervalSeconds
      })

      const requestBody = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: 'video/mp4',
                  data: videoBase64
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1
        }
      }

      const callGroupId = `batch:${opts.batchId}:transcribe:${Date.now()}`

      const { text, latencyMs, httpStatus } = await this.fetchWithRetry({
        url,
        method: 'POST',
        body: JSON.stringify(requestBody),
        callGroupId,
        batchId: opts.batchId,
        model: this.cfg.model,
        operation: 'transcribe'
      })

      const extracted = extractGeminiText(text)
      const parsed = parseAndExpandTranscriptionJson({
        jsonText: stripCodeFences(extracted),
        batchStartTs: opts.batchStartTs,
        batchEndTs: opts.batchEndTs,
        screenshotIntervalSeconds: opts.screenshotIntervalSeconds,
        llmModel: this.cfg.model
      })

      await this.storage.insertObservations(opts.batchId, parsed.observations)

      await this.storage.insertLLMCall({
        batchId: opts.batchId,
        callGroupId,
        attempt: 1,
        provider: 'gemini',
        model: this.cfg.model,
        operation: 'transcribe_parse',
        status: 'success',
        latencyMs,
        httpStatus,
        requestMethod: 'POST',
        requestUrl: redactKeyInUrl(url),
        requestBody: this.cfg.logBodies ? JSON.stringify(requestBody) : null,
        responseBody: this.cfg.logBodies ? stripCodeFences(extracted) : null
      })

      return { observationsInserted: parsed.observations.length }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }

  async generateCards(opts: {
    batchId: number
    windowStartTs: number
    windowEndTs: number
    observations: Array<{ startTs: number; endTs: number; observation: string }>
    contextCards: Array<{
      startTs: number
      endTs: number
      category: string
      title: string
      summary?: string | null
    }>
  }): Promise<{
    cards: Array<{
      startTs: number
      endTs: number
      category: string
      subcategory?: string | null
      title: string
      summary?: string | null
      detailedSummary?: string | null
      metadata?: string | null
    }>
  }> {
    const apiKey = await getGeminiApiKey()
    if (!apiKey && !process.env.DAYFLOW_GEMINI_MOCK) {
      throw new Error('Missing Gemini API key (set DAYFLOW_GEMINI_API_KEY or store via keychain)')
    }

    if (process.env.DAYFLOW_GEMINI_MOCK) {
      const endTs = Math.max(opts.windowStartTs + 60, opts.windowEndTs - 60)
      const startTs = Math.max(opts.windowStartTs, endTs - 15 * 60)
      const mockJson = JSON.stringify({
        cards: [
          {
            startTs,
            endTs,
            category: 'Work',
            subcategory: 'Mock',
            title: 'Mock activity',
            summary: 'Mock card generation result.'
          }
        ]
      })

      const parsed = parseAndValidateCardsJson({
        jsonText: mockJson,
        windowStartTs: opts.windowStartTs,
        windowEndTs: opts.windowEndTs
      })

      return {
        cards: parsed.cards.map((c) => ({
          startTs: c.startTs,
          endTs: c.endTs,
          category: c.category,
          subcategory: c.subcategory ?? null,
          title: c.title,
          summary: c.summary ?? null,
          detailedSummary: c.detailedSummary ?? null,
          metadata: c.metadata ?? null
        }))
      }
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.cfg.model}:generateContent?key=${encodeURIComponent(
      apiKey!
    )}`

    const prompt = buildCardGenerationPrompt({
      windowStartTs: opts.windowStartTs,
      windowEndTs: opts.windowEndTs,
      observations: opts.observations,
      contextCards: opts.contextCards
    })

    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2
      }
    }

    const callGroupId = `batch:${opts.batchId}:generate_cards:${Date.now()}`

    const { text, latencyMs, httpStatus } = await this.fetchWithRetry({
      url,
      method: 'POST',
      body: JSON.stringify(requestBody),
      callGroupId,
      batchId: opts.batchId,
      model: this.cfg.model,
      operation: 'generate_cards'
    })

    const extracted = stripCodeFences(extractGeminiText(text))
    const parsed = parseAndValidateCardsJson({
      jsonText: extracted,
      windowStartTs: opts.windowStartTs,
      windowEndTs: opts.windowEndTs
    })
    if (parsed.cards.length === 0) {
      throw new Error('Gemini returned no valid cards')
    }

    await this.storage.insertLLMCall({
      batchId: opts.batchId,
      callGroupId,
      attempt: 1,
      provider: 'gemini',
      model: this.cfg.model,
      operation: 'generate_cards_parse',
      status: 'success',
      latencyMs,
      httpStatus,
      requestMethod: 'POST',
      requestUrl: redactKeyInUrl(url),
      requestBody: this.cfg.logBodies ? JSON.stringify(requestBody) : null,
      responseBody: this.cfg.logBodies ? extracted : null
    })

    return {
      cards: parsed.cards.map((c) => ({
        startTs: c.startTs,
        endTs: c.endTs,
        category: c.category,
        subcategory: c.subcategory ?? null,
        title: c.title,
        summary: c.summary ?? null,
        detailedSummary: c.detailedSummary ?? null,
        metadata: c.metadata ?? null
      }))
    }
  }

  private async fetchWithRetry(opts: {
    url: string
    method: string
    body: string
    callGroupId: string
    batchId: number
    model: string
    operation: string
  }): Promise<{ text: string; latencyMs: number; httpStatus: number }> {
    let lastErr: unknown = null

    for (let attempt = 1; attempt <= this.cfg.maxAttempts; attempt++) {
      const started = Date.now()
      try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs)

        const res = await fetch(opts.url, {
          method: opts.method,
          headers: {
            'content-type': 'application/json'
          },
          body: opts.body,
          signal: controller.signal
        }).finally(() => clearTimeout(t))

        const text = await res.text()
        const latencyMs = Date.now() - started

        const requestBody = this.cfg.logBodies ? opts.body : null
        const responseBody = this.cfg.logBodies ? text : null

        await this.storage.insertLLMCall({
          batchId: opts.batchId,
          callGroupId: opts.callGroupId,
          attempt,
          provider: 'gemini',
          model: opts.model,
          operation: opts.operation,
          status: res.ok ? 'success' : 'failure',
          latencyMs,
          httpStatus: res.status,
          requestMethod: opts.method,
          requestUrl: redactKeyInUrl(opts.url),
          requestHeaders: null,
          requestBody,
          responseHeaders: null,
          responseBody,
          errorDomain: res.ok ? null : 'http',
          errorCode: res.ok ? null : res.status,
          errorMessage: res.ok ? null : summarizeErrorBody(text)
        })

        if (!res.ok) {
          throw new Error(`Gemini HTTP ${res.status}: ${summarizeErrorBody(text)}`)
        }

        return { text, latencyMs, httpStatus: res.status }
      } catch (e) {
        lastErr = e
        this.log.warn('gemini.requestFailed', {
          attempt,
          operation: opts.operation,
          message: e instanceof Error ? e.message : String(e)
        })

        if (attempt < this.cfg.maxAttempts) {
          await sleep(500 * Math.pow(2, attempt - 1))
          continue
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
}

function buildTranscriptionPrompt(opts: { screenshotIntervalSeconds: number }): string {
  return [
    'Return valid JSON only.',
    '',
    'You are given a video that is a compressed timeline of screenshots at 1 frame per second.',
    `Each second of video corresponds to ${opts.screenshotIntervalSeconds} seconds of real time.`,
    '',
    'Task: produce a list of time-aligned, factual observations describing what is visible.',
    'Avoid speculation. Keep observations concise.',
    '',
    'Output format:',
    '{"observations":[{"start":"MM:SS","end":"MM:SS","observation":"...","appSites":{"primary":"...","secondary":"..."}}]}',
    '',
    'Rules:',
    '- start/end are video times in MM:SS.',
    '- Segments must be monotonically non-decreasing and end >= start.',
    '- Include appSites when confident; otherwise use nulls.',
    '- Do not include any extra keys outside the JSON.'
  ].join('\n')
}

function buildCardGenerationPrompt(opts: {
  windowStartTs: number
  windowEndTs: number
  observations: Array<{ startTs: number; endTs: number; observation: string }>
  contextCards: Array<{ startTs: number; endTs: number; category: string; title: string; summary?: string | null }>
}): string {
  return [
    'Return valid JSON only.',
    '',
    'You are generating timeline activity cards from timestamped observations.',
    `Window: [${opts.windowStartTs}, ${opts.windowEndTs}] (unix seconds).`,
    '',
    'Allowed categories: Work, Personal, Distraction, Idle',
    'Use Idle when the user appears inactive for more than half of the period.',
    '',
    'Observations (JSON array):',
    JSON.stringify(opts.observations),
    '',
    'Existing cards in the window for continuity (JSON array):',
    JSON.stringify(opts.contextCards),
    '',
    'Output format:',
    '{"cards":[{"startTs":0,"endTs":0,"category":"Work|Personal|Distraction|Idle","subcategory":"string","title":"string","summary":"string","detailedSummary":"string","appSites":{"primary":"string|null","secondary":"string|null"}}]}',
    '',
    'Rules:',
    '- Use unix seconds for startTs/endTs.',
    '- Each card must satisfy endTs > startTs.',
    '- Keep all cards within the Window.',
    '- Do not output any text outside the JSON.'
  ].join('\n')
}

function extractGeminiText(raw: string): string {
  // The API returns a JSON envelope; we only want the model text.
  // If parsing fails, fall back to the raw response.
  try {
    const parsed = JSON.parse(raw) as any
    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text
    if (typeof text === 'string') return text
    return raw
  } catch {
    return raw
  }
}

function redactKeyInUrl(url: string): string {
  return url.replace(/([?&]key=)[^&]+/i, '$1REDACTED')
}

function summarizeErrorBody(text: string): string {
  const t = text.trim()
  if (!t) return 'empty response body'
  return t.length > 400 ? t.slice(0, 400) + '...' : t
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
