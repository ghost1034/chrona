import sharp from 'sharp'
import type { Logger } from '../logger'
import type { SettingsStore } from '../settings'
import { normalizeLoopbackBaseUrl } from '../settings'
import type { ObservationInsert, StorageService } from '../storage/storage'
import { DEFAULT_CATEGORIES, parseAndValidateCardsJson, stripCodeFences } from '../gemini/cards'
import { buildCardGenerationPrompt } from '../gemini/gemini'
import { buildCardGenerationResponseSchema, type JsonSchema } from '../gemini/schemas'
import { getLocalBearerToken } from './localKeychain'
import { LocalRuntimeUnavailableError } from './errors'

type LocalConfig = {
  baseUrl: string
  visionModel: string
  textModel: string
  requestTimeoutMs: number
  maxAttempts: number
  logBodies: boolean
  visionMaxImagesPerRequest: number
}

type JsonResult = { text: string; provider: 'local'; model: string }

export class LocalAIService {
  constructor(
    private readonly opts: {
      storage: StorageService
      log: Logger
      settings: SettingsStore
    }
  ) {}

  async discoverModels(overrides?: { baseUrl?: string | null; token?: string | null }) {
    const cfg = await this.resolveConfig(overrides?.baseUrl)
    const token = overrides?.token?.trim() || (await getLocalBearerToken())
    const raw = await this.request({
      cfg,
      token,
      method: 'GET',
      path: '/models',
      operation: 'discover_models',
      model: null,
      callGroupId: `local:discover:${Date.now()}`,
      batchId: null
    })
    let parsed: any
    try {
      parsed = JSON.parse(raw.text)
    } catch {
      throw new Error('Local server returned invalid model-list JSON')
    }
    if (!Array.isArray(parsed?.data)) throw new Error('Local server response is missing a data array')
    return Array.from(
      new Set<string>(parsed.data.map((item: any) => String(item?.id ?? '').trim()).filter(Boolean))
    ).sort().map((id) => ({ id }))
  }

