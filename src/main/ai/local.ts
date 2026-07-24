import type { Logger } from '../logger'
import type { SettingsStore } from '../settings'
import { normalizeLoopbackBaseUrl } from '../settings'
import type { ObservationInsert, StorageService } from '../storage/storage'
import {
  DEFAULT_CATEGORIES,
  parseAndValidateCardsJson,
  stripCodeFences,
  type CardGenerationCard
} from '../gemini/cards'
import { buildCardGenerationPrompt } from '../gemini/gemini'
import { buildCardGenerationResponseSchema, type JsonSchema } from '../gemini/schemas'
import { getLocalBearerToken } from './localKeychain'
import {
  IncompleteLocalCardCoverageError,
  LocalRuntimeUnavailableError,
  type CoverageInterval
} from './errors'
import type { LocalRuntime, LocalSetupResult } from '../../shared/ipc'
import {
  buildLocalVisionStoryboards,
  calculateLocalVisionFrameBudget,
  calculateGrayscaleTransitionScores,
  selectRepresentativeFrameIndexes,
  type LocalVisionFrame
} from './localVision'

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

type LocalBatchTiming = {
  startedAt: number
  originalFrameCount: number
  selectedFrameBudget: number
  sampledFrameCount: number
  storyboardCount: number
  requestCount: number
  observationCount: number
  observationCoverageSeconds: number
  observationCoverageRatio: number
  preprocessingMs: number
  visionMs: number
}

const LOCAL_CARD_LIMIT = 12
const LOCAL_CARD_COVERAGE_TOLERANCE_SECONDS = 1

type LocalVisionObservation = {
  startFrame: number
  endFrame: number
  observation: string
  appSites: { primary: string | null; secondary: string | null } | null
}

export class LocalAIService {
  private readonly batchTimings = new Map<number, LocalBatchTiming>()

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

