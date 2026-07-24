import type { Logger } from '../logger'
import type { SettingsStore } from '../settings'
import type { StorageService } from '../storage/storage'
import { GeminiService } from '../gemini/gemini'
import type { JsonSchema } from '../gemini/schemas'
import { getGeminiApiKey } from '../gemini/keychain'
import { getLocalBearerToken } from './localKeychain'
import { LocalAIService } from './local'

export type AIProvider = 'gemini' | 'local'
export type AIGenerationResult = { text: string; provider: AIProvider; model: string }

export class AIService {
  readonly gemini: GeminiService
  readonly local: LocalAIService

  constructor(
    private readonly opts: {
      storage: StorageService
      log: Logger
      settings: SettingsStore
    }
  ) {
    this.gemini = new GeminiService(opts)
    this.local = new LocalAIService(opts)
  }

  async getProviderStatus() {
    const settings = await this.opts.settings.getAll()
    const hasGeminiKey = !!(await getGeminiApiKey())
    const hasLocalToken = !!(await getLocalBearerToken())
    const configured = settings.aiProvider === 'gemini'
      ? hasGeminiKey || !!process.env.CHRONA_GEMINI_MOCK
      : !!settings.localBaseUrl && !!settings.localVisionModel && !!settings.localTextModel
    return {
      provider: settings.aiProvider,
      configured,
      hasGeminiKey,
      hasLocalToken,
      localBaseUrl: settings.localBaseUrl,
      localVisionModel: settings.localVisionModel,
      localTextModel: settings.localTextModel
    }
  }

  async transcribeBatch(opts: {
    batchId: number
    batchStartTs: number
    batchEndTs: number
    screenshots: Array<{ filePath: string; capturedAt: number }>
    screenshotIntervalSeconds: number
  }) {
    const provider = (await this.opts.settings.getAll()).aiProvider
    if (provider === 'local') return this.local.transcribeBatch(opts)
    return this.gemini.transcribeBatch({
      ...opts,
      screenshotRelPaths: opts.screenshots.map((screen) => screen.filePath)
    })
  }

  async generateCards(opts: Parameters<GeminiService['generateCards']>[0]) {
    const provider = (await this.opts.settings.getAll()).aiProvider
    return provider === 'local' ? this.local.generateCards(opts) : this.gemini.generateCards(opts)
  }

  async generateJsonOnly(opts: {
    operation: string
    callGroupId: string
    prompt: string
    batchId?: number | null
    mockJson: string
    responseJsonSchema?: JsonSchema | null
  }): Promise<AIGenerationResult> {
    const settings = await this.opts.settings.getAll()
    if (settings.aiProvider === 'local') return this.local.generateJsonOnly(opts)
    return {
      text: await this.gemini.generateJsonOnly(opts),
      provider: 'gemini',
      model: process.env.CHRONA_GEMINI_MOCK ? 'mock' : settings.geminiModel
    }
  }
}