  async testConnection(opts: {
    kind: 'server' | 'text' | 'vision'
    baseUrl?: string | null
    token?: string | null
    model?: string | null
  }): Promise<{ ok: boolean; message: string }> {
    try {
      const cfg = await this.resolveConfig(opts.baseUrl)
      if (opts.kind === 'server') {
        const models = await this.discoverModels(opts)
        return { ok: true, message: `Connected; found ${models.length} model${models.length === 1 ? '' : 's'}` }
      }
      const model = opts.model?.trim() || (opts.kind === 'vision' ? cfg.visionModel : cfg.textModel)
      if (!model) return { ok: false, message: `Choose a ${opts.kind} model first` }
      const content = opts.kind === 'vision'
        ? [
            { type: 'text', text: 'Reply with exactly OK.' },
            { type: 'image_url', image_url: { url: TEST_PIXEL_DATA_URL } }
          ]
        : 'Reply with exactly OK.'
      await this.chat({
        cfg,
        tokenOverride: opts.token,
        model,
        operation: `test_${opts.kind}`,
        callGroupId: `local:test:${opts.kind}:${Date.now()}`,
        batchId: null,
        messages: [{ role: 'user', content }]
      })
      return { ok: true, message: `${opts.kind === 'vision' ? 'Vision' : 'Text'} model responded` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async generateJsonOnly(opts: {
    operation: string
    callGroupId: string
    prompt: string
    batchId?: number | null
    mockJson: string
    responseJsonSchema?: JsonSchema | null
  }): Promise<JsonResult> {
    const cfg = await this.resolveConfig()
    if (!cfg.textModel) throw new LocalRuntimeUnavailableError('Choose a local text model')
    const raw = await this.chat({
      cfg,
      model: cfg.textModel,
      operation: opts.operation,
      callGroupId: opts.callGroupId,
      batchId: opts.batchId ?? null,
      messages: [{ role: 'user', content: opts.prompt }],
      responseJsonSchema: opts.responseJsonSchema ?? null
    })
    return { text: stripCodeFences(extractOpenAIText(raw.text)), provider: 'local', model: cfg.textModel }
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
      subcategory?: string | null
      title: string
      summary?: string | null
    }>
  }) {
    const cfg = await this.resolveConfig()
    if (!cfg.textModel) throw new LocalRuntimeUnavailableError('Choose a local text model')
    const settings = await this.opts.settings.getAll()
    const categories = settings.categories ?? []
    const allowedCategories = categories.map((c) => c.name.trim()).filter((name) => name && name !== 'System')
    const allowed = allowedCategories.length > 0 ? allowedCategories : [...DEFAULT_CATEGORIES]
    const categoryNameById = new Map(categories.map((c) => [c.id, c.name]))
    const allowedSubs: Record<string, string[]> = Object.fromEntries(allowed.map((name) => [name, []]))
    for (const sub of settings.subcategories ?? []) {
      const category = categoryNameById.get(sub.categoryId)
      if (category && allowedSubs[category] && !allowedSubs[category].includes(sub.name)) {
        allowedSubs[category].push(sub.name)
      }
    }
    const prompt = buildCardGenerationPrompt({
      ...opts,
      preamble: settings.promptPreambleCards,
      allowedCategories: allowed,
      categories,
      subcategories: (settings.subcategories ?? []).map((s) => ({
        categoryId: s.categoryId,
        name: s.name,
        description: s.description
      }))
    })
    const callGroupId = `batch:${opts.batchId}:generate_cards:${Date.now()}`
    const raw = await this.chat({
      cfg,
      model: cfg.textModel,
      operation: 'generate_cards',
      callGroupId,
      batchId: opts.batchId,
      messages: [{ role: 'user', content: prompt }],
      responseJsonSchema: buildCardGenerationResponseSchema(allowed, allowedSubs)
    })
    try {
      const extracted = stripCodeFences(extractOpenAIText(raw.text))
      const parsed = parseAndValidateCardsJson({
        jsonText: extracted,
        windowStartTs: opts.windowStartTs,
        windowEndTs: opts.windowEndTs,
        allowedCategories: allowed,
        allowedSubcategoriesByCategory: allowedSubs
      })
      if (parsed.cards.length === 0) throw new Error('Local text model returned no valid cards')
      await this.recordParse(callGroupId, opts.batchId, cfg.textModel, 'generate_cards_parse', null)
      return { cards: parsed.cards }
    } catch (error) {
      await this.recordParse(callGroupId, opts.batchId, cfg.textModel, 'generate_cards_parse', error)
      throw error
    }
  }

  async transcribeBatch(opts: {
    batchId: number
    batchStartTs: number
    batchEndTs: number
    screenshots: Array<{ filePath: string; capturedAt: number }>
    screenshotIntervalSeconds: number
  }): Promise<{ observationsInserted: number }> {
    const cfg = await this.resolveConfig()
    if (!cfg.visionModel) throw new LocalRuntimeUnavailableError('Choose a local vision model')
    if (opts.screenshots.length === 0) return { observationsInserted: 0 }

    const settings = await this.opts.settings.getAll()
    const frames = await Promise.all(
      opts.screenshots.map(async (screen, index) => ({
        index,
        capturedAt: screen.capturedAt,
        dataUrl: `data:image/jpeg;base64,${(
          await sharp(this.opts.storage.resolveRelPath(screen.filePath))
            .resize({ height: 540, withoutEnlargement: true })
            .jpeg({ quality: 78 })
            .toBuffer()
        ).toString('base64')}`
      }))
    )

    const observations: ObservationInsert[] = []
    const chunks = buildOverlappingChunks(frames, cfg.visionMaxImagesPerRequest)
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex]
      const prompt = buildLocalVisionPrompt({
        frameIndexes: chunk.map((f) => f.index),
        preamble: settings.promptPreambleTranscribe
      })
      const content: any[] = [{ type: 'text', text: prompt }]
      for (const frame of chunk) {
        content.push({ type: 'text', text: `FRAME_${frame.index}` })
        content.push({ type: 'image_url', image_url: { url: frame.dataUrl } })
      }
      const callGroupId = `batch:${opts.batchId}:transcribe:${Date.now()}:chunk:${chunkIndex}`
      const raw = await this.chat({
        cfg,
        model: cfg.visionModel,
        operation: 'transcribe',
        callGroupId,
        batchId: opts.batchId,
        messages: [{ role: 'user', content }],
        responseJsonSchema: LOCAL_VISION_SCHEMA
      })
      let parsed: ReturnType<typeof parseLocalVisionResponse>
      try {
        parsed = parseLocalVisionResponse(extractOpenAIText(raw.text), new Set(chunk.map((f) => f.index)))
      } catch (error) {
        await this.recordParse(callGroupId, opts.batchId, cfg.visionModel, 'transcribe_parse', error)
        throw error
      }
      for (const item of parsed) {
        const startFrame = frames[item.startFrame]
        const endFrame = frames[item.endFrame]
        if (!startFrame || !endFrame) throw new Error('Local vision model returned an unknown frame index')
        const startTs = Math.max(opts.batchStartTs, startFrame.capturedAt)
        const endTs = Math.min(
          opts.batchEndTs,
          Math.max(startTs + 1, endFrame.capturedAt + opts.screenshotIntervalSeconds)
        )
        if (endTs <= startTs) continue
        observations.push({
          startTs,
          endTs,
          observation: item.observation,
          metadata: item.appSites ? JSON.stringify({ appSites: item.appSites }) : null,
          llmModel: cfg.visionModel
        })
      }
      await this.recordParse(callGroupId, opts.batchId, cfg.visionModel, 'transcribe_parse', null)
    }