  async autoConfigure(): Promise<LocalSetupResult> {
    const settings = await this.opts.settings.getAll()
    const token = await getLocalBearerToken()
    const candidates = uniqueRuntimeCandidates(settings.localBaseUrl)
    const probes = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const cfg = await this.resolveConfig(candidate.baseUrl)
          const models = await this.discoverModelsWithConfig({
            cfg: { ...cfg, requestTimeoutMs: Math.min(cfg.requestTimeoutMs, 2_500), maxAttempts: 1 },
            token
          })
          return { ...candidate, models }
        } catch {
          return null
        }
      })
    )
    const available = probes.filter((probe): probe is NonNullable<typeof probe> => !!probe)
    if (available.length === 0) {
      return {
        status: 'unavailable',
        runtime: null,
        baseUrl: null,
        models: [],
        visionModel: null,
        textModel: null,
        message: 'No local AI server was found. Install and open Ollama, or start the local server in LM Studio, then try again.',
        recommendedCommand: null
      }
    }

    const ranked = available.map((probe) => ({
      ...probe,
      selection: selectLocalModels(probe.models.map((model) => model.id), {
        visionModel: settings.localVisionModel,
        textModel: settings.localTextModel
      })
    }))
    const selected = ranked.find((probe) => probe.selection.visionModel && probe.selection.textModel)
      ?? ranked.find((probe) => probe.models.length > 0)
      ?? ranked[0]!
    const { visionModel, textModel } = selected.selection

    await this.opts.settings.update({
      aiProvider: 'local',
      localBaseUrl: selected.baseUrl,
      localVisionModel: visionModel ?? '',
      localTextModel: textModel ?? ''
    })

    if (selected.models.length === 0) {
      return {
        status: 'needs_models',
        runtime: selected.runtime,
        baseUrl: selected.baseUrl,
        models: [],
        visionModel: null,
        textModel: null,
        message: `${runtimeName(selected.runtime)} is running, but it has no models available. Download a vision model, then try again.`,
        recommendedCommand: selected.runtime === 'ollama' ? 'ollama pull qwen3-vl:4b-instruct' : null
      }
    }
    if (!visionModel) {
      return {
        status: 'needs_vision_model',
        runtime: selected.runtime,
        baseUrl: selected.baseUrl,
        models: selected.models,
        visionModel: null,
        textModel,
        message: `${runtimeName(selected.runtime)} was found and the text model was selected, but Chrona also needs a vision model to understand screenshots.`,
        recommendedCommand: selected.runtime === 'ollama' ? 'ollama pull qwen3-vl:4b-instruct' : null
      }
    }
    const thinkingSelections = [visionModel, textModel].filter(
      (model): model is string => !!model && isKnownThinkingModel(model)
    )
    return {
      status: 'ready',
      runtime: selected.runtime,
      baseUrl: selected.baseUrl,
      models: selected.models,
      visionModel,
      textModel: textModel!,
      message: thinkingSelections.length > 0
        ? `${runtimeName(selected.runtime)} is ready, but ${Array.from(new Set(thinkingSelections)).join(' and ')} may spend substantial time thinking. Install and select the non-thinking instruct model for faster analysis.`
        : `${runtimeName(selected.runtime)} is ready. Chrona selected ${visionModel === textModel ? visionModel : `${visionModel} for vision and ${textModel} for text`}.`,
      recommendedCommand: thinkingSelections.length > 0 && selected.runtime === 'ollama'
        ? 'ollama pull qwen3-vl:4b-instruct'
        : null
    }
  }

  private async discoverModelsWithConfig(opts: { cfg: LocalConfig; token: string | null }) {
    const raw = await this.request({
      cfg: opts.cfg,
      token: opts.token,
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
    targetStartTs?: number
    targetEndTs?: number
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
    const cardStartedAt = Date.now()
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
    const targetStartTs = Math.max(opts.windowStartTs, opts.targetStartTs ?? opts.windowStartTs)
    const targetEndTs = Math.min(opts.windowEndTs, opts.targetEndTs ?? opts.windowEndTs)
    if (targetEndTs <= targetStartTs) throw new Error('Local card target window is invalid')
    const targetObservations = opts.observations
      .filter((observation) => observation.startTs < targetEndTs && observation.endTs > targetStartTs)
      .map((observation) => ({
        ...observation,
        startTs: Math.max(targetStartTs, observation.startTs),
        endTs: Math.min(targetEndTs, observation.endTs)
      }))
    const boundaryContextCards = opts.contextCards
      .filter((card) => card.startTs < targetStartTs && card.endTs >= targetStartTs)
      .sort((a, b) => b.endTs - a.endTs || b.startTs - a.startTs)
      .slice(0, 1)
    const requiredIntervals = mergeCoverageIntervals(targetObservations, targetStartTs, targetEndTs)
    const requiredCoverageSeconds = sumIntervalSeconds(requiredIntervals)
    const prompt = buildLocalCardGenerationPrompt(buildCardGenerationPrompt({
      ...opts,
      windowStartTs: targetStartTs,
      windowEndTs: targetEndTs,
      observations: targetObservations,
      contextCards: boundaryContextCards,
      preamble: settings.promptPreambleCards,
      allowedCategories: allowed,
      categories,
      subcategories: (settings.subcategories ?? []).map((s) => ({
        categoryId: s.categoryId,
        name: s.name,
        description: s.description
      }))
    }), { targetStartTs, targetEndTs, requiredIntervals })
    const callGroupId = `batch:${opts.batchId}:generate_cards:${Date.now()}`
    let cardCount: number | null = null
    let cardCoverageSeconds: number | null = null
    let cardCoverageRatio: number | null = null
    try {
      const raw = await this.chat({
        cfg,
        model: cfg.textModel,
        operation: 'generate_cards',
        callGroupId,
        batchId: opts.batchId,
        messages: [{ role: 'user', content: prompt }],
        responseJsonSchema: buildCardGenerationResponseSchema(allowed, allowedSubs, LOCAL_CARD_LIMIT)
      })
      let candidateCards: CardGenerationCard[] = []
      const parseAndRequireCoverage = async (
        responseText: string,
        parseOperation: string
      ): Promise<CardGenerationCard[]> => {
        try {
          const extracted = stripCodeFences(extractOpenAIText(responseText))
          assertLocalCardResponseOrder(extracted)
          const parsed = parseAndValidateCardsJson({
            jsonText: extracted,
            windowStartTs: targetStartTs,
            windowEndTs: targetEndTs,
            allowedCategories: allowed,
            allowedSubcategoriesByCategory: allowedSubs
          })
          if (parsed.cards.length === 0) throw new Error('Local text model returned no valid target cards')
          candidateCards = validateLocalGeneratedCards(parsed.cards, LOCAL_CARD_LIMIT)
          const uncovered = findUncoveredEvidenceIntervals(
            requiredIntervals,
            candidateCards,
            targetStartTs,
            targetEndTs
          )
          const uncoveredSeconds = sumIntervalSeconds(uncovered)
          cardCount = candidateCards.length
          cardCoverageSeconds = Math.max(0, requiredCoverageSeconds - uncoveredSeconds)
          cardCoverageRatio = requiredCoverageSeconds > 0
            ? cardCoverageSeconds / requiredCoverageSeconds
            : 1
          if (uncoveredSeconds > LOCAL_CARD_COVERAGE_TOLERANCE_SECONDS) {
            throw new IncompleteLocalCardCoverageError(uncovered)
          }
          await this.recordParse(callGroupId, opts.batchId, cfg.textModel, parseOperation, null)
          return candidateCards
        } catch (error) {
          await this.recordParse(callGroupId, opts.batchId, cfg.textModel, parseOperation, error)
          throw error
        }
      }
      try {
        return { cards: await parseAndRequireCoverage(raw.text, 'generate_cards_parse') }
      } catch (error) {
        if (!(error instanceof IncompleteLocalCardCoverageError)) throw error
        const repairRaw = await this.chat({
          cfg,
          model: cfg.textModel,
          operation: 'generate_cards_repair',
          callGroupId,
          batchId: opts.batchId,
          messages: [{
            role: 'user',
            content: buildLocalCardRepairPrompt({
              originalPrompt: prompt,
              candidateCards,
              uncoveredIntervals: error.uncoveredIntervals,
              observations: targetObservations
            })
          }],
          responseJsonSchema: buildCardGenerationResponseSchema(allowed, allowedSubs, LOCAL_CARD_LIMIT)
        })
        try {
          return { cards: await parseAndRequireCoverage(repairRaw.text, 'generate_cards_repair_parse') }
        } catch (repairError) {
          if (repairError instanceof IncompleteLocalCardCoverageError) throw repairError
          throw new IncompleteLocalCardCoverageError(error.uncoveredIntervals)
        }
      }
    } finally {
      this.logCompletedBatchTiming(opts.batchId, Date.now() - cardStartedAt, {
        cardCount,
        cardCoverageSeconds,
        cardCoverageRatio
      })
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

    const batchStartedAt = Date.now()
    const settings = await this.opts.settings.getAll()
    const sourceFrames: LocalVisionFrame[] = opts.screenshots.map((screen, index) => ({
      index,
      capturedAt: screen.capturedAt,
      filePath: this.opts.storage.resolveRelPath(screen.filePath)
    }))
    const transitionScores = await calculateGrayscaleTransitionScores(sourceFrames.map((frame) => frame.filePath))
    const capturedAts = sourceFrames.map((frame) => frame.capturedAt)
    const selectedFrameBudget = calculateLocalVisionFrameBudget(capturedAts)
    const sampledIndexes = selectRepresentativeFrameIndexes(
      capturedAts,
      transitionScores,
      selectedFrameBudget
    )
    const frames = sampledIndexes.map((index) => sourceFrames[index]!)
    const initialPreprocessingMs = Date.now() - batchStartedAt

    const observations: ObservationInsert[] = []
    const chunks = buildOverlappingChunks(frames, cfg.visionMaxImagesPerRequest)
    const counters = { storyboardCount: 0, requestCount: 0, storyboardMs: 0, visionMs: 0, chunkSequence: 0 }
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const parsed = await this.transcribeLocalVisionChunk({
        cfg,
        batchId: opts.batchId,
        chunk: chunks[chunkIndex]!,
        contextFrameIndex: chunkIndex > 0 ? chunks[chunkIndex]![0]!.index : null,
        preamble: settings.promptPreambleTranscribe,
        counters
      })
      for (const item of parsed) {
        const startFrame = sourceFrames[item.startFrame]
        const endFrame = sourceFrames[item.endFrame]
        if (!startFrame || !endFrame) throw new Error('Local vision model returned an unknown frame index')
        const evidenceIntervals = expandSampledFrameRange({
          startFrameIndex: item.startFrame,
          endFrameIndex: item.endFrame,
          sampledFrameIndexes: sampledIndexes,
          capturedAts,
          batchStartTs: opts.batchStartTs,
          batchEndTs: opts.batchEndTs,
          screenshotIntervalSeconds: opts.screenshotIntervalSeconds
        })
        for (const { startTs, endTs } of evidenceIntervals) {
          if (endTs <= startTs) continue
          observations.push({
            startTs,
            endTs,
            observation: item.observation,
            metadata: item.appSites ? JSON.stringify({ appSites: item.appSites }) : null,
            llmModel: cfg.visionModel
          })
        }
      }
    }

    const normalized = mergeBoundaryObservations(observations)
    await this.opts.storage.insertObservations(opts.batchId, normalized)
    const observationCoverageSeconds = intervalCoverageSeconds(
      normalized,
      opts.batchStartTs,
      opts.batchEndTs
    )
    const timing: LocalBatchTiming = {
      startedAt: batchStartedAt,
      originalFrameCount: sourceFrames.length,
      selectedFrameBudget,
      sampledFrameCount: frames.length,
      storyboardCount: counters.storyboardCount,
      requestCount: counters.requestCount,
      observationCount: normalized.length,
      observationCoverageSeconds,
      observationCoverageRatio: coverageRatio(
        observationCoverageSeconds,
        opts.batchStartTs,
        opts.batchEndTs
      ),
      preprocessingMs: initialPreprocessingMs + counters.storyboardMs,
      visionMs: counters.visionMs
    }
    this.batchTimings.set(opts.batchId, timing)
    this.opts.log.info('localAI.batchTiming', {
      batchId: opts.batchId,
      phase: 'vision',
      originalFrameCount: timing.originalFrameCount,
      selectedFrameBudget: timing.selectedFrameBudget,
      sampledFrameCount: timing.sampledFrameCount,
      storyboardCount: timing.storyboardCount,
      requestCount: timing.requestCount,
      observationCount: timing.observationCount,
      observationCoverageSeconds: timing.observationCoverageSeconds,
      observationCoverageRatio: timing.observationCoverageRatio,
      cardCount: null,
      cardCoverageSeconds: null,
      cardCoverageRatio: null,
      preprocessingMs: timing.preprocessingMs,
      visionMs: timing.visionMs,
      cardGenerationMs: null,
      totalDurationMs: Date.now() - timing.startedAt
    })
    return { observationsInserted: normalized.length }
  }

  private async transcribeLocalVisionChunk(opts: {
    cfg: LocalConfig
    batchId: number
    chunk: LocalVisionFrame[]
    contextFrameIndex: number | null
    preamble?: string
    counters: { storyboardCount: number; requestCount: number; storyboardMs: number; visionMs: number; chunkSequence: number }
  }): Promise<ReturnType<typeof parseLocalVisionResponse>> {
    const storyboardStartedAt = Date.now()
    const storyboards = await buildLocalVisionStoryboards(opts.chunk)
    opts.counters.storyboardMs += Date.now() - storyboardStartedAt
    opts.counters.storyboardCount += storyboards.length
    const prompt = buildLocalVisionPrompt({
      frameIndexes: opts.chunk.map((frame) => frame.index),
      contextFrameIndex: opts.contextFrameIndex,
      preamble: opts.preamble
    })
    const content: any[] = [{ type: 'text', text: prompt }]
    for (const dataUrl of storyboards) content.push({ type: 'image_url', image_url: { url: dataUrl } })
    const sequence = opts.counters.chunkSequence++
    const callGroupId = `batch:${opts.batchId}:transcribe:${Date.now()}:chunk:${sequence}`
    opts.counters.requestCount++
    const visionStartedAt = Date.now()
    let raw: Awaited<ReturnType<LocalAIService['chat']>>
    try {
      raw = await this.chat({
        cfg: opts.cfg,
        model: opts.cfg.visionModel,
        operation: 'transcribe',
        callGroupId,
        batchId: opts.batchId,
        messages: [{ role: 'user', content }],
        responseJsonSchema: LOCAL_VISION_SCHEMA
      })
    } catch (error) {
      opts.counters.visionMs += Date.now() - visionStartedAt
      if (isContextLengthError(error) && opts.chunk.length > 2) {
        const smallerChunks = splitOverlappingChunk(opts.chunk)
        const parsed = []
        for (let index = 0; index < smallerChunks.length; index++) {
          const smallerChunk = smallerChunks[index]!
          parsed.push(...await this.transcribeLocalVisionChunk({
            ...opts,
            chunk: smallerChunk,
            contextFrameIndex: index === 0 ? opts.contextFrameIndex : smallerChunk[0]!.index
          }))
        }
        return parsed
      }
      throw error
    }
    opts.counters.visionMs += Date.now() - visionStartedAt
    try {
      const parsed = parseLocalVisionResponse(
        extractOpenAIText(raw.text),
        new Set(opts.chunk.map((frame) => frame.index))
      )
      await this.recordParse(callGroupId, opts.batchId, opts.cfg.visionModel, 'transcribe_parse', null)
      return clipContextOnlyFrame(parsed, opts.chunk, opts.contextFrameIndex)
    } catch (error) {
      await this.recordParse(callGroupId, opts.batchId, opts.cfg.visionModel, 'transcribe_parse', error)
      throw error
    }
  }

  private logCompletedBatchTiming(
    batchId: number,
    cardGenerationMs: number,
    cards: {
      cardCount: number | null
      cardCoverageSeconds: number | null
      cardCoverageRatio: number | null
    }
  ) {
    const timing = this.batchTimings.get(batchId)
    this.opts.log.info('localAI.batchTiming', {
      batchId,
      phase: 'complete',
      originalFrameCount: timing?.originalFrameCount ?? null,
      selectedFrameBudget: timing?.selectedFrameBudget ?? null,
      sampledFrameCount: timing?.sampledFrameCount ?? null,
      storyboardCount: timing?.storyboardCount ?? null,
      requestCount: timing?.requestCount ?? null,
      observationCount: timing?.observationCount ?? null,
      observationCoverageSeconds: timing?.observationCoverageSeconds ?? null,
      observationCoverageRatio: timing?.observationCoverageRatio ?? null,
      cardCount: cards.cardCount,
      cardCoverageSeconds: cards.cardCoverageSeconds,
      cardCoverageRatio: cards.cardCoverageRatio,
      preprocessingMs: timing?.preprocessingMs ?? null,
      visionMs: timing?.visionMs ?? null,
      cardGenerationMs,
      totalDurationMs: timing ? Date.now() - timing.startedAt : cardGenerationMs
    })
    this.batchTimings.delete(batchId)
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
      visionMaxImagesPerRequest: clamp(Number(settings.localVisionMaxImagesPerRequest), 4, 12, 12)
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

export function splitOverlappingChunk<T>(items: T[]): T[][] {
  if (items.length <= 2) return [items]
  return buildOverlappingChunks(items, Math.ceil((items.length + 1) / 2))
}

export function isContextLengthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:context[_ -](?:length|window|size)|context overflow|maximum context|exceeds?[^\n]*context|num_ctx|too many tokens|input (?:is )?too long|token limit)/i.test(message)
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

export function expandSampledFrameRange(opts: {
  startFrameIndex: number
  endFrameIndex: number
  sampledFrameIndexes: number[]
  capturedAts: number[]
  batchStartTs: number
  batchEndTs: number
  screenshotIntervalSeconds: number
}): Array<{ startTs: number; endTs: number }> {
  const startPosition = opts.sampledFrameIndexes.indexOf(opts.startFrameIndex)
  const endPosition = opts.sampledFrameIndexes.indexOf(opts.endFrameIndex)
  if (startPosition < 0 || endPosition < startPosition) {
    throw new Error('Local vision model returned an invalid sampled frame range')
  }

  const startCapturedAt = opts.capturedAts[opts.startFrameIndex]
  const endCapturedAt = opts.capturedAts[opts.endFrameIndex]
  if (!Number.isFinite(startCapturedAt) || !Number.isFinite(endCapturedAt)) {
    throw new Error('Local vision model returned an unknown frame index')
  }

  const previousIndex = opts.sampledFrameIndexes[startPosition - 1]
  const nextIndex = opts.sampledFrameIndexes[endPosition + 1]
  const startTs = previousIndex !== undefined && hasNormalCaptureCadence(
    opts.capturedAts,
    previousIndex,
    opts.startFrameIndex,
    opts.screenshotIntervalSeconds
  )
    ? Math.floor((opts.capturedAts[previousIndex]! + startCapturedAt) / 2)
    : startCapturedAt
  const endTs = nextIndex !== undefined && hasNormalCaptureCadence(
    opts.capturedAts,
    opts.endFrameIndex,
    nextIndex,
    opts.screenshotIntervalSeconds
  )
    ? Math.floor((endCapturedAt + opts.capturedAts[nextIndex]!) / 2)
    : endCapturedAt + opts.screenshotIntervalSeconds

  const boundedStart = Math.max(opts.batchStartTs, startTs)
  const boundedEnd = Math.min(opts.batchEndTs, endTs)
  const intervals: Array<{ startTs: number; endTs: number }> = []
  let segmentStart = boundedStart
  for (let index = opts.startFrameIndex + 1; index <= opts.endFrameIndex; index++) {
    if (hasNormalCaptureCadence(
      opts.capturedAts,
      index - 1,
      index,
      opts.screenshotIntervalSeconds
    )) continue
    const segmentEnd = Math.min(
      boundedEnd,
      opts.capturedAts[index - 1]! + opts.screenshotIntervalSeconds
    )
    if (segmentEnd > segmentStart) intervals.push({ startTs: segmentStart, endTs: segmentEnd })
    segmentStart = Math.max(boundedStart, opts.capturedAts[index]!)
  }
  if (boundedEnd > segmentStart) intervals.push({ startTs: segmentStart, endTs: boundedEnd })
  return intervals
}

export function validateLocalGeneratedCards(
  cards: CardGenerationCard[],
  maxCards = LOCAL_CARD_LIMIT
): CardGenerationCard[] {
  if (cards.length > maxCards) {
    throw new Error(`Local text model returned more than ${maxCards} cards`)
  }

  const normalized = cards.map((card) => ({ ...card }))
  for (let index = 0; index < normalized.length; index++) {
    const current = normalized[index]!
    if (!Number.isFinite(current.startTs) || !Number.isFinite(current.endTs) || current.endTs <= current.startTs) {
      throw new Error('Local text model returned an invalid card range')
    }
    const previous = normalized[index - 1]
    if (!previous) continue
    if (current.startTs < previous.startTs) {
      throw new Error('Local text model returned cards out of chronological order')
    }
    if (current.startTs >= previous.endTs) continue

    const overlapSeconds = previous.endTs - current.startTs
    const shorterDuration = Math.min(
      previous.endTs - previous.startTs,
      current.endTs - current.startTs
    )
    const harmlessBoundaryOverlap =
      current.startTs > previous.startTs &&
      current.endTs > previous.endTs &&
      overlapSeconds <= 5 &&
      overlapSeconds < shorterDuration
    if (!harmlessBoundaryOverlap) {
      throw new Error('Local text model returned overlapping cards')
    }
    previous.endTs = current.startTs
  }
  return normalized
}

function assertLocalCardResponseOrder(jsonText: string): void {
  let parsed: any
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return
  }
  if (!Array.isArray(parsed?.cards)) return
  let previousStart = Number.NEGATIVE_INFINITY
  for (const card of parsed.cards) {
    const start = Number(card?.startTs)
    if (!Number.isFinite(start)) continue
    if (start < previousStart) {
      throw new Error('Local text model returned cards out of chronological order')
    }
    previousStart = start
  }
}

export function buildLocalCardGenerationPrompt(
  basePrompt: string,
  opts?: {
    targetStartTs: number
    targetEndTs: number
    requiredIntervals: CoverageInterval[]
  }
): string {
  return [
    basePrompt,
    '',
    'Local task-level card rules:',
    opts ? `- Target interval: [${opts.targetStartTs}, ${opts.targetEndTs}].` : '',
    opts ? `- Evidence-backed intervals that must be covered: ${JSON.stringify(opts.requiredIntervals)}.` : '',
    '- Return cards for the target interval only. Earlier cards are read-only boundary context; do not reproduce them unless the first target activity genuinely continues one, in which case the first card may retain its original start.',
    '- Every second in the evidence-backed intervals must be covered by exactly one card. Never omit repeated or uncertain activity.',
    '- When evidence is continuous, make the cards a continuous chain with each card starting where the previous card ends.',
    '- Cards represent overarching user tasks, not individual apps, windows, screenshots, or observations.',
    '- Consolidate repeated wording and brief supporting window switches into the same continuous task.',
    '- Split only for a clear change of intent, sustained unrelated activity, or explicit idle evidence.',
    '- Prefer the fewest defensible continuous cards. If necessary, merge the most closely related adjacent tasks to stay within 12 cards.',
    '- Keep titles and summaries concise.'
  ].filter(Boolean).join('\n')
}

export function buildLocalCardRepairPrompt(opts: {
  originalPrompt: string
  candidateCards: CardGenerationCard[]
  uncoveredIntervals: CoverageInterval[]
  observations: Array<{ startTs: number; endTs: number; observation: string }>
}): string {
  const relevantObservations = opts.observations.filter((observation) =>
    opts.uncoveredIntervals.some(
      (interval) => observation.startTs < interval.endTs && observation.endTs > interval.startTs
    )
  )
  return [
    opts.originalPrompt,
    '',
    'Correction required:',
    `The previous target cards were: ${JSON.stringify(opts.candidateCards)}.`,
    `They left these evidence-backed intervals uncovered: ${JSON.stringify(opts.uncoveredIntervals)}.`,
    `Observations intersecting those intervals: ${JSON.stringify(relevantObservations)}.`,
    'Return a complete replacement cards array for the entire target interval, not only cards for the gaps.',
    'Cover every evidence-backed second, keep cards chronological and non-overlapping, and use no more than 12 cards.'
  ].join('\n')
}

export function mergeCoverageIntervals(
  intervals: Array<{ startTs: number; endTs: number }>,
  rangeStartTs: number,
  rangeEndTs: number
): CoverageInterval[] {
  const sorted = intervals
    .map((interval) => ({
      startTs: Math.max(rangeStartTs, interval.startTs),
      endTs: Math.min(rangeEndTs, interval.endTs)
    }))
    .filter((interval) => interval.endTs > interval.startTs)
    .sort((a, b) => a.startTs - b.startTs || a.endTs - b.endTs)
  const merged: CoverageInterval[] = []
  for (const interval of sorted) {
    const previous = merged.at(-1)
    if (!previous || interval.startTs > previous.endTs) {
      merged.push({ ...interval })
      continue
    }
    previous.endTs = Math.max(previous.endTs, interval.endTs)
  }
  return merged
}

export function findUncoveredEvidenceIntervals(
  requiredIntervals: CoverageInterval[],
  cards: Array<{ startTs: number; endTs: number }>,
  rangeStartTs: number,
  rangeEndTs: number
): CoverageInterval[] {
  const required = mergeCoverageIntervals(requiredIntervals, rangeStartTs, rangeEndTs)
  const covered = mergeCoverageIntervals(cards, rangeStartTs, rangeEndTs)
  const uncovered: CoverageInterval[] = []
  for (const requiredInterval of required) {
    let cursor = requiredInterval.startTs
    for (const coveredInterval of covered) {
      if (coveredInterval.endTs <= cursor) continue
      if (coveredInterval.startTs >= requiredInterval.endTs) break
      if (coveredInterval.startTs > cursor) {
        uncovered.push({
          startTs: cursor,
          endTs: Math.min(coveredInterval.startTs, requiredInterval.endTs)
        })
      }
      cursor = Math.max(cursor, coveredInterval.endTs)
      if (cursor >= requiredInterval.endTs) break
    }
    if (cursor < requiredInterval.endTs) {
      uncovered.push({ startTs: cursor, endTs: requiredInterval.endTs })
    }
  }
  return uncovered.filter((interval) => interval.endTs > interval.startTs)
}

function sumIntervalSeconds(intervals: CoverageInterval[]): number {
  return intervals.reduce(
    (total, interval) => total + Math.max(0, interval.endTs - interval.startTs),
    0
  )
}

function clipContextOnlyFrame(
  observations: LocalVisionObservation[],
  chunk: LocalVisionFrame[],
  contextFrameIndex: number | null
): LocalVisionObservation[] {
  if (contextFrameIndex === null) return observations
  const firstEvidenceFrame = chunk[1]?.index
  if (firstEvidenceFrame === undefined) return []
  return observations.flatMap((observation) => {
    if (observation.endFrame === contextFrameIndex) return []
    if (observation.startFrame !== contextFrameIndex) return [observation]
    return [{ ...observation, startFrame: firstEvidenceFrame }]
  })
}

function hasNormalCaptureCadence(
  capturedAts: number[],
  startIndex: number,
  endIndex: number,
  screenshotIntervalSeconds: number
): boolean {
  const maxNormalGap = Math.max(
    screenshotIntervalSeconds + 2,
    Math.ceil(screenshotIntervalSeconds * 1.5)
  )
  for (let index = startIndex + 1; index <= endIndex; index++) {
    const gap = capturedAts[index]! - capturedAts[index - 1]!
    if (!Number.isFinite(gap) || gap <= 0 || gap > maxNormalGap) return false
  }
  return true
}

function intervalCoverageSeconds(
  intervals: Array<{ startTs: number; endTs: number }>,
  rangeStartTs: number,
  rangeEndTs: number
): number {
  const clipped = intervals
    .map((interval) => [
      Math.max(rangeStartTs, interval.startTs),
      Math.min(rangeEndTs, interval.endTs)
    ] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let coverage = 0
  let currentStart: number | null = null
  let currentEnd: number | null = null
  for (const [start, end] of clipped) {
    if (currentStart === null || currentEnd === null) {
      currentStart = start
      currentEnd = end
      continue
    }
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end)
      continue
    }
    coverage += currentEnd - currentStart
    currentStart = start
    currentEnd = end
  }
  if (currentStart !== null && currentEnd !== null) coverage += currentEnd - currentStart
  return coverage
}

