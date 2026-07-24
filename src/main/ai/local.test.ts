import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LocalAIService,
  buildLocalCardGenerationPrompt,
  buildOverlappingChunks,
  expandSampledFrameRange,
  isContextLengthError,
  mergeBoundaryObservations,
  selectLocalModels,
  splitOverlappingChunk,
  validateLocalGeneratedCards
} from './local'
import { LocalRuntimeUnavailableError } from './errors'

vi.mock('./localKeychain', () => ({ getLocalBearerToken: async () => null }))

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('local AI helpers', () => {
  it('chunks every frame with one-frame boundary overlap', () => {
    const chunks = buildOverlappingChunks(Array.from({ length: 27 }, (_, index) => index), 12)
    expect(chunks.map((chunk) => [chunk[0], chunk.at(-1)])).toEqual([
      [0, 11],
      [11, 22],
      [22, 26]
    ])
    expect(new Set(chunks.flat())).toEqual(new Set(Array.from({ length: 27 }, (_, index) => index)))
    expect(buildOverlappingChunks(Array.from({ length: 48 }, (_, index) => index), 12)).toHaveLength(5)
  })

  it('splits context-heavy chunks into smaller overlapping chunks', () => {
    expect(splitOverlappingChunk([0, 1, 2, 3, 4, 5])).toEqual([
      [0, 1, 2, 3],
      [3, 4, 5]
    ])
    expect(isContextLengthError(new Error('prompt exceeds the context window'))).toBe(true)
    expect(isContextLengthError(new Error('connection failed'))).toBe(false)
  })

  it('deduplicates and merges identical boundary observations', () => {
    expect(
      mergeBoundaryObservations([
        { startTs: 20, endTs: 30, observation: 'Writing', llmModel: 'vision' },
        { startTs: 10, endTs: 21, observation: 'Writing', llmModel: 'vision' },
        { startTs: 40, endTs: 50, observation: 'Reading', llmModel: 'vision' }
      ])
    ).toEqual([
      { startTs: 10, endTs: 30, observation: 'Writing', llmModel: 'vision' },
      { startTs: 40, endTs: 50, observation: 'Reading', llmModel: 'vision' }
    ])
  })

  it('expands sampled evidence to midpoints without crossing real capture gaps', () => {
    const common = {
      sampledFrameIndexes: [0, 3, 4, 5],
      capturedAts: [100, 110, 120, 130, 300, 310],
      batchStartTs: 100,
      batchEndTs: 310,
      screenshotIntervalSeconds: 10
    }
    expect(expandSampledFrameRange({ ...common, startFrameIndex: 3, endFrameIndex: 3 }))
      .toEqual([{ startTs: 115, endTs: 140 }])
    expect(expandSampledFrameRange({ ...common, startFrameIndex: 4, endFrameIndex: 4 }))
      .toEqual([{ startTs: 300, endTs: 305 }])
    expect(expandSampledFrameRange({ ...common, startFrameIndex: 0, endFrameIndex: 4 }))
      .toEqual([
        { startTs: 100, endTs: 140 },
        { startTs: 300, endTs: 305 }
      ])
  })

  it('gives exhaustive sampled panels adjacent midpoint-bounded coverage', () => {
    const common = {
      sampledFrameIndexes: [0, 3, 6],
      capturedAts: [100, 110, 120, 130, 140, 150, 160],
      batchStartTs: 100,
      batchEndTs: 160,
      screenshotIntervalSeconds: 10
    }
    expect([
      ...expandSampledFrameRange({ ...common, startFrameIndex: 0, endFrameIndex: 0 }),
      ...expandSampledFrameRange({ ...common, startFrameIndex: 3, endFrameIndex: 3 }),
      ...expandSampledFrameRange({ ...common, startFrameIndex: 6, endFrameIndex: 6 })
    ]).toEqual([
      { startTs: 100, endTs: 115 },
      { startTs: 115, endTs: 145 },
      { startTs: 145, endTs: 160 }
    ])
  })

  it('clips harmless local card boundaries and rejects invalid card sequences', () => {
    const cards: any[] = [
      { startTs: 100, endTs: 201, category: 'Work', title: 'Build' },
      { startTs: 200, endTs: 300, category: 'Work', title: 'Test' }
    ]
    expect(validateLocalGeneratedCards(cards)).toEqual([
      expect.objectContaining({ startTs: 100, endTs: 200 }),
      expect.objectContaining({ startTs: 200, endTs: 300 })
    ])
    expect(() => validateLocalGeneratedCards([...cards].reverse())).toThrow('chronological order')
    expect(() => validateLocalGeneratedCards([
      { ...cards[0], endTs: 290 },
      cards[1]
    ])).toThrow('overlapping cards')
    expect(() => validateLocalGeneratedCards(Array.from({ length: 13 }, (_, index) => ({
      startTs: index * 10,
      endTs: index * 10 + 5,
      category: 'Work',
      title: 'Task'
    })))).toThrow('more than 12 cards')
    expect(buildLocalCardGenerationPrompt('base')).toContain('overarching user tasks')
  })

  it('automatically chooses vision and text models while ignoring embedding models', () => {
    expect(selectLocalModels([
      'nomic-embed-text:latest',
      'qwen3:4b',
      'qwen3-vl:4b',
      'llava:7b'
    ])).toEqual({
      visionModel: 'llava:7b',
      textModel: 'llava:7b'
    })
    expect(selectLocalModels(['qwen3-vl:4b'])).toEqual({
      visionModel: 'qwen3-vl:4b',
      textModel: 'qwen3-vl:4b'
    })
    expect(selectLocalModels(['gemma3:1b'])).toEqual({
      visionModel: null,
      textModel: 'gemma3:1b'
    })
  })

  it('prefers non-thinking instruct variants and preserves explicit custom selections', () => {
    expect(selectLocalModels([
      'qwen3-vl:4b',
      'qwen3-vl:4b-instruct',
      'qwen3:4b',
      'qwen3:4b-instruct'
    ])).toEqual({
      visionModel: 'qwen3-vl:4b-instruct',
      textModel: 'qwen3:4b-instruct'
    })
    expect(selectLocalModels(['qwen3-vl:4b-instruct'])).toEqual({
      visionModel: 'qwen3-vl:4b-instruct',
      textModel: 'qwen3-vl:4b-instruct'
    })
    expect(selectLocalModels(['my-custom-model'], {
      visionModel: 'my-custom-model',
      textModel: 'my-custom-model'
    })).toEqual({
      visionModel: 'my-custom-model',
      textModel: 'my-custom-model'
    })
  })
})