    const normalized = mergeBoundaryObservations(observations)
    await this.opts.storage.insertObservations(opts.batchId, normalized)
    return { observationsInserted: normalized.length }
  }

  async recordParse(
    callGroupId: string,
    batchId: number | null,
    model: string,
    operation: string,
    error: unknown
  ) {
    await this.opts.storage.insertLLMCall({
      batchId,
      callGroupId,
      provider: 'local',
      model,
      operation,
      status: error ? 'failure' : 'success',
      errorDomain: error ? 'parse' : null,
      errorMessage: error ? (error instanceof Error ? error.message : String(error)) : null
    })
  }

  private async resolveConfig(baseUrlOverride?: string | null): Promise<LocalConfig> {
    const settings = await this.opts.settings.getAll()
    return {
      baseUrl: normalizeLoopbackBaseUrl(baseUrlOverride?.trim() || settings.localBaseUrl),
      visionModel: String(settings.localVisionModel ?? '').trim(),
      textModel: String(settings.localTextModel ?? '').trim(),
      requestTimeoutMs: clamp(Number(settings.localRequestTimeoutMs), 1_000, 30 * 60_000, 300_000),
      maxAttempts: clamp(Number(settings.localMaxAttempts), 1, 10, 2),
      logBodies: !!settings.localLogBodies,
      visionMaxImagesPerRequest: clamp(Number(settings.localVisionMaxImagesPerRequest), 2, 64, 12)
    }
  }

  private async chat(opts: {
    cfg: LocalConfig
    tokenOverride?: string | null
    model: string
    operation: string
    callGroupId: string
    batchId: number | null
    messages: any[]
    responseJsonSchema?: JsonSchema | null
  }) {
    const body = JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: false,
      temperature: 0.2,
      ...(opts.responseJsonSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: schemaName(opts.operation),
                strict: false,
                schema: toStandardJsonSchema(opts.responseJsonSchema)
              }
            }
          }
        : {})
    })
    return this.request({
      cfg: opts.cfg,
      token: opts.tokenOverride?.trim() || (await getLocalBearerToken()),
      method: 'POST',
      path: '/chat/completions',
      body,
      operation: opts.operation,
      model: opts.model,
      callGroupId: opts.callGroupId,
      batchId: opts.batchId
    })
  }

  private async request(opts: {
    cfg: LocalConfig
    token: string | null
    method: 'GET' | 'POST'
    path: string
    body?: string
    operation: string
    model: string | null
    callGroupId: string
    batchId: number | null
  }): Promise<{ text: string; status: number }> {
    const url = `${opts.cfg.baseUrl}${opts.path}`
    let lastError: unknown
    for (let attempt = 1; attempt <= opts.cfg.maxAttempts; attempt++) {
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), opts.cfg.requestTimeoutMs)
      let responseLogged = false
      try {
        const response = await fetch(url, {
          method: opts.method,
          headers: {
            ...(opts.body ? { 'content-type': 'application/json' } : {}),
            ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
          },
          body: opts.body,
          signal: controller.signal,
          redirect: 'manual'
        })
        const text = await response.text()
        const latencyMs = Date.now() - started
        await this.opts.storage.insertLLMCall({
          batchId: opts.batchId,
          callGroupId: opts.callGroupId,
          attempt,
          provider: 'local',
          model: opts.model,
          operation: opts.operation,
          status: response.ok ? 'success' : 'failure',
          latencyMs,
          httpStatus: response.status,
          requestMethod: opts.method,
          requestUrl: url,
          requestHeaders: null,
          requestBody: opts.cfg.logBodies && opts.body ? sanitizeRequestBody(opts.body) : null,
          responseBody: opts.cfg.logBodies ? sanitizeLogText(text) : null,
          errorDomain: response.ok ? null : response.status >= 300 && response.status < 400 ? 'redirect' : 'http',
          errorCode: response.ok ? null : response.status,
          errorMessage: response.ok ? null : summarize(sanitizeLogText(text))
        })
        responseLogged = true
        if (response.status >= 300 && response.status < 400) {
          throw new Error('Local server redirects are not allowed')
        }
        if (!response.ok) {
          const error = new Error(`Local server HTTP ${response.status}: ${summarize(text)}`)
          ;(error as any).retryable = response.status === 408 || response.status === 429 || response.status >= 500
          throw error
        }
        return { text, status: response.status }
      } catch (error) {
        lastError = error
        const unavailable = controller.signal.aborted || isConnectionError(error)
        if (!responseLogged) {
          await this.opts.storage.insertLLMCall({
            batchId: opts.batchId,
            callGroupId: opts.callGroupId,
            attempt,
            provider: 'local',
            model: opts.model,
            operation: opts.operation,
            status: 'failure',
            latencyMs: Date.now() - started,
            requestMethod: opts.method,
            requestUrl: url,
            errorDomain: controller.signal.aborted ? 'timeout' : unavailable ? 'network' : 'request',
            errorMessage: controller.signal.aborted
              ? `Local server timed out after ${opts.cfg.requestTimeoutMs}ms`
              : error instanceof Error ? error.message : String(error)
          })
        }
        this.opts.log.warn('localAI.requestFailed', {
          attempt,
          operation: opts.operation,
          message: error instanceof Error ? error.message : String(error)
        })
        if ((error as any)?.retryable && attempt < opts.cfg.maxAttempts) continue
        if (unavailable && attempt < opts.cfg.maxAttempts) continue
        if (unavailable) {
          throw new LocalRuntimeUnavailableError(
            controller.signal.aborted
              ? `Local server timed out after ${opts.cfg.requestTimeoutMs}ms`
              : 'Could not connect to the local AI server',
            { cause: error }
          )
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
}

const LOCAL_VISION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          startFrame: { type: 'integer' },
          endFrame: { type: 'integer' },
          observation: { type: 'string' },
          appSites: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              primary: { type: ['string', 'null'] },
              secondary: { type: ['string', 'null'] }
            },
            required: ['primary', 'secondary']
          }
        },
        required: ['startFrame', 'endFrame', 'observation']
      }
    }
  },
  required: ['observations']
}