function coverageRatio(coverageSeconds: number, startTs: number, endTs: number): number {
  const duration = Math.max(0, endTs - startTs)
  return duration > 0 ? coverageSeconds / duration : 0
}

function parseLocalVisionResponse(
  text: string,
  allowedIndexes: Set<number>
): LocalVisionObservation[] {
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
    const observation = stripSyntheticFrameLabels(String(item?.observation ?? ''))
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

function buildLocalVisionPrompt(opts: {
  frameIndexes: number[]
  contextFrameIndex: number | null
  preamble?: string
}) {
  const exampleFrame = opts.frameIndexes[0] ?? 0
  return [
    'Return valid JSON only.',
    opts.preamble?.trim() ? `User instructions:\n${opts.preamble.trim()}` : '',
    'The attached storyboard panels are visibly labeled with trusted original frame IDs.',
    `Allowed frame IDs: ${opts.frameIndexes.join(', ')}.`,
    opts.contextFrameIndex === null
      ? ''
      : `FRAME_${opts.contextFrameIndex} is context-only overlap from the prior request. Do not emit an observation only for it; ranges that continue past it must start at the next supplied frame.`,
    'Return the smallest exhaustive, non-overlapping segmentation of every supplied panel.',
    'Merge adjacent panels when they show the same activity.',
    'Describe visible activity factually and use inclusive startFrame/endFrame ranges using only those IDs.',
    'The FRAME_n panel labels are synthetic Chrona markers. Never mention or describe them in observation text.',
    `Output: {"observations":[{"startFrame":${exampleFrame},"endFrame":${exampleFrame},"observation":"...","appSites":{"primary":null,"secondary":null}}]}`
  ].filter(Boolean).join('\n')
}

function stripSyntheticFrameLabels(value: string): string {
  return value
    .replace(/\bFRAME_(?:\d+|n)\b/gi, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, '')
    .trim()
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

const STANDARD_LOCAL_RUNTIMES: Array<{ runtime: LocalRuntime; baseUrl: string }> = [
  { runtime: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { runtime: 'lm_studio', baseUrl: 'http://127.0.0.1:1234/v1' }
]

function uniqueRuntimeCandidates(configuredBaseUrl: string) {
  const configured = normalizeLoopbackBaseUrl(configuredBaseUrl)
  const standard = STANDARD_LOCAL_RUNTIMES.find((candidate) => candidate.baseUrl === configured)
  const candidates: Array<{ runtime: LocalRuntime; baseUrl: string }> = [
    { runtime: standard?.runtime ?? 'compatible', baseUrl: configured },
    ...STANDARD_LOCAL_RUNTIMES
  ]
  return candidates.filter(
    (candidate, index) => candidates.findIndex((other) => other.baseUrl === candidate.baseUrl) === index
  )
}

export function selectLocalModels(
  modelIds: string[],
  existing: { visionModel?: string | null; textModel?: string | null } = {}
): { visionModel: string | null; textModel: string | null } {
  const models = Array.from(new Set(modelIds.map((id) => id.trim()).filter(Boolean)))
  const usableText = models.filter((id) => !isEmbeddingModel(id))
  const vision = usableText.filter(isVisionModel)
  const existingVision = existing.visionModel?.trim()
  const visionModel = existingVision && usableText.includes(existingVision)
    ? existingVision
    : chooseModel(vision, null, scoreVisionModel)
  const textOnly = usableText.filter((id) => !isVisionModel(id))
  const nonThinkingText = textOnly.filter((id) => !isKnownThinkingModel(id))
  const nonThinkingVision = vision.filter((id) => !isKnownThinkingModel(id))
  const textPool = nonThinkingText.length > 0
    ? nonThinkingText
    : nonThinkingVision.length > 0
      ? nonThinkingVision
      : textOnly.length > 0 ? textOnly : vision
  const existingText = existing.textModel?.trim()
  const textModel = existingText && usableText.includes(existingText)
    ? existingText
    : chooseModel(textPool, null, scoreTextModel)
  return { visionModel, textModel }
}

function chooseModel(
  candidates: string[],
  existing: string | null | undefined,
  score: (id: string) => number
) {
  const current = existing?.trim()
  if (current && candidates.includes(current)) return current
  return [...candidates].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0] ?? null
}

function isVisionModel(id: string) {
  if (/gemma[-_.]?3(?::|[-_.])1b(?:[-_.:]|$)/i.test(id)) return false
  return /(?:qwen[23](?:\.5)?[-_.]?vl|llava|llama[-_.]?3\.2[-_.]?vision|moondream|minicpm[-_.]?v|gemma[-_.]?3|granite[-_.]?3\.2[-_.]?vision|pixtral|mistral[-_.]?small[-_.]?3\.1)/i.test(id)
}

function isEmbeddingModel(id: string) {
  return /(?:embed|embedding|rerank|nomic[-_.]?embed|(?:^|[/_-])bge[-_.])/i.test(id)
}

function scoreVisionModel(id: string) {
  const variant = scoreVariant(id)
  if (/qwen3[-_.]?vl/i.test(id)) return 50 + variant
  if (/qwen2\.5[-_.]?vl/i.test(id)) return 45 + variant
  if (/gemma[-_.]?3/i.test(id)) return 40 + variant
  if (/llama[-_.]?3\.2[-_.]?vision/i.test(id)) return 35 + variant
  if (/pixtral|llava/i.test(id)) return 30 + variant
  return 10 + variant
}

function scoreTextModel(id: string) {
  const variant = scoreVariant(id)
  if (/qwen3/i.test(id)) return 40 + variant
  if (/llama|mistral|gemma/i.test(id)) return 30 + variant
  if (/instruct|chat/i.test(id)) return 20 + variant
  return 10 + variant
}

function scoreVariant(id: string) {
  if (/(?:instruct|non[-_.]?thinking|no[-_.]?think)/i.test(id)) return 100
  if (isKnownThinkingModel(id)) return -100
  return 0
}

function isKnownThinkingModel(id: string) {
  if (/(?:instruct|non[-_.]?thinking|no[-_.]?think)/i.test(id)) return false
  if (/(?:thinking|reasoning)/i.test(id)) return true
  return /(?:^|\/)qwen3(?:[-_.]?vl)?(?::(?:latest|[0-9]+b(?:[-_.][a-z0-9]+)?)|$)/i.test(id)
}

function runtimeName(runtime: LocalRuntime) {
  if (runtime === 'ollama') return 'Ollama'
  if (runtime === 'lm_studio') return 'LM Studio'
  return 'Local AI server'
}