describe('LocalAIService OpenAI compatibility', () => {
  it('detects LM Studio on its standard port and saves selected models automatically', async () => {
    const { service, settingUpdates } = makeService({ localVisionModel: '', localTextModel: '' })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.startsWith('http://127.0.0.1:1234/')) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 'qwen/qwen3-vl-4b' }, { id: 'qwen/qwen3-4b' }]
        })))
      }
      return Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
    }))

    await expect(service.autoConfigure()).resolves.toMatchObject({
      status: 'ready',
      runtime: 'lm_studio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      visionModel: 'qwen/qwen3-vl-4b',
      textModel: 'qwen/qwen3-4b'
    })
    expect(settingUpdates.at(-1)).toMatchObject({
      aiProvider: 'local',
      localBaseUrl: 'http://127.0.0.1:1234/v1',
      localVisionModel: 'qwen/qwen3-vl-4b',
      localTextModel: 'qwen/qwen3-4b'
    })
  })

  it('guides the user when a running local server lacks a vision model', async () => {
    const { service } = makeService({ localVisionModel: '', localTextModel: '' })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.startsWith('http://127.0.0.1:11434/')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'llama3.2:3b' }] })))
      }
      return Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
    }))

    await expect(service.autoConfigure()).resolves.toMatchObject({
      status: 'needs_vision_model',
      runtime: 'ollama',
      textModel: 'llama3.2:3b',
      visionModel: null,
      recommendedCommand: 'ollama pull qwen3-vl:4b-instruct'
    })
  })

  it('warns without downloading when explicitly selected models are known thinking aliases', async () => {
    const { service } = makeService({
      localVisionModel: 'qwen3-vl:4b',
      localTextModel: 'qwen3:4b'
    })
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url.startsWith('http://127.0.0.1:11434/')) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 'qwen3-vl:4b' }, { id: 'qwen3:4b' }]
        })))
      }
      return Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.autoConfigure()).resolves.toMatchObject({
      status: 'ready',
      visionModel: 'qwen3-vl:4b',
      textModel: 'qwen3:4b',
      message: expect.stringContaining('thinking'),
      recommendedCommand: 'ollama pull qwen3-vl:4b-instruct'
    })
    expect(fetchMock.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true)
  })

  it('discovers models with optional auth and rejects redirects', async () => {
    const { service } = makeService()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'vision' }, { id: 'text' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'http://example.com' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.discoverModels({ token: 'secret' })).resolves.toEqual([
      { id: 'text' },
      { id: 'vision' }
    ])
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:11434/v1/models')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: 'manual',
      headers: { authorization: 'Bearer secret' }
    })
    await expect(service.discoverModels({ token: 'secret' })).rejects.toThrow('redirects are not allowed')
  })

  it('sends a non-streaming JSON-schema chat request and records the selected model', async () => {
    const { service, calls } = makeService()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.generateJsonOnly({
      operation: 'ask',
      callGroupId: 'ask:1',
      prompt: 'Return JSON',
      mockJson: '{}',
      responseJsonSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok']
      }
    })

    expect(result).toEqual({ text: '{"ok":true}', provider: 'local', model: 'text-model' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      model: 'text-model',
      stream: false,
      response_format: { type: 'json_schema', json_schema: { strict: false } }
    })
    expect(calls[0]).toMatchObject({ provider: 'local', model: 'text-model', operation: 'ask' })
  })

  it('retries connection failures and reports a resumable availability error', async () => {
    const { service } = makeService({ localMaxAttempts: 2 })
    const refused = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    const fetchMock = vi.fn().mockRejectedValue(refused)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      service.generateJsonOnly({ operation: 'ask', callGroupId: 'ask:2', prompt: 'x', mockJson: '{}' })
    ).rejects.toBeInstanceOf(LocalRuntimeUnavailableError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('aborts timed-out requests as a resumable availability error', async () => {
    vi.useFakeTimers()
    const { service } = makeService({ localRequestTimeoutMs: 1_000 })
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      )
    )
    const request = service.generateJsonOnly({
      operation: 'ask',
      callGroupId: 'ask:timeout',
      prompt: 'x',
      mockJson: '{}'
    })
    const assertion = expect(request).rejects.toMatchObject({
      name: 'LocalRuntimeUnavailableError',
      message: 'Local server timed out after 1000ms'
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('uses task-level local card instructions, a 12-card schema cap, and clips boundary overlap', async () => {
    const { service, log } = makeService()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ cards: [
        { startTs: 100, endTs: 201, category: 'Work', title: 'Implement', summary: 'Code changes' },
        { startTs: 200, endTs: 300, category: 'Work', title: 'Verify', summary: 'Tests' }
      ] }) } }]
    })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.generateCards({
      batchId: 3,
      windowStartTs: 100,
      windowEndTs: 300,
      observations: [{ startTs: 100, endTs: 300, observation: 'Development work' }],
      contextCards: []
    })).resolves.toEqual({ cards: [
      expect.objectContaining({ startTs: 100, endTs: 200, title: 'Implement' }),
      expect.objectContaining({ startTs: 200, endTs: 300, title: 'Verify' })
    ] })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.messages[0].content).toContain('overarching user tasks')
    expect(body.messages[0].content).toContain('fewest defensible continuous cards')
    expect(body.response_format.json_schema.schema.properties.cards.maxItems).toBe(12)
    expect(log.info).toHaveBeenCalledWith('localAI.batchTiming', expect.objectContaining({
      batchId: 3,
      phase: 'complete',
      cardCount: 2,
      cardCoverageSeconds: 200,
      cardCoverageRatio: 1
    }))
  })

  it('maps trusted frame indexes to capture timestamps and never logs image base64', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-local-ai-'))
    temporaryDirectories.push(directory)
    await Promise.all(
      [0, 1, 2].map((index) =>
        sharp({ create: { width: 20, height: 20, channels: 3, background: { r: index * 100, g: 2, b: 3 } } })
          .jpeg()
          .toFile(path.join(directory, `${index}.jpg`))
      )
    )
    const inserted: any[] = []
    const { service, calls } = makeService(
      { localLogBodies: true },
      {
        resolveRelPath: (relativePath: string) => path.join(directory, relativePath),
        insertObservations: async (_batchId: number, observations: any[]) => inserted.push(...observations)
      }
    )
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ observations: [
              { startFrame: 0, endFrame: 1, observation: 'FRAME_0 FRAME_n Editing', appSites: null }
            ] }) } }]
          }),
          { status: 200 }
        )
      )
    )

    await service.transcribeBatch({
      batchId: 4,
      batchStartTs: 100,
      batchEndTs: 130,
      screenshots: [0, 1, 2].map((index) => ({ filePath: `${index}.jpg`, capturedAt: 100 + index * 10 })),
      screenshotIntervalSeconds: 10
    })

    expect(inserted).toEqual([
      expect.objectContaining({ startTs: 100, endTs: 115, observation: 'Editing', llmModel: 'vision-model' })
    ])
    const requestLog = calls.find((call) => call.operation === 'transcribe' && call.requestBody)
    expect(requestLog?.requestBody).toContain('[image omitted]')
    expect(requestLog?.requestBody).not.toContain('base64')
  })

  it('sends no more than 12 represented frames and three storyboards with boundary overlap', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-local-ai-'))
    temporaryDirectories.push(directory)
    await Promise.all(
      Array.from({ length: 13 }, (_, index) =>
        sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } })
          .jpeg()
          .toFile(path.join(directory, `${index}.jpg`))
      )
    )
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        observations: [{ startFrame: 0, endFrame: 11, observation: 'Editing', appSites: null }]
      }) } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        observations: [{ startFrame: 11, endFrame: 11, observation: 'FRAME_11 Editing', appSites: null }]
      }) } }] })))
    vi.stubGlobal('fetch', fetchMock)
    const insertObservations = vi.fn(async (_batchId: number, _observations: any[]) => undefined)
    const { service, log } = makeService(
      { localVisionMaxImagesPerRequest: 64 },
      {
        resolveRelPath: (relativePath: string) => path.join(directory, relativePath),
        insertObservations
      }
    )

    await service.transcribeBatch({
      batchId: 7,
      batchStartTs: 60,
      batchEndTs: 60 + 13 * 60,
      screenshots: Array.from({ length: 13 }, (_, index) => ({
        filePath: `${index}.jpg`,
        capturedAt: 60 + index * 60
      })),
      screenshotIntervalSeconds: 10
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1].body)))
    const content = bodies.map((body) => body.messages[0].content)
    expect(content.map((parts) => parts.filter((part: any) => part.type === 'image_url').length)).toEqual([3, 1])
    expect(content[0][0].text).toContain('Allowed frame IDs: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11')
    expect(content[0][0].text).toContain('smallest exhaustive, non-overlapping segmentation')
    expect(content[0][0].text).toContain('Never mention or describe them')
    expect(content[1][0].text).toContain('Allowed frame IDs: 11, 12')
    expect(content[1][0].text).toContain('context-only overlap')
    expect(insertObservations).toHaveBeenCalledTimes(1)
    expect(insertObservations.mock.calls[0][1]).toHaveLength(12)
    expect(insertObservations.mock.calls[0][1][0]).toEqual(
      expect.objectContaining({ startTs: 60, endTs: 70, observation: 'Editing' })
    )
    expect(insertObservations.mock.calls[0][1].at(-1)).toEqual(
      expect.objectContaining({ startTs: 720, endTs: 730, observation: 'Editing' })
    )
    expect(log.info).toHaveBeenCalledWith('localAI.batchTiming', expect.objectContaining({
      batchId: 7,
      originalFrameCount: 13,
      selectedFrameBudget: 13,
      sampledFrameCount: 13,
      storyboardCount: 4,
      requestCount: 2,
      observationCount: 12,
      observationCoverageSeconds: 120
    }))
  })

  it('inserts no observations when a later chunk is malformed', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-local-ai-'))
    temporaryDirectories.push(directory)
    await Promise.all(
      [0, 1, 2, 3, 4, 5].map((index) =>
        sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } })
          .jpeg()
          .toFile(path.join(directory, `${index}.jpg`))
      )
    )
    const insertObservations = vi.fn()
    const { service } = makeService(
      { localVisionMaxImagesPerRequest: 2 },
      { resolveRelPath: (relativePath: string) => path.join(directory, relativePath), insertObservations }
    )
    const valid = JSON.stringify({ choices: [{ message: { content: '{"observations":[]}' } }] })
    const malformed = JSON.stringify({ choices: [{ message: { content: 'not-json' } }] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(valid)).mockResolvedValueOnce(new Response(malformed)))

    await expect(
      service.transcribeBatch({
        batchId: 5,
        batchStartTs: 100,
        batchEndTs: 130,
        screenshots: [0, 1, 2, 3, 4, 5].map((index) => ({ filePath: `${index}.jpg`, capturedAt: 100 + index * 60 })),
        screenshotIntervalSeconds: 10
      })
    ).rejects.toThrow('invalid JSON')
    expect(insertObservations).not.toHaveBeenCalled()
  })

  it('splits only a chunk rejected for context length and inserts once after all retries succeed', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-local-ai-'))
    temporaryDirectories.push(directory)
    await Promise.all(
      [0, 1, 2, 3, 4, 5].map((index) =>
        sharp({ create: { width: 8, height: 8, channels: 3, background: { r: index * 20, g: 0, b: 0 } } })
          .jpeg()
          .toFile(path.join(directory, `${index}.jpg`))
      )
    )
    const insertObservations = vi.fn()
    const { service } = makeService(
      { localVisionMaxImagesPerRequest: 6 },
      { resolveRelPath: (relativePath: string) => path.join(directory, relativePath), insertObservations }
    )
    const valid = JSON.stringify({ choices: [{ message: { content: '{"observations":[]}' } }] })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"context length exceeded"}', { status: 400 }))
      .mockResolvedValueOnce(new Response(valid))
      .mockResolvedValueOnce(new Response(valid)))

    await expect(service.transcribeBatch({
      batchId: 6,
      batchStartTs: 100,
      batchEndTs: 500,
      screenshots: [0, 1, 2, 3, 4, 5].map((index) => ({
        filePath: `${index}.jpg`,
        capturedAt: 100 + index * 60
      })),
      screenshotIntervalSeconds: 10
    })).resolves.toEqual({ observationsInserted: 0 })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(insertObservations).toHaveBeenCalledTimes(1)
  })
})

function makeService(settingsOverrides: Record<string, unknown> = {}, storageOverrides: Record<string, unknown> = {}) {
  const calls: any[] = []
  const settingUpdates: Array<Record<string, unknown>> = []
  const settings = {
    localBaseUrl: 'http://127.0.0.1:11434/v1',
    localVisionModel: 'vision-model',
    localTextModel: 'text-model',
    localRequestTimeoutMs: 5_000,
    localMaxAttempts: 1,
    localLogBodies: false,
    localVisionMaxImagesPerRequest: 12,
    promptPreambleTranscribe: '',
    categories: [],
    subcategories: [],
    promptPreambleCards: '',
    ...settingsOverrides
  }
  const storage = {
    insertLLMCall: async (call: any) => {
      calls.push(call)
      return calls.length
    },
    resolveRelPath: (relativePath: string) => relativePath,
    insertObservations: async () => undefined,
    ...storageOverrides
  }
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const service = new LocalAIService({
    settings: {
      getAll: async () => settings,
      update: async (patch: Record<string, unknown>) => {
        settingUpdates.push(patch)
        Object.assign(settings, patch)
        return settings
      }
    } as any,
    storage: storage as any,
    log: log as any
  })
  return { service, calls, storage, settingUpdates, log }
}
