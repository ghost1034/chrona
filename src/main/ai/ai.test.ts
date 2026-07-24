import { describe, expect, it, vi } from 'vitest'
import { AIService } from './ai'

describe('AIService provider routing', () => {
  it('routes each new operation to the currently selected provider', async () => {
    let provider: 'gemini' | 'local' = 'gemini'
    const service = new AIService({
      settings: {
        getAll: async () => ({ aiProvider: provider, geminiModel: 'gemini-model' })
      } as any,
      storage: {} as any,
      log: {} as any
    })
    const geminiTranscribe = vi.fn(async () => ({ observationsInserted: 1 }))
    const localTranscribe = vi.fn(async () => ({ observationsInserted: 2 }))
    service.gemini.transcribeBatch = geminiTranscribe as any
    service.local.transcribeBatch = localTranscribe as any
    const request = {
      batchId: 1,
      batchStartTs: 10,
      batchEndTs: 20,
      screenshots: [{ filePath: 'one.jpg', capturedAt: 10 }],
      screenshotIntervalSeconds: 10
    }

    await expect(service.transcribeBatch(request)).resolves.toEqual({ observationsInserted: 1 })
    expect(geminiTranscribe).toHaveBeenCalledWith(
      expect.objectContaining({ screenshotRelPaths: ['one.jpg'] })
    )

    provider = 'local'
    await expect(service.transcribeBatch(request)).resolves.toEqual({ observationsInserted: 2 })
    expect(localTranscribe).toHaveBeenCalledWith(request)
  })

  it('returns provider and actual text-model audit metadata', async () => {
    let provider: 'gemini' | 'local' = 'gemini'
    const service = new AIService({
      settings: {
        getAll: async () => ({ aiProvider: provider, geminiModel: 'gemini-model' })
      } as any,
      storage: {} as any,
      log: {} as any
    })
    service.gemini.generateJsonOnly = vi.fn(async () => '{"provider":"gemini"}') as any
    service.local.generateJsonOnly = vi.fn(async () => ({
      text: '{"provider":"local"}',
      provider: 'local',
      model: 'local-text'
    })) as any
    const request = { operation: 'ask', callGroupId: 'ask:1', prompt: 'x', mockJson: '{}' }

    await expect(service.generateJsonOnly(request)).resolves.toEqual({
      text: '{"provider":"gemini"}',
      provider: 'gemini',
      model: 'gemini-model'
    })
    provider = 'local'
    await expect(service.generateJsonOnly(request)).resolves.toEqual({
      text: '{"provider":"local"}',
      provider: 'local',
      model: 'local-text'
    })
  })
})