export function buildOverlappingChunks<T>(items: T[], maxSize: number): T[][] {
  if (items.length === 0) return []
  const size = Math.max(2, Math.floor(maxSize))
  const chunks: T[][] = []
  let start = 0
  while (start < items.length) {
    const end = Math.min(items.length, start + size)
    chunks.push(items.slice(start, end))
    if (end === items.length) break
    start = end - 1
  }
  return chunks
}

export function mergeBoundaryObservations(observations: ObservationInsert[]): ObservationInsert[] {
  const sorted = [...observations].sort((a, b) => a.startTs - b.startTs || a.endTs - b.endTs)
  const out: ObservationInsert[] = []
  for (const current of sorted) {
    const previous = out[out.length - 1]
    if (
      previous &&
      previous.observation.trim() === current.observation.trim() &&
      current.startTs <= previous.endTs
    ) {
      previous.endTs = Math.max(previous.endTs, current.endTs)
      continue
    }
    if (
      previous &&
      previous.startTs === current.startTs &&
      previous.endTs === current.endTs &&
      previous.observation.trim() === current.observation.trim()
    ) continue
    out.push({ ...current })
  }
  return out
}

function parseLocalVisionResponse(text: string, allowedIndexes: Set<number>) {
  let parsed: any
  try {
    parsed = JSON.parse(stripCodeFences(text))
  } catch {
    throw new Error('Local vision model returned invalid JSON')
  }
  if (!Array.isArray(parsed?.observations)) throw new Error('Local vision response is missing observations')
  return parsed.observations.map((item: any) => {
    const startFrame = Math.floor(Number(item?.startFrame))
    const endFrame = Math.floor(Number(item?.endFrame))
    const observation = String(item?.observation ?? '').trim()
    if (!allowedIndexes.has(startFrame) || !allowedIndexes.has(endFrame) || endFrame < startFrame) {
      throw new Error('Local vision model returned an invalid frame range')
    }
    if (!observation) throw new Error('Local vision model returned an empty observation')
    const appSites = item?.appSites && typeof item.appSites === 'object'
      ? {
          primary: typeof item.appSites.primary === 'string' ? item.appSites.primary : null,
          secondary: typeof item.appSites.secondary === 'string' ? item.appSites.secondary : null
        }
      : null
    return { startFrame, endFrame, observation, appSites }
  })
}

