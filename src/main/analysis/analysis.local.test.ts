import { describe, expect, it, vi } from 'vitest'
import { LocalRuntimeUnavailableError } from '../ai/errors'
import { AnalysisService } from './analysis'

function makeService(storageOverrides: Record<string, unknown> = {}) {
  const storage: any = {
    recoverInterruptedAnalysisBatches: vi.fn(async () => ({
      pendingBatchIds: [],
      transcribedBatchIds: []
    })),
    claimNextAnalysisBatch: vi.fn(async () => null),
    setBatchStatus: vi.fn(async () => undefined),
    getBatchScreenshots: vi.fn(async () => []),
    ...storageOverrides
  }
  const events = { analysisBatchUpdated: vi.fn(), timelineUpdated: vi.fn() }
  const service = new AnalysisService({
    storage,
    settings: { getAll: async () => ({ captureIntervalSeconds: 10 }) } as any,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    events,
    timelapse: { deleteTimelapseFiles: vi.fn(), enqueueCardIds: vi.fn() } as any
  })
  return { service, storage, events }
}

describe('AnalysisService batch draining', () => {
  it('restores only the claimed processing batch when the local runtime is unavailable', async () => {
    const replaceCardsInRange = vi.fn()
    const { service, storage, events } = makeService({
      claimNextAnalysisBatch: vi.fn()
        .mockResolvedValueOnce({
          batch: {
            id: 8,
            batchStartTs: 100,
            batchEndTs: 200,
            status: 'processing_transcribe',
            reason: null,
            createdAt: ''
          },
          resumeStatus: 'pending'
        }),
      getBatchScreenshots: async () => [
        { id: 1, capturedAt: 100, filePath: 'one.jpg', fileSize: 1, isDeleted: 0 }
      ],
      replaceCardsInRange
    })
    ;(service as any).ai = {
      getProviderStatus: async () => ({ configured: true, provider: 'local' }),
      transcribeBatch: async () => {
        throw new LocalRuntimeUnavailableError('Could not connect to the local AI server')
      }
    }

    await (service as any).drainPendingBatches()

    expect(storage.setBatchStatus).toHaveBeenCalledTimes(1)
    expect(storage.setBatchStatus).toHaveBeenCalledWith(expect.objectContaining({
      batchId: 8,
      status: 'pending',
      reason: expect.stringMatching(/Could not connect/)
    }))
    expect(replaceCardsInRange).not.toHaveBeenCalled()
    expect(events.analysisBatchUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ batchId: 8, status: 'pending' })
    )
  })

  it('runs concurrent startup drains as one flight and processes batches serially', async () => {
    const claims = [1, 2].map((id) => ({
      batch: {
        id,
        batchStartTs: id * 100,
        batchEndTs: id * 100 + 50,
        status: 'processing_transcribe',
        reason: null,
        createdAt: ''
      },
      resumeStatus: 'pending' as const
    }))
    const { service, storage } = makeService({
      claimNextAnalysisBatch: vi.fn(async () => claims.shift() ?? null),
      getBatchScreenshots: vi.fn(async (batchId: number) => [
        { id: batchId, capturedAt: batchId * 100, filePath: `${batchId}.jpg`, fileSize: 1, isDeleted: 0 }
      ])
    })
    let active = 0
    let maximumActive = 0
    const getProviderStatus = vi.fn(async () => ({ configured: true, provider: 'local' }))
    const transcribeBatch = vi.fn(async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      return { observationsInserted: 0 }
    })
    ;(service as any).ai = { getProviderStatus, transcribeBatch }

    await Promise.all([
      (service as any).drainPendingBatches(),
      (service as any).drainPendingBatches()
    ])

    expect(getProviderStatus).toHaveBeenCalledTimes(1)
    expect(storage.recoverInterruptedAnalysisBatches).toHaveBeenCalledTimes(1)
    expect(transcribeBatch).toHaveBeenCalledTimes(2)
    expect(maximumActive).toBe(1)
    expect(storage.setBatchStatus.mock.calls.map(([entry]: any[]) => [entry.batchId, entry.status]))
      .toEqual([[1, 'analyzed'], [2, 'analyzed']])
  })

  it('attributes a forced failure solely to its claimed batch', async () => {
    const secondClaim = {
      batch: {
        id: 2, batchStartTs: 200, batchEndTs: 300,
        status: 'processing_transcribe', reason: null, createdAt: ''
      },
      resumeStatus: 'pending' as const
    }
    const claimNextAnalysisBatch = vi.fn()
      .mockResolvedValueOnce({
        batch: {
          id: 1, batchStartTs: 100, batchEndTs: 200,
          status: 'processing_transcribe', reason: null, createdAt: ''
        },
        resumeStatus: 'pending'
      })
      .mockResolvedValueOnce(secondClaim)
    const { service, storage } = makeService({
      claimNextAnalysisBatch,
      getBatchScreenshots: vi.fn(async () => [
        { id: 1, capturedAt: 100, filePath: 'one.jpg', fileSize: 1, isDeleted: 0 }
      ]),
      getBatch: vi.fn(async (batchId: number) => batchId === 1
        ? { id: 1, batchStartTs: 100, batchEndTs: 200 }
        : null),
      replaceCardsInRange: vi.fn(async () => ({
        insertedCardIds: [10], trimmedCardIds: [], removedVideoPaths: []
      }))
    })
    ;(service as any).ai = {
      getProviderStatus: async () => ({ configured: true, provider: 'local' }),
      transcribeBatch: async () => { throw new Error('forced parse failure') }
    }

    await (service as any).drainPendingBatches()

    expect(storage.setBatchStatus).toHaveBeenCalledWith({
      batchId: 1, status: 'failed', reason: 'forced parse failure'
    })
    expect(storage.setBatchStatus.mock.calls.some(([entry]: any[]) => entry.batchId === 2)).toBe(false)
    expect(claimNextAnalysisBatch).toHaveBeenCalledTimes(1)
  })

  it('recovers both interrupted phases before provider discovery on the first drain only', async () => {
    const order: string[] = []
    const { service, storage, events } = makeService({
      recoverInterruptedAnalysisBatches: vi.fn(async () => {
        order.push('recover')
        return { pendingBatchIds: [4], transcribedBatchIds: [7] }
      })
    })
    const getProviderStatus = vi.fn(async () => {
      order.push('provider')
      return { configured: false, provider: 'local' }
    })
    ;(service as any).ai = { getProviderStatus }

    await (service as any).drainPendingBatches()
    await (service as any).drainPendingBatches()

    expect(order).toEqual(['recover', 'provider', 'provider'])
    expect(storage.recoverInterruptedAnalysisBatches).toHaveBeenCalledTimes(1)
    expect(events.analysisBatchUpdated).toHaveBeenCalledWith({ batchId: 4, status: 'pending', reason: null })
    expect(events.analysisBatchUpdated).toHaveBeenCalledWith({ batchId: 7, status: 'transcribed', reason: null })
  })
})
