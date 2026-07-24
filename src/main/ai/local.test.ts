import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalAIService, buildOverlappingChunks, mergeBoundaryObservations } from './local'
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
})

describe('LocalAIService OpenAI compatibility', () => {
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

  it('maps trusted frame indexes to capture timestamps and never logs image base64', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-local-ai-'))
    temporaryDirectories.push(directory)
    await Promise.all(
      [0, 1, 2].map((index) =>
        sharp({ create: { width: 20, height: 20, channels: 3, background: { r: index, g: 2, b: 3 } } })
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
              { startFrame: 0, endFrame: 1, observation: 'Editing', appSites: null }
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
      expect.objectContaining({ startTs: 100, endTs: 120, observation: 'Editing', llmModel: 'vision-model' })
    ])
    const requestLog = calls.find((call) => call.operation === 'transcribe' && call.requestBody)
    expect(requestLog?.requestBody).toContain('[image omitted]')
    expect(requestLog?.requestBody).not.toContain('base64')
  })

  it('inserts no observations when a later chunk is malformed', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-local-ai-'))
    temporaryDirectories.push(directory)
    await Promise.all(
      [0, 1, 2].map((index) =>
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
        screenshots: [0, 1, 2].map((index) => ({ filePath: `${index}.jpg`, capturedAt: 100 + index * 10 })),
        screenshotIntervalSeconds: 10
      })
    ).rejects.toThrow('invalid JSON')
    expect(insertObservations).not.toHaveBeenCalled()
  })
})

function makeService(settingsOverrides: Record<string, unknown> = {}, storageOverrides: Record<string, unknown> = {}) {
  const calls: any[] = []
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
  const service = new LocalAIService({
    settings: { getAll: async () => settings } as any,
    storage: storage as any,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any
  })
  return { service, calls, storage }
}