function buildLocalVisionPrompt(opts: { frameIndexes: number[]; preamble?: string }) {
  return [
    'Return valid JSON only.',
    opts.preamble?.trim() ? `User instructions:\n${opts.preamble.trim()}` : '',
    'The attached screenshots are labeled with trusted frame IDs.',
    `Allowed frame IDs: ${opts.frameIndexes.join(', ')}.`,
    'Describe visible activity factually. Return inclusive startFrame/endFrame ranges using only those IDs.',
    'Output: {"observations":[{"startFrame":0,"endFrame":0,"observation":"...","appSites":{"primary":null,"secondary":null}}]}'
  ].filter(Boolean).join('\n')
}

function extractOpenAIText(raw: string): string {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Local server returned invalid JSON')
  }
  const content = parsed?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('Local server response is missing message content')
  return content
}

function sanitizeRequestBody(body: string): string {
  try {
    const parsed = JSON.parse(body)
    for (const message of parsed.messages ?? []) {
      if (!Array.isArray(message.content)) continue
      for (const part of message.content) {
        if (part?.type === 'image_url' && part.image_url) part.image_url.url = '[image omitted]'
      }
    }
    return JSON.stringify(parsed)
  } catch {
    return '[unavailable]'
  }
}

function sanitizeLogText(text: string): string {
  return text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=_-]+/g, '[image omitted]')
}

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = String((error as any).cause?.code ?? (error as any).code ?? '')
  return ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
}

function schemaName(operation: string) {
  return `chrona_${operation}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

function toStandardJsonSchema(value: any): any {
  if (Array.isArray(value)) return value.map(toStandardJsonSchema)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'propertyOrdering')
      .map(([key, child]) => [key, toStandardJsonSchema(child)])
  )
}

function summarize(text: string) {
  const value = text.trim()
  if (!value) return 'empty response body'
  return value.length > 400 ? `${value.slice(0, 400)}...` : value
}

function clamp(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

const TEST_PIXEL_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
